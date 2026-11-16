-- ArchONE Diagrams, phase 4: templates a workspace makes from its own diagrams.
--
--  * A template is stored and synced like a decision record: one row each, the template in "data".
--  * Owners and editors save and delete templates; every member can see and use them.
--  * A template keeps component ids, names, lines and positions, never the objects' owners,
--    descriptions, fields or links.
--  * Versions and scenarios do not hold templates: they belong to the workspace as it is.

create table public.diagram_templates (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  data jsonb not null check (
    jsonb_typeof(data) = 'object' and data ->> 'id' = id
    and jsonb_typeof(data -> 'objects') = 'array' and jsonb_array_length(data -> 'objects') between 1 and 200
    and pg_column_size(data) <= 200000
  ),
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create trigger stamp_change before insert or update on public.diagram_templates for each row execute function public.stamp_change();

create function public.limit_diagram_templates() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (select count(*) from public.diagram_templates t where t.workspace_id = new.workspace_id and not t.deleted) >= 300 then
    raise exception 'This workspace already has 300 templates of its own. Delete one first.' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger limit_templates before insert on public.diagram_templates for each row execute function public.limit_diagram_templates();

revoke all on public.diagram_templates from anon, authenticated;
grant select, insert, update on public.diagram_templates to authenticated;
alter table public.diagram_templates enable row level security;
create policy "members read templates" on public.diagram_templates for select to authenticated using (public.can_read(workspace_id));
create policy "editors add templates" on public.diagram_templates for insert to authenticated with check (public.can_edit(workspace_id));
create policy "editors change templates" on public.diagram_templates for update to authenticated using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));

alter publication supabase_realtime add table public.diagram_templates;

create function public.audit_diagram_template() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_write(new.workspace_id, 'template', new.id, new.data ->> 'name', 'created', jsonb_build_object('perspective', new.data -> 'perspective'));
  elsif new.deleted and not old.deleted then
    perform public.audit_write(new.workspace_id, 'template', new.id, new.data ->> 'name', 'deleted', '{}'::jsonb);
  elsif (new.data - 'updatedAt') is distinct from (old.data - 'updatedAt') then
    perform public.audit_write(new.workspace_id, 'template', new.id, new.data ->> 'name', 'updated', '{}'::jsonb);
  end if;
  return null;
end
$$;
create trigger audit after insert or update on public.diagram_templates for each row execute function public.audit_diagram_template();

revoke all on function public.limit_diagram_templates(), public.audit_diagram_template() from public, anon, authenticated;

-- Marked-deleted templates are removed with the rest.
create or replace function public.purge_deleted(p_workspace uuid, p_older_than interval default interval '30 days') returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_total integer := 0;
  v_count integer;
begin
  if not public.is_owner(p_workspace) then
    raise exception 'Only an owner can do this.' using errcode = '42501';
  end if;
  delete from public.diagram_nodes t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.relationships t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.diagrams t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.objects t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.proposals t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.decision_records t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.custom_rules t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.diagram_templates t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  return v_total;
end
$$;
