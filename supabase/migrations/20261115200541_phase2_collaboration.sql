-- ArchONE Diagrams, phase 2 collaboration: comments, versions, and review before publishing.
--
-- Comments   Owners, editors and commenters write them; every member reads them.
-- Versions   A version is a frozen copy of the whole model, taken by the database itself.
-- Review     When an owner switches review on, the model editors work on becomes a draft.
--            An editor submits it; each stage's named reviewer approves (with the stage's
--            checklist ticked) or rejects with a reason. After the last stage the submitted
--            version becomes the published one. Members who cannot edit then read only the
--            published version: the access rules below stop them reading the working rows.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

alter table public.workspaces
  add column review_required boolean not null default false,
  -- [{ "id": text, "name": text, "reviewerId": uuid as text, "checklist": [text] }], written by set_review_settings()
  add column review_stages jsonb not null default '[]',
  add column published_version_id uuid;

create table public.versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  note text not null default '' check (char_length(note) <= 2000),
  -- manual: saved by a person. review: submitted for review. baseline: taken when review was
  -- switched on. safety: taken just before a revert, so the revert itself can be taken back.
  kind text not null default 'manual' check (kind in ('manual', 'review', 'baseline', 'safety')),
  -- { "objects": [row], "relationships": [row], "diagrams": [row], "nodes": [row] } in the columns of the model tables
  snapshot jsonb not null,
  object_count integer not null,
  relationship_count integer not null,
  diagram_count integer not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index versions_workspace on public.versions (workspace_id, created_at desc);

alter table public.workspaces
  add constraint workspaces_published_version foreign key (published_version_id) references public.versions (id) on delete set null;

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  version_id uuid not null references public.versions (id),
  -- What was published when this was submitted, to compare against.
  base_version_id uuid references public.versions (id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  note text not null default '' check (char_length(note) <= 2000),
  status text not null default 'open' check (status in ('open', 'approved', 'rejected', 'withdrawn')),
  -- The stages as they were at submission; later changes to the settings do not move the goalposts.
  stages jsonb not null,
  stage_index integer not null default 0,
  -- [{ "stageId", "stageName", "by", "decision": approved | rejected | delegated, "reason", "checklist": [bool], "to", "at" }]
  decisions jsonb not null default '[]',
  submitted_by uuid references auth.users (id) on delete set null,
  submitted_at timestamptz not null default now(),
  closed_at timestamptz
);
create index reviews_workspace on public.reviews (workspace_id, submitted_at desc);
create unique index reviews_one_open on public.reviews (workspace_id) where status = 'open';

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- The diagram the comment was written on, and the box, arrow or diagram it is about.
  diagram_id text check (char_length(diagram_id) <= 64),
  target_kind text not null check (target_kind in ('diagram', 'object', 'relationship')),
  target_id text not null check (char_length(target_id) between 1 and 64),
  -- Replies point at the first comment of their thread.
  parent_id uuid references public.comments (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  mentions uuid[] not null default '{}' check (cardinality(mentions) <= 20),
  resolved boolean not null default false,
  resolved_by uuid,
  author_id uuid,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  -- Marked rather than removed, for the same reason as the model rows.
  deleted boolean not null default false,
  changed_at timestamptz not null default now()
);
create index comments_workspace on public.comments (workspace_id, created_at);

-- ---------------------------------------------------------------------------
-- Who may do what
-- ---------------------------------------------------------------------------

