-- ArchONE Diagrams, phase 3: audit log (PRD NFR-03).
--
-- Every change to the model and to who may do what is written down by the database itself:
-- who, what, when, and for a change of fields the value before and after. The entries are
-- written by triggers, so they do not depend on the app, and they cover the REST API too.
-- Nobody can change or remove an entry; owners of a workspace can read its entries.
--
-- Not recorded: moving a box on a diagram (layout, not the model), comments, and AI drafts
-- that were never saved to the model. Deleting a workspace removes its entries with it.

create table public.audit_log (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  at timestamptz not null default clock_timestamp(),
  -- No foreign key: an entry outlives the account that caused it.
  actor_id uuid,
  -- The person's name, or the API key's, as it was at the time.
  actor_name text not null,
  via text not null check (via in ('app', 'api', 'system')),
  entity text not null,
  entity_id text not null,
  entity_name text not null default '',
  action text not null,
  -- { "field": [before, after] }
  changes jsonb not null default '{}'
);
create index audit_log_workspace on public.audit_log (workspace_id, id desc);

alter table public.audit_log enable row level security;
create policy "owners read the audit log" on public.audit_log for select to authenticated using (public.is_owner(workspace_id));
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

-- Append-only, for every role: an entry is never changed, and is removed only together with
-- its workspace.
create function public.audit_log_is_append_only() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;
  raise exception 'The audit log cannot be changed.' using errcode = '42501';
end
$$;
create trigger append_only before update or delete on public.audit_log for each row execute function public.audit_log_is_append_only();
create trigger append_only_truncate before truncate on public.audit_log for each statement execute function public.audit_log_is_append_only();

-- ---------------------------------------------------------------------------
-- Writing an entry
-- ---------------------------------------------------------------------------

create function public.audit_write(p_workspace uuid, p_entity text, p_id text, p_name text, p_action text, p_changes jsonb default '{}') returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_key_name text;
  v_name text;
  v_via text;
begin
  -- While a workspace is being deleted its rows go one by one; there is nothing left to record against.
  if not exists (select 1 from public.workspaces w where w.id = p_workspace) then
    return;
  end if;
  -- api_request() names the key it was called with; it counts only if it is a key of this workspace.
  select k.name into v_key_name from public.api_keys k
    where k.id::text = nullif(current_setting('archone.api_key', true), '') and k.workspace_id = p_workspace;
  if v_key_name is not null then
    v_via := 'api';
    v_name := 'API key "' || v_key_name || '"';
    v_uid := null;
  elsif v_uid is not null then
    v_via := 'app';
    select coalesce(nullif(btrim(p.display_name), ''), p.email) into v_name from public.profiles p where p.id = v_uid;
    v_name := coalesce(v_name, 'Unknown person');
  else
    v_via := 'system';
    v_name := 'System';
  end if;
  insert into public.audit_log (workspace_id, actor_id, actor_name, via, entity, entity_id, entity_name, action, changes)
  values (p_workspace, v_uid, v_name, v_via, p_entity, coalesce(p_id, ''), left(coalesce(p_name, ''), 300), p_action, coalesce(p_changes, '{}'::jsonb));
end
$$;

-- The fields that differ between two rows, as { field: [before, after] }. With no row before,
-- only fields that hold something are listed.
create function public.audit_diff(p_old jsonb, p_new jsonb, p_skip text[]) returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, jsonb_build_array(p_old -> k, p_new -> k)), '{}'::jsonb)
  from jsonb_object_keys(coalesce(p_old, '{}'::jsonb) || coalesce(p_new, '{}'::jsonb)) as k
  where k <> all (p_skip)
    and (p_old -> k) is distinct from (p_new -> k)
    and (p_old is not null or coalesce(p_new -> k, 'null'::jsonb) not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb, 'false'::jsonb))
$$;

