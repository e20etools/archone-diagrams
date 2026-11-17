-- ArchONE Diagrams, phase 4: a decided record can still gain the issues made from it.
-- Jira issues and Azure DevOps work items created to follow a decision up are listed on it
-- ("issues"); adding one does not change what was decided.

create or replace function public.guard_decision_record() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_open constant text[] := array['status', 'supersededBy', 'objectIds', 'issues', 'updatedAt'];
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
