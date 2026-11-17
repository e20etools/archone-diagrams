-- ArchONE Diagrams, phase 4: more integrations, and AI with a workspace's own key.
--
--  * The services a workspace can connect to are listed once, in integration_providers().
--  * ai_integration tells any member which AI provider and model the workspace uses, never the key.
--  * An AI request with the workspace's own key goes through the integrations Edge Function. It
--    needs a ticket: a request already counted by ai_begin, by the same person, not yet used and
--    less than five minutes old. ai_ticket_use spends it, so the fair-use limits hold for it too.

create function public.integration_providers() returns text[]
language sql immutable set search_path = ''
as $$ select array['ai', 'aws', 'azure', 'gcp', 'servicenow', 'bmc', 'device42', 'apm', 'github', 'entra', 'okta', 'teams', 'slack', 'email', 'jira', 'azure-devops', 'confluence'] $$;

alter table public.integrations drop constraint integrations_provider_check;
alter table public.integrations add constraint integrations_provider_check check (provider = any (public.integration_providers()));

create or replace function public.integration_save(p_workspace uuid, p_provider text, p_settings jsonb, p_secrets jsonb, p_enabled boolean default true) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_root uuid := public.ai_root(p_workspace);
  v_row public.integrations;
  v_kept jsonb := '{}';
  v_entry record;
  v_secret_id uuid;
begin
  if v_root is null or not public.is_owner(v_root) then
    raise exception 'Only an owner can change integrations' using errcode = '42501';
  end if;
  if p_provider is null or not (p_provider = any (public.integration_providers())) then
    raise exception 'Unknown integration' using errcode = '22023';
  end if;
  p_settings := coalesce(p_settings, '{}');
  p_secrets := coalesce(p_secrets, '{}');
  if jsonb_typeof(p_settings) <> 'object' or jsonb_typeof(p_secrets) <> 'object'
     or exists (select 1 from jsonb_each(p_settings) e where jsonb_typeof(e.value) <> 'string' or length(e.value #>> '{}') > 4000 or length(e.key) > 40)
     or exists (select 1 from jsonb_each(p_secrets) e where jsonb_typeof(e.value) not in ('string', 'null') or length(coalesce(e.value #>> '{}', '')) > 20000 or length(e.key) > 40) then
    raise exception 'The settings are not valid' using errcode = '22023';
  end if;

  select * into v_row from public.integrations where workspace_id = v_root and provider = p_provider for update;
  if v_row.secret_id is not null then
    select coalesce(d.decrypted_secret::jsonb, '{}') into v_kept from vault.decrypted_secrets d where d.id = v_row.secret_id;
    v_kept := coalesce(v_kept, '{}');
  end if;
  -- An empty value keeps the secret already kept; null removes it.
  for v_entry in select key, value from jsonb_each(p_secrets) loop
    if jsonb_typeof(v_entry.value) = 'null' then
      v_kept := v_kept - v_entry.key;
    elsif (v_entry.value #>> '{}') <> '' then
      v_kept := v_kept || jsonb_build_object(v_entry.key, v_entry.value);
    end if;
  end loop;

  v_secret_id := v_row.secret_id;
  if v_secret_id is null and v_kept <> '{}'::jsonb then
    v_secret_id := vault.create_secret(v_kept::text, 'archone-integration-' || v_root::text || '-' || p_provider, 'ArchONE integration credentials');
  elsif v_secret_id is not null then
    perform vault.update_secret(v_secret_id, v_kept::text);
  end if;

  insert into public.integrations as i (workspace_id, provider, enabled, settings, secret_fields, secret_id, changed_by)
  values (v_root, p_provider, coalesce(p_enabled, true), p_settings, array(select jsonb_object_keys(v_kept) order by 1), v_secret_id, auth.uid())
  on conflict (workspace_id, provider) do update
    set enabled = excluded.enabled, settings = excluded.settings, secret_fields = excluded.secret_fields, secret_id = excluded.secret_id,
        status = 'untested', status_message = '', checked_at = null, changed_at = now(), changed_by = auth.uid();

  perform public.audit_write(v_root, 'workspace', v_root::text, 'Integration: ' || p_provider, 'Integration changed',
    jsonb_build_object('provider', p_provider, 'enabled', coalesce(p_enabled, true), 'settings', p_settings, 'secretFields', to_jsonb(array(select jsonb_object_keys(v_kept) order by 1))));
end
$$;

-- Which AI provider and model the workspace uses with its own key, for any member: never the key.
create function public.ai_integration(p_workspace uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when public.can_read(p_workspace) then (
    select jsonb_build_object('provider', i.settings ->> 'provider', 'model', coalesce(i.settings ->> 'model', ''), 'visionModel', coalesce(i.settings ->> 'visionModel', ''))
    from public.integrations i
    where i.workspace_id = public.ai_root(p_workspace) and i.provider = 'ai' and i.enabled and 'apiKey' = any (i.secret_fields)
  ) end
$$;

alter table public.ai_usage add column proxied_at timestamptz;

-- Spends a ticket for one call to the AI provider with the workspace's own key.
create function public.ai_ticket_use(p_workspace uuid, p_usage bigint, p_key uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_found bigint;
begin
  update public.ai_usage u set proxied_at = now()
  where u.id = p_usage and u.finish_key = p_key and u.user_id = auth.uid() and u.status = 'started' and u.proxied_at is null
    and u.started_at > now() - interval '5 minutes'
    and public.ai_root(u.workspace_id) = public.ai_root(p_workspace)
  returning u.id into v_found;
  return v_found is not null;
end
$$;

revoke all on function public.integration_providers(), public.integration_save(uuid, text, jsonb, jsonb, boolean), public.ai_integration(uuid), public.ai_ticket_use(uuid, bigint, uuid) from public, anon, authenticated;
grant execute on function public.integration_providers(), public.integration_save(uuid, text, jsonb, jsonb, boolean), public.ai_integration(uuid), public.ai_ticket_use(uuid, bigint, uuid) to authenticated;
