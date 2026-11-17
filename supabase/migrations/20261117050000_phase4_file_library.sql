-- The file library: vendor documents, supporting files and designs, each linked to one or more
-- diagrams. A person sees the files they uploaded and the files linked to a diagram they can
-- see; nobody else's. The file itself is kept in the private storage bucket "diagram-files",
-- under <workspace>/<file>/<name>, and read through the same rule.

create table public.diagram_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  kind text not null default 'supporting' check (kind in ('vendor', 'supporting', 'design', 'other')),
  description text not null default '' check (length(description) <= 2000),
  mime text not null default '' check (length(mime) <= 200),
  size bigint not null check (size between 0 and 52428800),
  storage_path text not null unique check (storage_path like workspace_id::text || '/' || id::text || '/%'),
  uploaded_by uuid not null default auth.uid(),
  uploaded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index diagram_files_workspace on public.diagram_files (workspace_id);
create index diagram_files_uploader on public.diagram_files (uploaded_by);

create table public.diagram_file_links (
  workspace_id uuid not null,
  file_id uuid not null references public.diagram_files (id) on delete cascade,
  diagram_id text not null,
  linked_by uuid not null default auth.uid(),
  linked_at timestamptz not null default now(),
  primary key (file_id, diagram_id),
  foreign key (workspace_id, diagram_id) references public.diagrams (workspace_id, id) on delete cascade
);
create index diagram_file_links_diagram on public.diagram_file_links (workspace_id, diagram_id);

alter table public.diagram_files enable row level security;
alter table public.diagram_file_links enable row level security;

-- A diagram this person can see: a member, the diagram not deleted, and their role for its kind
-- above "no access".
create function public.diagram_visible(ws uuid, p_diagram text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.can_read(ws) and exists (
    select 1 from public.diagrams d
    where d.workspace_id = ws and d.id = p_diagram and not d.deleted
      and public.category_rank(ws, public.view_category(d.view_type)) >= 1
  )
$$;

-- The rule for seeing a file: still a member of its workspace, and either its uploader or able
-- to see a diagram it is linked to.
create function public.file_visible(p_file uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.diagram_files f
    where f.id = p_file and public.can_read(f.workspace_id)
      and (
        f.uploaded_by = (select auth.uid())
        or exists (select 1 from public.diagram_file_links l where l.file_id = f.id and public.diagram_visible(l.workspace_id, l.diagram_id))
      )
  )
$$;

-- Its uploader and the workspace's owners look after a file: its name, its links, deleting it.
create function public.file_manageable(p_file uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.diagram_files f
    where f.id = p_file and public.can_read(f.workspace_id)
      and ((f.uploaded_by = (select auth.uid()) and public.can_edit(f.workspace_id)) or public.is_owner(f.workspace_id))
  )
$$;

create policy "files: see your own and those of diagrams you can see" on public.diagram_files
  for select to authenticated using (public.file_visible(id));
create policy "files: editors upload" on public.diagram_files
  for insert to authenticated with check (uploaded_by = (select auth.uid()) and public.can_edit(workspace_id));
create policy "files: uploader or owner changes" on public.diagram_files
  for update to authenticated using (public.file_manageable(id)) with check (public.file_manageable(id));
create policy "files: uploader or owner deletes" on public.diagram_files
  for delete to authenticated using (public.file_manageable(id));

-- Only the description of a file changes after upload; where it is kept and who sent it do not.
revoke all on public.diagram_files, public.diagram_file_links from anon;
revoke update on public.diagram_files from authenticated;
grant select, insert, delete on public.diagram_files to authenticated;
grant update (name, kind, description, updated_at) on public.diagram_files to authenticated;

create policy "file links: see links to diagrams you can see" on public.diagram_file_links
  for select to authenticated using (public.file_visible(file_id) and public.diagram_visible(workspace_id, diagram_id));
create policy "file links: link to a diagram you can edit" on public.diagram_file_links
  for insert to authenticated with check (
    linked_by = (select auth.uid())
    and public.file_manageable(file_id)
    and exists (select 1 from public.diagram_files f where f.id = file_id and f.workspace_id = diagram_file_links.workspace_id)
    and public.diagram_visible(workspace_id, diagram_id)
    and public.diagram_rank(workspace_id, diagram_id) >= 3
  );
create policy "file links: uploader, owner or the diagram's editors unlink" on public.diagram_file_links
  for delete to authenticated using (
    public.file_manageable(file_id)
    or (public.diagram_visible(workspace_id, diagram_id) and public.diagram_rank(workspace_id, diagram_id) >= 3 and public.can_edit(workspace_id))
  );
grant select, insert, delete on public.diagram_file_links to authenticated;

create function public.touch_diagram_file() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
create trigger touch before update on public.diagram_files for each row execute function public.touch_diagram_file();

-- The audit log records uploads, changes, deletions and links.
create trigger audit after insert or update or delete on public.diagram_files
  for each row execute function public.audit_row('file', 'name', 'storage_path,uploaded_by,uploaded_at,mime,size');

create function public.audit_file_link() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.diagram_file_links := coalesce(new, old);
  v_file text := coalesce((select f.name from public.diagram_files f where f.id = v_row.file_id), '');
  v_diagram text := coalesce((select d.name from public.diagrams d where d.workspace_id = v_row.workspace_id and d.id = v_row.diagram_id), v_row.diagram_id);
begin
  -- A file deleted with its links was recorded once, as deleted.
  if tg_op = 'DELETE' and not exists (select 1 from public.diagram_files f where f.id = v_row.file_id) then return null; end if;
  perform public.audit_write(v_row.workspace_id, 'file', v_row.file_id::text, v_file,
    case when tg_op = 'INSERT' then 'linked to ' else 'unlinked from ' end || v_diagram);
  return null;
end
$$;
create trigger audit after insert or delete on public.diagram_file_links
  for each row execute function public.audit_file_link();

-- The bucket and its rules, where the storage schema exists (it does on Supabase).
do $storage$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit)
  values ('diagram-files', 'diagram-files', false, 52428800)
  on conflict (id) do update set public = false, file_size_limit = 52428800;

  execute $p$
    create policy "diagram files: read what you may see" on storage.objects for select to authenticated
    using (bucket_id = 'diagram-files' and exists (
      select 1 from public.diagram_files f where f.storage_path = storage.objects.name and public.file_visible(f.id)
    ))
  $p$;
  execute $p$
    create policy "diagram files: the uploader stores the file" on storage.objects for insert to authenticated
    with check (bucket_id = 'diagram-files' and exists (
      select 1 from public.diagram_files f
      where f.storage_path = storage.objects.name and f.uploaded_by = (select auth.uid()) and public.can_edit(f.workspace_id)
    ))
  $p$;
  execute $p$
    create policy "diagram files: uploader or owner removes the file" on storage.objects for delete to authenticated
    using (bucket_id = 'diagram-files' and exists (
      select 1 from public.diagram_files f where f.storage_path = storage.objects.name and public.file_manageable(f.id)
    ))
  $p$;
end
$storage$;