create function public.audit_person(p_user uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce((select coalesce(nullif(btrim(p.display_name), ''), p.email) from public.profiles p where p.id = p_user), 'A removed account')
$$;

-- ---------------------------------------------------------------------------
-- One trigger for the tables that are plain rows
--   arguments: what the row is called, the column that names it, extra columns to leave out
-- ---------------------------------------------------------------------------

create function public.audit_row() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_entity text := tg_argv[0];
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_skip text[] := array['workspace_id', 'id', 'created_at', 'updated_at', 'changed_at', 'changed_by', 'created_by', 'deleted']
    || string_to_array(coalesce(tg_argv[2], ''), ',');
  v_ws uuid := (v_row ->> case when tg_argv[0] = 'workspace' then 'id' else 'workspace_id' end)::uuid;
  v_name text := v_row ->> nullif(tg_argv[1], '');
  v_action text;
  v_changes jsonb := '{}';
begin
  if v_entity = 'relationship' then
    v_name := coalesce((select o.name from public.objects o where o.workspace_id = v_ws and o.id = v_row ->> 'source_id'), '?')
      || ' → ' || coalesce((select o.name from public.objects o where o.workspace_id = v_ws and o.id = v_row ->> 'target_id'), '?');
  elsif v_entity = 'live link' then
    v_name := coalesce((select d.name from public.diagrams d where d.workspace_id = v_ws and d.id = v_row ->> 'diagram_id'), '');
  end if;

  if tg_op = 'INSERT' then
    if coalesce((v_new ->> 'deleted')::boolean, false) then return null; end if;
    v_action := 'created';
    v_changes := public.audit_diff(null, v_new, v_skip);
  elsif tg_op = 'DELETE' then
    -- A row already marked as deleted was recorded then; clearing it away is housekeeping.
    if coalesce((v_old ->> 'deleted')::boolean, false) then return null; end if;
    v_action := 'deleted';
  elsif (v_old ->> 'deleted') is distinct from (v_new ->> 'deleted') then
    v_action := case when (v_new ->> 'deleted')::boolean then 'deleted' else 'restored' end;
  elsif (v_old ->> 'revoked_at') is null and (v_new ->> 'revoked_at') is not null then
    v_action := 'switched off';
  else
    v_changes := public.audit_diff(v_old, v_new, v_skip);
    if v_changes = '{}'::jsonb then return null; end if;
    v_action := 'updated';
  end if;
  perform public.audit_write(v_ws, v_entity, v_row ->> 'id', v_name, v_action, v_changes);
  return null;
end
$$;

create trigger audit after insert or update or delete on public.objects for each row execute function public.audit_row('object', 'name', '');
create trigger audit after insert or update or delete on public.relationships for each row execute function public.audit_row('relationship', '', '');
create trigger audit after insert or update or delete on public.diagrams for each row execute function public.audit_row('diagram', 'name', '');
create trigger audit after insert or delete on public.versions for each row execute function public.audit_row('version', 'name', 'snapshot,object_count,relationship_count,diagram_count');
create trigger audit after insert or update or delete on public.api_keys for each row execute function public.audit_row('API key', 'name', 'key_hash,prefix,last_used_at,revoked_at');
create trigger audit after insert or update or delete on public.webhooks for each row execute function public.audit_row('webhook', 'url', 'secret');
create trigger audit after insert or update or delete on public.embeds for each row execute function public.audit_row('live link', '', 'token,revoked_at');
create trigger audit after update on public.workspaces for each row execute function public.audit_row('workspace', 'name', '');

-- ---------------------------------------------------------------------------
-- Tables that need their own words
-- ---------------------------------------------------------------------------

-- A box put on a diagram or taken off it. Moving a box is layout and is not recorded.
create function public.audit_diagram_node() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_diagram public.diagrams;
  v_action text;
begin
  if tg_op = 'INSERT' then
    if new.deleted then return null; end if;
    v_action := 'object added';
  elsif old.deleted is distinct from new.deleted then
    v_action := case when new.deleted then 'object removed' else 'object added' end;
  else
    return null;
  end if;
  select * into v_diagram from public.diagrams d where d.workspace_id = new.workspace_id and d.id = new.diagram_id;
  -- Boxes that go because their diagram went are covered by the diagram's own entry.
  if not found or v_diagram.deleted then return null; end if;
  perform public.audit_write(new.workspace_id, 'diagram', new.diagram_id, v_diagram.name, v_action,
    jsonb_build_object('object', coalesce((select to_jsonb(o.name) from public.objects o where o.workspace_id = new.workspace_id and o.id = new.object_id), to_jsonb(new.object_id))));
  return null;
end
$$;
create trigger audit after insert or update on public.diagram_nodes for each row execute function public.audit_diagram_node();

create function public.audit_member() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_write(new.workspace_id, 'member', new.user_id::text, public.audit_person(new.user_id), 'added', jsonb_build_object('role', jsonb_build_array(null, new.role)));
  elsif tg_op = 'DELETE' then
    perform public.audit_write(old.workspace_id, 'member', old.user_id::text, public.audit_person(old.user_id), 'removed', jsonb_build_object('role', jsonb_build_array(old.role, null)));
  elsif old.role is distinct from new.role then
    perform public.audit_write(new.workspace_id, 'member', new.user_id::text, public.audit_person(new.user_id), 'role changed', jsonb_build_object('role', jsonb_build_array(old.role, new.role)));
  end if;
  return null;
end
$$;
create trigger audit after insert or update or delete on public.workspace_members for each row execute function public.audit_member();

-- An invitation ends by being accepted, declined or cancelled; acceptance shows as the member being added.
create function public.audit_invite() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_write(new.workspace_id, 'invitation', new.id::text, new.email, 'sent', jsonb_build_object('role', jsonb_build_array(null, new.role)));
  else
    perform public.audit_write(old.workspace_id, 'invitation', old.id::text, old.email, 'closed', '{}'::jsonb);
  end if;
  return null;
end
$$;
create trigger audit after insert or delete on public.workspace_invites for each row execute function public.audit_invite();

create function public.audit_review() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_last jsonb;
begin
  if tg_op = 'INSERT' then
    perform public.audit_write(new.workspace_id, 'review', new.id::text, new.title, 'submitted', '{}'::jsonb);
    return null;
  end if;
  v_last := new.decisions -> (jsonb_array_length(new.decisions) - 1);
  if old.status is distinct from new.status then
    perform public.audit_write(new.workspace_id, 'review', new.id::text, new.title, new.status,
      case when new.status = 'withdrawn' or v_last is null then '{}'::jsonb
        else jsonb_strip_nulls(jsonb_build_object('stage', v_last -> 'stageName', 'reason', nullif(v_last ->> 'reason', ''))) end);
  elsif jsonb_array_length(new.decisions) > jsonb_array_length(old.decisions) then
    perform public.audit_write(new.workspace_id, 'review', new.id::text, new.title, 'stage ' || coalesce(v_last ->> 'decision', 'decided'),
      jsonb_strip_nulls(jsonb_build_object('stage', v_last -> 'stageName', 'to', case when v_last ->> 'to' is null then null else to_jsonb(public.audit_person((v_last ->> 'to')::uuid)) end)));
  end if;
  return null;
end
$$;
create trigger audit after insert or update on public.reviews for each row execute function public.audit_review();

-- ---------------------------------------------------------------------------
-- The API says which key is acting, so its changes are recorded under the key's name
-- ---------------------------------------------------------------------------

alter function public.api_request(text, text, text, jsonb, jsonb) rename to api_dispatch;
revoke all on function public.api_dispatch(text, text, text, jsonb, jsonb) from public, anon, authenticated;

create function public.api_request(p_key text, p_method text, p_path text, p_query jsonb default '{}', p_body jsonb default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  select k.id into v_id from public.api_keys k where k.key_hash = public.sha256_hex(coalesce(p_key, '')) and k.revoked_at is null;
  perform set_config('archone.api_key', coalesce(v_id::text, ''), true);
  return public.api_dispatch(p_key, p_method, p_path, p_query, p_body);
end
$$;

revoke all on function
  public.audit_log_is_append_only(), public.audit_write(uuid, text, text, text, text, jsonb), public.audit_diff(jsonb, jsonb, text[]),
  public.audit_person(uuid), public.audit_row(), public.audit_diagram_node(), public.audit_member(), public.audit_invite(), public.audit_review(),
  public.api_request(text, text, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.api_request(text, text, text, jsonb, jsonb) to anon, authenticated;
