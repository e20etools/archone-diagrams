-- ArchONE Diagrams, phase 4: business process management.
--
--  * process_models: one row per process of the workspace's landscape, with its BPMN 2.0 file,
--    its owner, status and published versions, KPIs, risks, decision tables, simulation scenarios,
--    what the steps use and who does them, and a small summary of the last event log mined.
--  * Owners and editors change processes; every member reads them. A published process can
--    only be changed back to draft or review by an owner or editor, like any other change.
--  * A scenario starts with the processes of the workspace it was made from.

create table public.process_models (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 120),
  data jsonb not null check (
    jsonb_typeof(data) = 'object' and data ->> 'id' = id
    and char_length(coalesce(data ->> 'name', '')) between 1 and 200
    and coalesce(data ->> 'status', 'draft') in ('draft', 'review', 'published', 'retired')
    and pg_column_size(data) <= 3000000
  ),
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create trigger stamp_change before insert or update on public.process_models for each row execute function public.stamp_change();

create function public.limit_process_models() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (select count(*) from public.process_models p where p.workspace_id = new.workspace_id and not p.deleted) >= 2000 then
    raise exception 'This workspace already has 2000 processes. Remove some first.' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger limit_process_models before insert on public.process_models for each row execute function public.limit_process_models();

revoke all on public.process_models from anon, authenticated;
grant select, insert, update on public.process_models to authenticated;
alter table public.process_models enable row level security;
create policy "members read processes" on public.process_models for select to authenticated using (public.can_read(workspace_id));
create policy "editors add processes" on public.process_models for insert to authenticated with check (public.can_edit(workspace_id));
create policy "editors change processes" on public.process_models for update to authenticated using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));

alter publication supabase_realtime add table public.process_models;

-- The audit log says what happened to a process, not its whole BPMN file.
create function public.audit_process_model() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := coalesce(new.data ->> 'name', new.id);
  v_status text := coalesce(new.data ->> 'status', 'draft');
begin
  if tg_op = 'INSERT' or (old.deleted and not new.deleted) then
    perform public.audit_write(new.workspace_id, 'process', new.id, v_name, 'added', jsonb_build_object('status', v_status));
  elsif new.deleted and not old.deleted then
    perform public.audit_write(new.workspace_id, 'process', new.id, v_name, 'deleted', '{}'::jsonb);
  elsif coalesce(old.data ->> 'status', 'draft') <> v_status then
    perform public.audit_write(new.workspace_id, 'process', new.id, v_name,
      case v_status when 'published' then 'published version ' || coalesce(new.data ->> 'version', '?') when 'review' then 'sent for review' when 'retired' then 'retired' else 'back to draft' end,
      jsonb_build_object('from', coalesce(old.data ->> 'status', 'draft'), 'to', v_status));
  elsif (new.data - 'updatedAt' - 'mining') is distinct from (old.data - 'updatedAt' - 'mining') then
    perform public.audit_write(new.workspace_id, 'process', new.id, v_name, 'changed',
      jsonb_build_object('model', (new.data ->> 'xml') is distinct from (old.data ->> 'xml')));
  end if;
  return null;
end
$$;
create trigger audit after insert or update on public.process_models for each row execute function public.audit_process_model();

create function public.copy_process_models() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.scenario_of is not null then
    insert into public.process_models (workspace_id, id, data, created_at)
      select new.id, p.id, p.data, p.created_at from public.process_models p where p.workspace_id = new.scenario_of and not p.deleted;
  end if;
  return null;
end
$$;
create trigger copy_process_models after insert on public.workspaces for each row execute function public.copy_process_models();

revoke all on function public.limit_process_models(), public.audit_process_model(), public.copy_process_models() from public, anon, authenticated;
