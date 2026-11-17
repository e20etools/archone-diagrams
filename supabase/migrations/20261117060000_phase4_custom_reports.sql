-- ArchONE Diagrams, phase 4: reports a workspace makes for itself.
--
--  * One row per report, the definition (subject, columns, filters, grouping) in "data". The
--    report itself is worked out from the model in the browser, so it is always current.
--  * Owners and editors make, change and delete reports; every member can run them.
--  * Versions and scenarios do not hold reports: they belong to the workspace as it is.

create table public.custom_reports (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 80),
  data jsonb not null check (
    jsonb_typeof(data) = 'object' and data ->> 'id' = id
    and data ->> 'subject' in ('components', 'connections', 'diagrams')
    and jsonb_typeof(data -> 'columns') = 'array' and jsonb_array_length(data -> 'columns') between 1 and 20
    and char_length(coalesce(data ->> 'name', '')) between 1 and 120
    and pg_column_size(data) <= 20000
  ),
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create trigger stamp_change before insert or update on public.custom_reports for each row execute function public.stamp_change();

create function public.limit_custom_reports() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (select count(*) from public.custom_reports r where r.workspace_id = new.workspace_id and not r.deleted) >= 200 then
    raise exception 'This workspace already has 200 reports of its own. Delete one first.' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger limit_reports before insert on public.custom_reports for each row execute function public.limit_custom_reports();

revoke all on public.custom_reports from anon, authenticated;
grant select, insert, update on public.custom_reports to authenticated;
alter table public.custom_reports enable row level security;
create policy "members read reports" on public.custom_reports for select to authenticated using (public.can_read(workspace_id));
create policy "editors add reports" on public.custom_reports for insert to authenticated with check (public.can_edit(workspace_id));
create policy "editors change reports" on public.custom_reports for update to authenticated using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));

alter publication supabase_realtime add table public.custom_reports;

create function public.audit_custom_report() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or (old.deleted and not new.deleted) then
    perform public.audit_write(new.workspace_id, 'report', new.id, new.data ->> 'name', 'created', jsonb_build_object('subject', new.data -> 'subject'));
  elsif new.deleted and not old.deleted then
    perform public.audit_write(new.workspace_id, 'report', new.id, new.data ->> 'name', 'deleted', '{}'::jsonb);
  elsif (new.data - 'updatedAt') is distinct from (old.data - 'updatedAt') then
    perform public.audit_write(new.workspace_id, 'report', new.id, new.data ->> 'name', 'updated', '{}'::jsonb);
  end if;
  return null;
end
$$;
create trigger audit after insert or update on public.custom_reports for each row execute function public.audit_custom_report();

revoke all on function public.limit_custom_reports(), public.audit_custom_report() from public, anon, authenticated;
