-- ArchONE Diagrams, phase 4: archiving diagrams.
--
--  * A diagram can be archived instead of deleted: it leaves the lists, nothing is removed, and
--    the reason is kept. Restoring it also takes a reason. The history of both stays with it.
--  * Archiving is a change to the diagram, so the same rules decide who may do it (edit rights
--    in its category), and the audit log records it.
--  * A scenario's copy of a diagram keeps it archived or not, as the original was.

alter table public.diagrams add column archive jsonb check (
  archive is null or (
    jsonb_typeof(archive) = 'object'
    and jsonb_typeof(archive -> 'archived') = 'boolean'
    and jsonb_typeof(archive -> 'history') = 'array'
    and jsonb_array_length(archive -> 'history') <= 50
    and pg_column_size(archive) <= 40000
  )
);

create function public.inherit_diagram_archive() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_source uuid := (select w.scenario_of from public.workspaces w where w.id = new.workspace_id);
begin
  if v_source is not null and new.archive is null then
    new.archive := (select d.archive from public.diagrams d where d.workspace_id = v_source and d.id = new.id);
  end if;
  return new;
end
$$;
create trigger inherit_diagram_archive before insert on public.diagrams for each row execute function public.inherit_diagram_archive();
revoke all on function public.inherit_diagram_archive() from public, anon, authenticated;
