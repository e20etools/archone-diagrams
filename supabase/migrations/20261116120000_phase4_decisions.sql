-- ArchONE Diagrams, phase 4: the decision log.
--
--  * A decision record says what was decided, why, and what follows from it. It is synced
--    like the rest of the model: one row per record, the record itself in "data".
--  * A record that has been decided keeps its text. It can be superseded, not rewritten.
--  * Closing a review, by approval or rejection, writes a record by itself.

create table public.decision_records (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  status text not null check (status in ('proposed', 'accepted', 'rejected', 'superseded')),
  data jsonb not null check (jsonb_typeof(data) = 'object' and data ->> 'id' = id and data ->> 'status' = status and pg_column_size(data) <= 200000),
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create trigger stamp_change before insert or update on public.decision_records for each row execute function public.stamp_change();

-- A decided record keeps its text: only its status, what replaces it and the objects it points at can still change.
create function public.guard_decision_record() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_open constant text[] := array['status', 'supersededBy', 'objectIds', 'updatedAt'];
begin
  if old.status = 'proposed' then
    return new;
  end if;
  if new.deleted and not old.deleted then
    raise exception 'A decided record cannot be deleted. Supersede it with a new decision instead.' using errcode = 'P0001';
  end if;
  if (new.data - v_open) is distinct from (old.data - v_open) then
    raise exception 'The text of a decided record is fixed. Supersede it with a new decision instead.' using errcode = 'P0001';
  end if;
  if new.status <> old.status and not (old.status in ('accepted', 'superseded') and new.status in ('accepted', 'superseded')) then
    raise exception 'A decided record cannot go back to %.', new.status using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger guard before update on public.decision_records for each row execute function public.guard_decision_record();

-- Marked-deleted records are removed with the rest.
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
  return v_total;
end
$$;

revoke all on public.decision_records from anon, authenticated;
grant select, insert, update on public.decision_records to authenticated;
alter table public.decision_records enable row level security;
create policy "members read decisions" on public.decision_records for select to authenticated using (public.can_read(workspace_id));
create policy "editors add decisions" on public.decision_records for insert to authenticated with check (public.can_edit(workspace_id));
create policy "editors change decisions" on public.decision_records for update to authenticated using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));

alter publication supabase_realtime add table public.decision_records;

-- What differs between two stored copies of one table, leaving the time of the last change aside.
create function public.snapshot_diff(p_old jsonb, p_new jsonb, out added integer, out changed integer, out removed integer, out ids jsonb)
language sql immutable set search_path = ''
as $$
  with n as (select e ->> 'id' as id, e - 'updated_at' as r from jsonb_array_elements(case when jsonb_typeof(p_new) = 'array' then p_new else '[]'::jsonb end) e),
       o as (select e ->> 'id' as id, e - 'updated_at' as r from jsonb_array_elements(case when jsonb_typeof(p_old) = 'array' then p_old else '[]'::jsonb end) e),
       touched as (select n.id, o.id is null as is_new from n left join o on o.id = n.id where o.id is null or o.r <> n.r)
  select
    (select count(*) from touched where is_new)::integer,
    (select count(*) from touched where not is_new)::integer,
    (select count(*) from o where not exists (select 1 from n where n.id = o.id))::integer,
    coalesce((select jsonb_agg(t.id order by t.id) from (select id from touched order by id limit 200) t), '[]'::jsonb)
$$;
revoke all on function public.snapshot_diff(jsonb, jsonb) from public, anon, authenticated;

-- Every review that is approved or rejected leaves a decision record behind.
create function public.record_review_decision() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_new jsonb;
  v_old jsonb;
  v_objects record;
  v_relationships record;
  v_last jsonb := new.decisions -> (jsonb_array_length(new.decisions) - 1);
  v_approved boolean := new.status = 'approved';
  v_approvals text;
  v_id text := 'adr_' || left(replace(new.id::text, '-', ''), 12);
  v_at text := to_char(coalesce(new.closed_at, now()) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_number integer;
begin
  if new.status is not distinct from old.status or new.status not in ('approved', 'rejected') then
    return null;
  end if;
  select v.snapshot into v_new from public.versions v where v.id = new.version_id;
  select v.snapshot into v_old from public.versions v where v.id = new.base_version_id;
  select * into v_objects from public.snapshot_diff(v_old -> 'objects', v_new -> 'objects');
  select * into v_relationships from public.snapshot_diff(v_old -> 'relationships', v_new -> 'relationships');
  select string_agg((d ->> 'stageName') || ': ' || public.audit_person((d ->> 'by')::uuid), '; ' order by n) into v_approvals
    from jsonb_array_elements(new.decisions) with ordinality t(d, n) where d ->> 'decision' = 'approved';
  -- One at a time per workspace, so two reviews closing together do not get the same number.
  perform 1 from public.workspaces w where w.id = new.workspace_id for update;
  select coalesce(max((r.data ->> 'number')::integer), 0) + 1 into v_number from public.decision_records r where r.workspace_id = new.workspace_id;
  insert into public.decision_records (workspace_id, id, status, data)
  values (new.workspace_id, v_id, case when v_approved then 'accepted' else 'rejected' end, jsonb_build_object(
    'id', v_id,
    'number', v_number,
    'title', new.title,
    'status', case when v_approved then 'accepted' else 'rejected' end,
    'context', new.note,
    'decision', case when v_approved then 'Approved in review. ' || coalesce(v_approvals, '') || '.'
      else format('Rejected in review at the stage "%s" by %s. Reason: %s', coalesce(v_last ->> 'stageName', ''), public.audit_person((v_last ->> 'by')::uuid), coalesce(v_last ->> 'reason', '')) end,
    'consequences', format('Objects: %s added, %s changed, %s removed. Relationships: %s added, %s changed, %s removed.',
        v_objects.added, v_objects.changed, v_objects.removed, v_relationships.added, v_relationships.changed, v_relationships.removed)
      || case when v_approved then ' The reviewed model became the published version.' else ' The published version stays as it was.' end,
    'objectIds', v_objects.ids,
    'supersededBy', null,
    'origin', 'review',
    'reviewId', new.id,
    'versionId', new.version_id,
    'author', public.audit_person(new.submitted_by),
    'decidedAt', v_at,
    'createdAt', v_at,
    'updatedAt', v_at))
  on conflict (workspace_id, id) do nothing;
  return null;
end
$$;
create trigger record_decision after update on public.reviews for each row execute function public.record_review_decision();
revoke all on function public.record_review_decision() from public, anon, authenticated;

-- The audit log records what happens to a decision record.
create function public.audit_decision_record() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_write(new.workspace_id, 'decision', new.id, new.data ->> 'title', 'created',
      jsonb_strip_nulls(jsonb_build_object('status', new.status, 'review', new.data -> 'reviewId')));
  elsif new.deleted and not old.deleted then
    perform public.audit_write(new.workspace_id, 'decision', new.id, new.data ->> 'title', 'deleted', '{}'::jsonb);
  elsif new.status <> old.status then
    perform public.audit_write(new.workspace_id, 'decision', new.id, new.data ->> 'title', new.status, jsonb_build_object('status', jsonb_build_array(old.status, new.status)));
  elsif (new.data - 'updatedAt') is distinct from (old.data - 'updatedAt') then
    perform public.audit_write(new.workspace_id, 'decision', new.id, new.data ->> 'title', 'updated', '{}'::jsonb);
  end if;
  return null;
end
$$;
create trigger audit after insert or update on public.decision_records for each row execute function public.audit_decision_record();
revoke all on function public.audit_decision_record() from public, anon, authenticated;
