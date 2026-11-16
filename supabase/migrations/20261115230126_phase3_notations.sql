-- ArchONE Diagrams, phase 3: notations (PRD FR-10).
--
-- A diagram can be drawn as plain boxes, in ArchiMate or in BPMN. The notation is a property
-- of the diagram; the model behind it does not change. BPMN needs steps to draw, so four
-- object types for process modelling are added to the list the API accepts.

alter table public.diagrams add column notation text not null default 'plain' check (notation in ('plain', 'archimate', 'bpmn'));

insert into public.object_types (id, level) values ('process', 3), ('task', 4), ('event', 4), ('decision', 4);

-- A scenario keeps the notation of each diagram it copies.
create or replace function public.create_scenario(p_workspace uuid, p_name text, p_note text default '') returns uuid
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
  insert into public.diagrams (workspace_id, id, name, description, view_type, scope_id, direction, hidden_relationship_ids, edge_kinds, color_by, notation, created_at, updated_at)
    select v_id, d.id, d.name, d.description, d.view_type, d.scope_id, d.direction, d.hidden_relationship_ids, d.edge_kinds, d.color_by, d.notation, d.created_at, d.updated_at
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
