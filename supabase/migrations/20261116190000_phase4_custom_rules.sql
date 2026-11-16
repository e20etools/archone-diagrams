-- ArchONE Diagrams, phase 4: rules a workspace writes for itself.
--
--  * A rule is stored and synced like a decision record: one row per rule, the rule in "data".
--  * Rules are the workspace's policy, so only owners write them; every member reads them,
--    because the checks run in each member's browser.
--  * A scenario starts with the rules of the model it was copied from.
--  * Versions do not hold rules: a version is judged by the rules in force when it is looked at.

create table public.custom_rules (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  data jsonb not null check (jsonb_typeof(data) = 'object' and data ->> 'id' = id and pg_column_size(data) <= 20000),
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create trigger stamp_change before insert or update on public.custom_rules for each row execute function public.stamp_change();

create function public.limit_custom_rules() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (select count(*) from public.custom_rules r where r.workspace_id = new.workspace_id and not r.deleted) >= 200 then
    raise exception 'This workspace already has 200 rules of its own. Delete one first.' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger limit_rules before insert on public.custom_rules for each row execute function public.limit_custom_rules();

revoke all on public.custom_rules from anon, authenticated;
grant select, insert, update on public.custom_rules to authenticated;
alter table public.custom_rules enable row level security;
create policy "members read rules" on public.custom_rules for select to authenticated using (public.can_read(workspace_id));
create policy "owners add rules" on public.custom_rules for insert to authenticated with check (public.is_owner(workspace_id));
create policy "owners change rules" on public.custom_rules for update to authenticated using (public.is_owner(workspace_id)) with check (public.is_owner(workspace_id));

alter publication supabase_realtime add table public.custom_rules;

-- The audit log records what happens to a rule.
create function public.audit_custom_rule() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_write(new.workspace_id, 'rule', new.id, new.data ->> 'title', 'created', jsonb_build_object('severity', new.data -> 'severity'));
  elsif new.deleted and not old.deleted then
    perform public.audit_write(new.workspace_id, 'rule', new.id, new.data ->> 'title', 'deleted', '{}'::jsonb);
  elsif (new.data -> 'enabled') is distinct from (old.data -> 'enabled') then
    perform public.audit_write(new.workspace_id, 'rule', new.id, new.data ->> 'title', case when (new.data ->> 'enabled')::boolean then 'switched on' else 'switched off' end, '{}'::jsonb);
  elsif (new.data - 'updatedAt') is distinct from (old.data - 'updatedAt') then
    perform public.audit_write(new.workspace_id, 'rule', new.id, new.data ->> 'title', 'updated', '{}'::jsonb);
  end if;
  return null;
end
$$;
create trigger audit after insert or update on public.custom_rules for each row execute function public.audit_custom_rule();

-- A new scenario takes the rules of its main workspace with it. The copy is part of creating
-- the scenario, which is recorded once, so it writes no entries of its own.
create function public.copy_rules_to_scenario() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_before text := coalesce(current_setting('archone.audit_off', true), '');
begin
  perform set_config('archone.audit_off', '1', true);
  insert into public.custom_rules (workspace_id, id, data, created_at)
    select new.id, r.id, r.data, r.created_at from public.custom_rules r where r.workspace_id = new.scenario_of and not r.deleted;
  perform set_config('archone.audit_off', v_before, true);
  return null;
end
$$;
create trigger copy_rules after insert on public.workspaces for each row when (new.scenario_of is not null) execute function public.copy_rules_to_scenario();

revoke all on function public.limit_custom_rules(), public.audit_custom_rule(), public.copy_rules_to_scenario() from public, anon, authenticated;

-- Marked-deleted rules are removed with the rest.
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
  return v_total;
end
$$;
