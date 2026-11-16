-- ArchONE Diagrams, phase 3: scenarios (PRD FR-17).
--
-- A scenario is a copy of a workspace's model that people change freely, to try out a target
-- state, and then compare with the model as it is now. It is a workspace of its own, tied to
-- the one it was taken from: editing, roles, versions and the audit log work in it as they do
-- anywhere. Deleting the main workspace deletes its scenarios.

alter table public.workspaces
  add column scenario_of uuid references public.workspaces (id) on delete cascade,
  add column scenario_note text not null default '' check (char_length(scenario_note) <= 2000);
create index workspaces_scenario_of on public.workspaces (scenario_of) where scenario_of is not null;

-- Copying a model into a scenario is one event, not one per row: create_scenario() switches
-- the row-by-row entries off while it copies, and writes its own.
create or replace function public.audit_write(p_workspace uuid, p_entity text, p_id text, p_name text, p_action text, p_changes jsonb default '{}') returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_key_name text;
  v_name text;
  v_via text;
begin
  if current_setting('archone.audit_off', true) = '1' then
    return;
  end if;
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

create function public.create_scenario(p_workspace uuid, p_name text, p_note text default '') returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_source public.workspaces;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if not public.can_edit(p_workspace) then
    raise exception 'Only owners and editors can create a scenario.' using errcode = '42501';
  end if;
  select * into v_source from public.workspaces w where w.id = p_workspace;
  if v_source.scenario_of is not null then
    raise exception 'A scenario cannot have scenarios of its own. Create it from the main workspace.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.workspaces w where w.scenario_of = p_workspace) >= 20 then
    raise exception 'This workspace already has 20 scenarios. Delete one first.' using errcode = 'P0001';
  end if;

  insert into public.workspaces (name, created_by, scenario_of, scenario_note)
  values (btrim(p_name), v_user, p_workspace, coalesce(p_note, '')) returning id into v_id;

  perform set_config('archone.audit_off', '1', true);
  -- Only people who already see the working model come along. With review on, viewers and
  -- commenters are held on the published version, and a scenario must not show them more.
  insert into public.workspace_members (workspace_id, user_id, role)
    select v_id, m.user_id, m.role from public.workspace_members m where m.workspace_id = p_workspace and m.role in ('owner', 'editor');
  insert into public.objects (workspace_id, id, type_id, name, description, owner, lifecycle, tags, parent_id, technology, fields, provenance, created_at, updated_at)
    select v_id, o.id, o.type_id, o.name, o.description, o.owner, o.lifecycle, o.tags, o.parent_id, o.technology, o.fields, o.provenance, o.created_at, o.updated_at
    from public.objects o where o.workspace_id = p_workspace and not o.deleted;
  insert into public.relationships (workspace_id, id, source_id, target_id, kind, label, protocol, port, description, provenance, created_at, updated_at)
    select v_id, r.id, r.source_id, r.target_id, r.kind, r.label, r.protocol, r.port, r.description, r.provenance, r.created_at, r.updated_at
    from public.relationships r where r.workspace_id = p_workspace and not r.deleted;
  insert into public.diagrams (workspace_id, id, name, description, view_type, scope_id, direction, hidden_relationship_ids, edge_kinds, color_by, created_at, updated_at)
    select v_id, d.id, d.name, d.description, d.view_type, d.scope_id, d.direction, d.hidden_relationship_ids, d.edge_kinds, d.color_by, d.created_at, d.updated_at
    from public.diagrams d where d.workspace_id = p_workspace and not d.deleted;
  insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y, pinned)
    select v_id, n.diagram_id, n.object_id, n.x, n.y, n.pinned
    from public.diagram_nodes n where n.workspace_id = p_workspace and not n.deleted;
  perform set_config('archone.audit_off', '', true);

  perform public.audit_write(p_workspace, 'scenario', v_id::text, btrim(p_name), 'created', '{}'::jsonb);
  perform public.audit_write(v_id, 'scenario', v_id::text, btrim(p_name), 'created', jsonb_build_object('copied from', v_source.name));
  return v_id;
end
$$;

revoke all on function public.create_scenario(uuid, text, text), public.audit_write(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_scenario(uuid, text, text) to authenticated;