create function public.can_comment(ws uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(public.member_role(ws) in ('owner', 'editor', 'commenter'), false) $$;

-- The working model: editors always; everyone else only while review is not required.
create function public.can_read_model(ws uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when public.can_edit(ws) then true
    when public.can_read(ws) then not coalesce((select w.review_required from public.workspaces w where w.id = ws), false)
    else false
  end
$$;

-- A version: editors see all of them. Other members see all while review is not required;
-- once it is, only the published version and one they have been asked to review.
create function public.version_visible(p_workspace uuid, p_version uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when public.can_edit(p_workspace) then true
    when not public.can_read(p_workspace) then false
    when not coalesce((select w.review_required from public.workspaces w where w.id = p_workspace), false) then true
    else exists (select 1 from public.workspaces w where w.id = p_workspace and w.published_version_id = p_version)
      or exists (
        select 1 from public.reviews r
        where r.workspace_id = p_workspace and r.version_id = p_version and r.status = 'open'
          and (r.stages -> r.stage_index ->> 'reviewerId') = (select auth.uid())::text
      )
  end
$$;

-- ---------------------------------------------------------------------------
-- Versions
-- ---------------------------------------------------------------------------

-- Copies the model as it is saved right now. Internal: callers check access first.
create function public.take_snapshot(p_workspace uuid, p_name text, p_note text, p_kind text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_objects jsonb;
  v_relationships jsonb;
  v_diagrams jsonb;
  v_nodes jsonb;
  v_id uuid;
begin
  if (select count(*) from public.versions v where v.workspace_id = p_workspace) >= 200 then
    raise exception 'This workspace already holds 200 versions. Delete some old ones first.' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(t) - 'workspace_id' - 'deleted' - 'changed_at' - 'changed_by' order by t.id), '[]'::jsonb)
    into v_objects from public.objects t where t.workspace_id = p_workspace and not t.deleted;
  select coalesce(jsonb_agg(to_jsonb(t) - 'workspace_id' - 'deleted' - 'changed_at' - 'changed_by' order by t.id), '[]'::jsonb)
    into v_relationships from public.relationships t where t.workspace_id = p_workspace and not t.deleted;
  select coalesce(jsonb_agg(to_jsonb(t) - 'workspace_id' - 'deleted' - 'changed_at' - 'changed_by' order by t.id), '[]'::jsonb)
    into v_diagrams from public.diagrams t where t.workspace_id = p_workspace and not t.deleted;
  select coalesce(jsonb_agg(to_jsonb(t) - 'workspace_id' - 'deleted' - 'changed_at' - 'changed_by' order by t.diagram_id, t.object_id), '[]'::jsonb)
    into v_nodes from public.diagram_nodes t where t.workspace_id = p_workspace and not t.deleted;
  insert into public.versions (workspace_id, name, note, kind, snapshot, object_count, relationship_count, diagram_count, created_by)
  values (
    p_workspace, btrim(p_name), btrim(coalesce(p_note, '')), p_kind,
    jsonb_build_object('objects', v_objects, 'relationships', v_relationships, 'diagrams', v_diagrams, 'nodes', v_nodes),
    jsonb_array_length(v_objects), jsonb_array_length(v_relationships), jsonb_array_length(v_diagrams),
    auth.uid()
  )
  returning id into v_id;
  return v_id;
end
$$;

create function public.save_version(p_workspace uuid, p_name text, p_note text default '', p_safety boolean default false) returns uuid
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.can_edit(p_workspace) then
    raise exception 'Only owners and editors can save a version.' using errcode = '42501';
  end if;
  return public.take_snapshot(p_workspace, p_name, p_note, case when p_safety then 'safety' else 'manual' end);
end
$$;

-- ---------------------------------------------------------------------------
-- Review before publishing
-- ---------------------------------------------------------------------------

create function public.set_review_settings(p_workspace uuid, p_required boolean, p_stages jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_stage jsonb;
  v_list jsonb;
  v_clean jsonb := '[]'::jsonb;
  v_version uuid;
begin
  if not public.is_owner(p_workspace) then
    raise exception 'Only an owner can change the review settings.' using errcode = '42501';
  end if;
  if p_stages is null or jsonb_typeof(p_stages) <> 'array' or jsonb_array_length(p_stages) > 5 then
    raise exception 'A review has at most 5 stages.' using errcode = 'P0001';
  end if;
  for v_stage in select * from jsonb_array_elements(p_stages) loop
    if char_length(btrim(coalesce(v_stage ->> 'name', ''))) not between 1 and 80 then
      raise exception 'Give every stage a name of up to 80 characters.' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.workspace_members m
      where m.workspace_id = p_workspace and m.user_id::text = (v_stage ->> 'reviewerId')
    ) then
      raise exception 'Choose a member of this workspace as the reviewer of every stage.' using errcode = 'P0001';
    end if;
    v_list := coalesce(v_stage -> 'checklist', '[]'::jsonb);
    if jsonb_typeof(v_list) <> 'array' or jsonb_array_length(v_list) > 20 or exists (
      select 1 from jsonb_array_elements(v_list) e
      where jsonb_typeof(e) <> 'string' or char_length(btrim(e #>> '{}')) not between 1 and 200
    ) then
      raise exception 'A checklist has at most 20 items of up to 200 characters each.' using errcode = 'P0001';
    end if;
    v_clean := v_clean || jsonb_build_array(jsonb_build_object(
      'id', coalesce(nullif(left(v_stage ->> 'id', 40), ''), gen_random_uuid()::text),
      'name', btrim(v_stage ->> 'name'),
      'reviewerId', v_stage ->> 'reviewerId',
      'checklist', v_list
    ));
  end loop;
  if p_required and jsonb_array_length(v_clean) = 0 then
    raise exception 'Add at least one review stage before switching review on.' using errcode = 'P0001';
  end if;
  update public.workspaces w set review_required = p_required, review_stages = v_clean where w.id = p_workspace;
  -- Readers keep seeing what they saw a moment ago: the current model becomes the first published version.
  if p_required and (select w.published_version_id from public.workspaces w where w.id = p_workspace) is null then
    v_version := public.take_snapshot(p_workspace, 'Baseline', 'The model as it was when review was switched on.', 'baseline');
    update public.workspaces w set published_version_id = v_version where w.id = p_workspace;
  end if;
end
$$;

create function public.submit_review(p_workspace uuid, p_title text, p_note text default '') returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_workspace public.workspaces;
  v_version uuid;
  v_id uuid;
begin
  if not public.can_edit(p_workspace) then
    raise exception 'Only owners and editors can submit the model for review.' using errcode = '42501';
  end if;
  select * into v_workspace from public.workspaces w where w.id = p_workspace for update;
  if not v_workspace.review_required or jsonb_array_length(v_workspace.review_stages) = 0 then
    raise exception 'Review before publishing is switched off for this workspace.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.reviews r where r.workspace_id = p_workspace and r.status = 'open') then
    raise exception 'A review is already open. Finish or withdraw it first.' using errcode = 'P0001';
  end if;
  v_version := public.take_snapshot(p_workspace, p_title, p_note, 'review');
  insert into public.reviews (workspace_id, version_id, base_version_id, title, note, stages, submitted_by)
  values (p_workspace, v_version, v_workspace.published_version_id, btrim(p_title), btrim(coalesce(p_note, '')), v_workspace.review_stages, auth.uid())
  returning id into v_id;
  return v_id;
end
$$;

create function public.decide_review(p_review uuid, p_approve boolean, p_reason text default '', p_checklist jsonb default '[]') returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_review public.reviews;
  v_stage jsonb;
  v_decision jsonb;
  v_status text := 'open';
begin
  select * into v_review from public.reviews r where r.id = p_review for update;
  if not found or not public.can_read(v_review.workspace_id) then
    raise exception 'This review no longer exists.' using errcode = 'P0002';
  end if;
  if v_review.status <> 'open' then
    raise exception 'This review is already closed.' using errcode = 'P0001';
  end if;
  v_stage := v_review.stages -> v_review.stage_index;
  if (v_stage ->> 'reviewerId') is distinct from auth.uid()::text then
    raise exception 'This stage is waiting for someone else.' using errcode = '42501';
  end if;
  if p_approve then
    if p_checklist is null or jsonb_typeof(p_checklist) <> 'array'
       or jsonb_array_length(p_checklist) <> jsonb_array_length(v_stage -> 'checklist')
       or exists (select 1 from jsonb_array_elements(p_checklist) e where e <> 'true'::jsonb) then
      raise exception 'Tick every item on the checklist before approving.' using errcode = 'P0001';
    end if;
  elsif char_length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Give the reason for rejecting.' using errcode = 'P0001';
  end if;
  v_decision := jsonb_build_object(
    'stageId', v_stage ->> 'id',
    'stageName', v_stage ->> 'name',
    'by', auth.uid(),
    'decision', case when p_approve then 'approved' else 'rejected' end,
    'reason', left(btrim(coalesce(p_reason, '')), 2000),
    'checklist', coalesce(p_checklist, '[]'::jsonb),
    'at', now()
  );
  if not p_approve then
    v_status := 'rejected';
    update public.reviews r set status = 'rejected', decisions = r.decisions || jsonb_build_array(v_decision), closed_at = now() where r.id = p_review;
  elsif v_review.stage_index + 1 >= jsonb_array_length(v_review.stages) then
    v_status := 'approved';
    update public.reviews r set status = 'approved', decisions = r.decisions || jsonb_build_array(v_decision), closed_at = now() where r.id = p_review;
    update public.workspaces w set published_version_id = v_review.version_id where w.id = v_review.workspace_id;
  else
    update public.reviews r set stage_index = r.stage_index + 1, decisions = r.decisions || jsonb_build_array(v_decision) where r.id = p_review;
  end if;
  return v_status;
end
$$;

-- The stage's reviewer hands it to another member. An owner can reassign it too, for a reviewer who is away.
create function public.delegate_review(p_review uuid, p_to uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_review public.reviews;
  v_stage jsonb;
begin
  select * into v_review from public.reviews r where r.id = p_review for update;
  if not found or not public.can_read(v_review.workspace_id) then
    raise exception 'This review no longer exists.' using errcode = 'P0002';
  end if;
  if v_review.status <> 'open' then
    raise exception 'This review is already closed.' using errcode = 'P0001';
  end if;
  v_stage := v_review.stages -> v_review.stage_index;
  if (v_stage ->> 'reviewerId') is distinct from auth.uid()::text and not public.is_owner(v_review.workspace_id) then
    raise exception 'Only this stage''s reviewer or an owner can hand it to someone else.' using errcode = '42501';
  end if;
  if p_to::text = (v_stage ->> 'reviewerId') or not exists (
    select 1 from public.workspace_members m where m.workspace_id = v_review.workspace_id and m.user_id = p_to
  ) then
    raise exception 'Choose another member of this workspace.' using errcode = 'P0001';
  end if;
  update public.reviews r
  set stages = jsonb_set(r.stages, array[r.stage_index::text, 'reviewerId'], to_jsonb(p_to::text)),
      decisions = r.decisions || jsonb_build_array(jsonb_build_object(
        'stageId', v_stage ->> 'id', 'stageName', v_stage ->> 'name', 'by', auth.uid(),
        'decision', 'delegated', 'reason', '', 'checklist', '[]'::jsonb, 'to', p_to, 'at', now()
      ))
  where r.id = p_review;
end
$$;

create function public.withdraw_review(p_review uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_review public.reviews;
begin
  select * into v_review from public.reviews r where r.id = p_review for update;
  if not found or not public.can_read(v_review.workspace_id) then
    raise exception 'This review no longer exists.' using errcode = 'P0002';
  end if;
  if v_review.status <> 'open' then
    raise exception 'This review is already closed.' using errcode = 'P0001';
  end if;
  if v_review.submitted_by is distinct from auth.uid() and not public.is_owner(v_review.workspace_id) then
    raise exception 'Only the person who submitted it or an owner can withdraw a review.' using errcode = '42501';
  end if;
  update public.reviews r set status = 'withdrawn', closed_at = now() where r.id = p_review;
end
$$;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

create function public.guard_comment() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_parent public.comments;
begin
  if tg_op = 'INSERT' then
    new.author_id := auth.uid();
    new.created_at := now();
    new.edited_at := null;
    new.resolved := false;
    new.resolved_by := null;
    new.deleted := false;
    if new.parent_id is not null then
      select * into v_parent from public.comments c where c.id = new.parent_id;
      if not found or v_parent.workspace_id <> new.workspace_id or v_parent.parent_id is not null or v_parent.deleted then
        raise exception 'That comment thread no longer exists.' using errcode = 'P0002';
      end if;
      new.diagram_id := v_parent.diagram_id;
      new.target_kind := v_parent.target_kind;
      new.target_id := v_parent.target_id;
    end if;
  else
    if new.body is distinct from old.body or new.mentions is distinct from old.mentions then
      if old.author_id is distinct from auth.uid() then
        raise exception 'Only its author can change a comment.' using errcode = '42501';
      end if;
      new.edited_at := now();
    end if;
    if new.deleted is distinct from old.deleted and old.author_id is distinct from auth.uid() and not public.is_owner(old.workspace_id) then
      raise exception 'Only its author or an owner can delete a comment.' using errcode = '42501';
    end if;
    if new.resolved is distinct from old.resolved then
      new.resolved_by := case when new.resolved then auth.uid() end;
    end if;
  end if;
  new.changed_at := now();
  return new;
end
$$;

create trigger guard_comment
  before insert or update on public.comments
  for each row execute function public.guard_comment();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on public.versions, public.reviews, public.comments from anon, authenticated;

revoke execute on function
  public.can_comment(uuid), public.can_read_model(uuid), public.version_visible(uuid, uuid),
  public.take_snapshot(uuid, text, text, text), public.save_version(uuid, text, text, boolean),
  public.set_review_settings(uuid, boolean, jsonb), public.submit_review(uuid, text, text),
  public.decide_review(uuid, boolean, text, jsonb), public.delegate_review(uuid, uuid),
  public.withdraw_review(uuid), public.guard_comment()
from public, anon, authenticated;

-- Versions and reviews are written only through the functions above.
grant select, delete on public.versions to authenticated;
grant select on public.reviews to authenticated;
grant select, insert on public.comments to authenticated;
grant update (body, mentions, resolved, deleted) on public.comments to authenticated;

-- take_snapshot() stays internal: it is reached only through the functions that check access.
grant execute on function
  public.can_comment(uuid), public.can_read_model(uuid), public.version_visible(uuid, uuid),
  public.save_version(uuid, text, text, boolean),
  public.set_review_settings(uuid, boolean, jsonb), public.submit_review(uuid, text, text),
  public.decide_review(uuid, boolean, text, jsonb), public.delegate_review(uuid, uuid),
  public.withdraw_review(uuid), public.guard_comment()
to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.versions enable row level security;
alter table public.reviews enable row level security;
alter table public.comments enable row level security;

-- The working model is now read through can_read_model().
drop policy "members read objects" on public.objects;
drop policy "members read relationships" on public.relationships;
drop policy "members read diagrams" on public.diagrams;
drop policy "members read diagram nodes" on public.diagram_nodes;
drop policy "members read proposals" on public.proposals;
create policy "readers of the working model read objects" on public.objects for select to authenticated using (public.can_read_model(workspace_id));
create policy "readers of the working model read relationships" on public.relationships for select to authenticated using (public.can_read_model(workspace_id));
create policy "readers of the working model read diagrams" on public.diagrams for select to authenticated using (public.can_read_model(workspace_id));
create policy "readers of the working model read diagram nodes" on public.diagram_nodes for select to authenticated using (public.can_read_model(workspace_id));
create policy "readers of the working model read proposals" on public.proposals for select to authenticated using (public.can_read_model(workspace_id));

create policy "members read the versions they may see" on public.versions
  for select to authenticated using (public.version_visible(workspace_id, id));
-- A version that was reviewed, or is the published one, is part of the record and stays.
create policy "owners delete versions that are not part of a review" on public.versions
  for delete to authenticated using (
    public.is_owner(workspace_id)
    and not exists (select 1 from public.reviews r where r.version_id = versions.id)
    and not exists (select 1 from public.workspaces w where w.published_version_id = versions.id)
  );

create policy "members read reviews" on public.reviews
  for select to authenticated using (public.can_read(workspace_id));

create policy "members read comments" on public.comments
  for select to authenticated using (public.can_read(workspace_id));
create policy "commenters write comments" on public.comments
  for insert to authenticated with check (public.can_comment(workspace_id));
-- guard_comment() narrows this: the text to its author, deleting to the author or an owner.
create policy "commenters change comments" on public.comments
  for update to authenticated using (public.can_comment(workspace_id)) with check (public.can_comment(workspace_id));

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.comments, public.reviews, public.workspaces;
