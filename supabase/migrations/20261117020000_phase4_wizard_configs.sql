-- ArchONE Diagrams, phase 4: the wizard's questions, set by each workspace.
--
--  * One row per kind of diagram, the questions in "data". A kind without a row uses the
--    questions the app comes with.
--  * The questions are the workspace's way of working, so only owners change them; every member
--    reads them, because the wizard runs in each member's browser.
--  * A scenario starts with the questions of the workspace it was made from.

create table public.wizard_configs (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (id in ('landscape', 'context', 'container', 'deployment', 'dataflow', 'business', 'custom')),
  data jsonb not null check (
    jsonb_typeof(data) = 'object' and data ->> 'id' = id
    and jsonb_typeof(data -> 'steps') = 'array' and jsonb_array_length(data -> 'steps') between 1 and 20
    and pg_column_size(data) <= 60000
  ),
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create trigger stamp_change before insert or update on public.wizard_configs for each row execute function public.stamp_change();

revoke all on public.wizard_configs from anon, authenticated;
grant select, insert, update on public.wizard_configs to authenticated;
alter table public.wizard_configs enable row level security;
create policy "members read wizard steps" on public.wizard_configs for select to authenticated using (public.can_read(workspace_id));
create policy "owners add wizard steps" on public.wizard_configs for insert to authenticated with check (public.is_owner(workspace_id));
create policy "owners change wizard steps" on public.wizard_configs for update to authenticated using (public.is_owner(workspace_id)) with check (public.is_owner(workspace_id));

alter publication supabase_realtime add table public.wizard_configs;

create function public.audit_wizard_config() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or (old.deleted and not new.deleted) then
    perform public.audit_write(new.workspace_id, 'wizard', new.id, new.id, 'created', jsonb_build_object('steps', jsonb_array_length(new.data -> 'steps')));
  elsif new.deleted and not old.deleted then
    perform public.audit_write(new.workspace_id, 'wizard', new.id, new.id, 'reset', '{}'::jsonb);
  elsif (new.data - 'updatedAt') is distinct from (old.data - 'updatedAt') then
    perform public.audit_write(new.workspace_id, 'wizard', new.id, new.id, 'updated', jsonb_build_object('steps', jsonb_build_array(jsonb_array_length(old.data -> 'steps'), jsonb_array_length(new.data -> 'steps'))));
  end if;
  return null;
end
$$;
create trigger audit after insert or update on public.wizard_configs for each row execute function public.audit_wizard_config();

-- A new scenario takes the questions of the workspace it was made from.
create function public.copy_wizard_configs() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.scenario_of is not null then
    insert into public.wizard_configs (workspace_id, id, data, created_at)
      select new.id, c.id, c.data, c.created_at from public.wizard_configs c where c.workspace_id = new.scenario_of and not c.deleted;
  end if;
  return null;
end
$$;
create trigger copy_wizard_configs after insert on public.workspaces for each row execute function public.copy_wizard_configs();

revoke all on function public.audit_wizard_config(), public.copy_wizard_configs() from public, anon, authenticated;
