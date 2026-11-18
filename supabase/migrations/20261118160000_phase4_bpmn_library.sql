-- ArchONE Diagrams, phase 4: the BPMN library's own building blocks.
--
-- A workspace keeps its own BPMN building blocks (steps it uses again and again in its processes,
-- each with its kind, role, time and systems) with its other library items, as items of type
-- 'bpmn'. The app shows them in the BPMN library, apart from the components of diagrams.

alter table public.library_items drop constraint library_items_check;
alter table public.library_items add constraint library_items_check check (
  jsonb_typeof(data) = 'object' and data ->> 'id' = id
  and data ->> 'type' in ('component', 'protocol', 'bpmn')
  and (
    coalesce((data ->> 'removed')::boolean, false)
    or (data ->> 'type' = 'component' and char_length(coalesce(data -> 'component' ->> 'name', '')) between 1 and 120)
    or (data ->> 'type' = 'protocol' and char_length(coalesce(data -> 'protocol' ->> 'name', '')) between 1 and 60)
    or (data ->> 'type' = 'bpmn' and char_length(coalesce(data -> 'bpmn' ->> 'name', '')) between 1 and 120)
  )
  and pg_column_size(data) <= 8000
);

-- The audit log names a building block as such.
create or replace function public.audit_library_item() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := coalesce(new.data -> 'component' ->> 'name', new.data -> 'protocol' ->> 'name', new.data -> 'bpmn' ->> 'name', new.id);
  v_entity text := case new.data ->> 'type' when 'protocol' then 'protocol' when 'bpmn' then 'BPMN building block' else 'library component' end;
begin
  if tg_op = 'INSERT' or (old.deleted and not new.deleted) then
    perform public.audit_write(new.workspace_id, v_entity, new.id, v_name,
      case when coalesce((new.data ->> 'removed')::boolean, false) then 'removed from the library' else 'added or changed' end, '{}'::jsonb);
  elsif new.deleted and not old.deleted then
    perform public.audit_write(new.workspace_id, v_entity, new.id, v_name, 'deleted', '{}'::jsonb);
  elsif (new.data - 'updatedAt') is distinct from (old.data - 'updatedAt') then
    perform public.audit_write(new.workspace_id, v_entity, new.id, v_name,
      case when coalesce((new.data ->> 'removed')::boolean, false) then 'removed from the library' else 'changed' end, '{}'::jsonb);
  end if;
  return null;
end
$$;
revoke all on function public.audit_library_item() from public, anon, authenticated;
