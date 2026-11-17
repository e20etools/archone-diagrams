-- ArchONE Diagrams, phase 4: integrations with outside services, set up in the app.
--
--  * integrations: one row per workspace and service (AWS, Azure, Google Cloud, ServiceNow, BMC
--    Helix Discovery, Device42, APM & Landscape): what is not secret (addresses, regions, a
--    scope, a user name), whether it is on, and how its last connection went.
--  * What is secret (keys, passwords, tokens, a service account key) is kept in Supabase Vault,
--    encrypted, as one JSON object per integration. Owners set it with integration_save, which
--    never returns it. A browser learns only which secret fields are kept.
--  * Only the integrations Edge Function, with the service role, reads the secrets back
--    (integration_credentials), to connect on behalf of an owner or editor it has checked.
--  * A scenario uses the integrations of the workspace it was made from.
--  * Changes are written to the audit log, with the names of the secret fields but never their values.

create table public.integrations (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider text not null check (provider in ('aws', 'azure', 'gcp', 'servicenow', 'bmc', 'device42', 'apm')),
  enabled boolean not null default true,
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 20000),
  secret_fields text[] not null default '{}',
  secret_id uuid,
  status text not null default 'untested' check (status in ('untested', 'ok', 'failed')),
  status_message text not null default '' check (length(status_message) <= 600),
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, provider)
);

-- Nobody reads or writes the table directly: integration_list answers without the vault reference.
revoke all on public.integrations from anon, authenticated;
alter table public.integrations enable row level security;

create function public.integration_list(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_root uuid := public.ai_root(p_workspace);
  v_full boolean := public.can_edit(p_workspace);
begin
  if not public.can_read(p_workspace) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'provider', i.provider,
      'enabled', i.enabled,
      -- Viewers see that a service is connected, not how.
      'settings', case when v_full then i.settings else '{}'::jsonb end,
      'secretFields', case when v_full then to_jsonb(i.secret_fields) else '[]'::jsonb end,
      'status', i.status,
      'statusMessage', i.status_message,
      'checkedAt', i.checked_at,
      'changedAt', i.changed_at
    ) order by i.provider)
    from public.integrations i where i.workspace_id = v_root
  ), '[]'::jsonb);
end
$$;

create function public.integration_save(p_workspace uuid, p_provider text, p_settings jsonb, p_secrets jsonb, p_enabled boolean default true) returns void
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
  if p_provider is null or p_provider not in ('aws', 'azure', 'gcp', 'servicenow', 'bmc', 'device42', 'apm') then
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

create function public.integration_remove(p_workspace uuid, p_provider text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_root uuid := public.ai_root(p_workspace);
  v_secret uuid;
begin
  if v_root is null or not public.is_owner(v_root) then
    raise exception 'Only an owner can remove integrations' using errcode = '42501';
  end if;
  -- The trigger below deletes the secret kept in the vault with the row.
  delete from public.integrations where workspace_id = v_root and provider = p_provider returning secret_id into v_secret;
  if not found then return; end if;
  perform public.audit_write(v_root, 'workspace', v_root::text, 'Integration: ' || p_provider, 'Integration removed', jsonb_build_object('provider', p_provider));
end
$$;

-- For the integrations Edge Function only (service role): the settings and the secrets, to connect.
create function public.integration_credentials(p_workspace uuid, p_provider text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'enabled', i.enabled,
    'settings', i.settings,
    'secrets', coalesce((select d.decrypted_secret::jsonb from vault.decrypted_secrets d where d.id = i.secret_id), '{}'::jsonb)
  )
  from public.integrations i
  where i.workspace_id = public.ai_root(p_workspace) and i.provider = p_provider
$$;

-- For the integrations Edge Function only: how the last connection went.
create function public.integration_mark(p_workspace uuid, p_provider text, p_ok boolean, p_message text) returns void
language sql security definer set search_path = ''
as $$
  update public.integrations
  set status = case when p_ok then 'ok' else 'failed' end, status_message = left(coalesce(p_message, ''), 600), checked_at = now()
  where workspace_id = public.ai_root(p_workspace) and provider = p_provider
$$;

-- Deleting a workspace leaves no credentials behind in the vault.
create function public.integration_forget_secret() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.secret_id is not null then delete from vault.secrets where id = old.secret_id; end if;
  return null;
end
$$;
create trigger forget_secret after delete on public.integrations for each row execute function public.integration_forget_secret();

revoke all on function public.integration_list(uuid), public.integration_save(uuid, text, jsonb, jsonb, boolean), public.integration_remove(uuid, text),
  public.integration_credentials(uuid, text), public.integration_mark(uuid, text, boolean, text), public.integration_forget_secret() from public, anon, authenticated;
grant execute on function public.integration_list(uuid), public.integration_save(uuid, text, jsonb, jsonb, boolean), public.integration_remove(uuid, text) to authenticated;
grant execute on function public.integration_credentials(uuid, text), public.integration_mark(uuid, text, boolean, text) to service_role;
