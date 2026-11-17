-- ArchONE Diagrams, phase 4: a workspace's own components and protocols.
--
--  * One row per change to the library: a component or protocol of the workspace's own (new or
--    a copy), a built-in one changed (same id as the built-in), or a built-in one removed
--    ("removed": true). The built-in library itself stays in the app.
--  * Owners and editors change the library; every member reads it.
--  * A scenario starts with the library of the workspace it was made from.

create table public.library_items (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 120),
  data jsonb not null check (
    jsonb_typeof(data) = 'object' and data ->> 'id' = id
    and data ->> 'type' in ('component', 'protocol')
    and (
      coalesce((data ->> 'removed')::boolean, false)
      or (data ->> 'type' = 'component' and char_length(coalesce(data -> 'component' ->> 'name', '')) between 1 and 120)
      or (data ->> 'type' = 'protocol' and char_length(coalesce(data -> 'protocol' ->> 'name', '')) between 1 and 60)
    )
    and pg_column_size(data) <= 8000
  ),
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create trigger stamp_change before insert or update on public.library_items for each row execute function public.stamp_change();

create function public.limit_library_items() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (select count(*) from public.library_items l where l.workspace_id = new.workspace_id and not l.deleted) >= 3000 then
    raise exception 'This workspace already has 3000 changes to its library. Remove some first.' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger limit_library_items before insert on public.library_items for each row execute function public.limit_library_items();

revoke all on public.library_items from anon, authenticated;
grant select, insert, update on public.library_items to authenticated;
alter table public.library_items enable row level security;
create policy "members read the library" on public.library_items for select to authenticated using (public.can_read(workspace_id));
create policy "editors add to the library" on public.library_items for insert to authenticated with check (public.can_edit(workspace_id));
create policy "editors change the library" on public.library_items for update to authenticated using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));

alter publication supabase_realtime add table public.library_items;

create function public.audit_library_item() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := coalesce(new.data -> 'component' ->> 'name', new.data -> 'protocol' ->> 'name', new.id);
  v_entity text := case when new.data ->> 'type' = 'protocol' then 'protocol' else 'library component' end;
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
create trigger audit after insert or update on public.library_items for each row execute function public.audit_library_item();

create function public.copy_library_items() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.scenario_of is not null then
    insert into public.library_items (workspace_id, id, data, created_at)
      select new.id, l.id, l.data, l.created_at from public.library_items l where l.workspace_id = new.scenario_of and not l.deleted;
  end if;
  return null;
end
$$;
create trigger copy_library_items after insert on public.workspaces for each row execute function public.copy_library_items();

revoke all on function public.limit_library_items(), public.audit_library_item(), public.copy_library_items() from public, anon, authenticated;
