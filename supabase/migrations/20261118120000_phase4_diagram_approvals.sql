-- ArchONE Diagrams, phase 4: approving a diagram before it goes out, its information box, and verified copies.
--
--  * A diagram knows who made it (set here, not by the app) and keeps the settings of its information
--    box: shown or not, its corner, the fields its owner hid, and a company name and logo of its own.
--    A workspace's branding holds the company every diagram starts with, and can make the box, or
--    some of its fields, compulsory.
--  * Owners name who approves diagrams for Enterprise Architecture (ea) and for Cybersecurity
--    (security), and can make that approval compulsory before a diagram is published.
--  * An editor sends a diagram for approval. Each role approves it (after changing it, if the approver
--    wants), returns it to the sender with notes to fix and send again, or rejects it. Once both roles
--    have approved the diagram as it is, it becomes a new version: its number goes up and the approved
--    picture is kept. Every decision is bound to the fingerprint of what was approved: a hash, worked
--    out here, of the diagram, its boxes and where they are, and the objects and relationships it
--    draws. Any change afterwards no longer matches, so the app and every copy say so, and the next
--    version needs approving again. Decisions are only added, never changed or removed, and each is
--    in the audit log.
--  * While approval is compulsory, only an approved version leaves the workspace: live links show
--    the last approved version, and a verified copy can only be made of it.
--  * A verified copy freezes a diagram with its information box behind an unguessable link that
--    anyone may open without signing in, until it expires or is switched off. Its page says whether
--    the copy is genuine, approved and still current, and checks a file against the files exported
--    with it.

-- ---------------------------------------------------------------------------
-- Who made a diagram, and its information box
-- ---------------------------------------------------------------------------

alter table public.diagrams add column created_by uuid;
alter table public.diagrams add column title_block jsonb check (
  title_block is null or (
    jsonb_typeof(title_block) = 'object'
    and coalesce(title_block ->> 'corner', 'bottom-right') in ('bottom-right', 'bottom-left', 'top-right', 'top-left')
    and char_length(coalesce(title_block ->> 'company', '')) <= 120
    and char_length(coalesce(title_block ->> 'logo', '')) <= 300000
    and (coalesce(title_block ->> 'logo', '') = '' or title_block ->> 'logo' ~ '^data:image/(png|jpeg|webp|svg\+xml|gif);base64,')
    and (title_block -> 'hidden' is null or (jsonb_typeof(title_block -> 'hidden') = 'array' and jsonb_array_length(title_block -> 'hidden') <= 20))
  )
);

-- Diagrams made before this were recorded in the audit log. Filling that in is not a change to
-- the diagram, so it does not move when it was last changed or tell the webhooks.
alter table public.diagrams disable trigger stamp_change;
alter table public.diagrams disable trigger webhooks_on_update;
update public.diagrams d set created_by = a.actor_id
from (
  select distinct on (l.workspace_id, l.entity_id) l.workspace_id, l.entity_id, l.actor_id
  from public.audit_log l where l.entity = 'diagram' and l.action = 'created' and l.actor_id is not null
  order by l.workspace_id, l.entity_id, l.id
) a
where a.workspace_id = d.workspace_id and a.entity_id = d.id and d.created_by is null;
alter table public.diagrams enable trigger webhooks_on_update;
alter table public.diagrams enable trigger stamp_change;

-- Whoever adds a diagram is its maker; nobody changes that afterwards.
create function public.keep_diagram_creator() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_by := old.created_by;
  end if;
  return new;
end
$$;
create trigger keep_creator before insert or update on public.diagrams for each row execute function public.keep_diagram_creator();

-- The box's settings are recorded in short; its logo is not copied into the audit log.
drop trigger audit on public.diagrams;
create trigger audit after insert or update or delete on public.diagrams for each row execute function public.audit_row('diagram', 'name', 'title_block');
create function public.audit_title_block() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.title_block is distinct from old.title_block and not new.deleted then
    perform public.audit_write(new.workspace_id, 'diagram', new.id, new.name, 'information box changed', jsonb_build_object(
      'shown', coalesce((new.title_block ->> 'show')::boolean, false), 'corner', new.title_block ->> 'corner',
      'company', coalesce(new.title_block ->> 'company', ''), 'logo', coalesce(new.title_block ->> 'logo', '') <> '',
      'hidden', coalesce(new.title_block -> 'hidden', '[]'::jsonb)));
  end if;
  return null;
end
$$;
create trigger audit_title_block after update of title_block on public.diagrams for each row execute function public.audit_title_block();

-- The company every box starts with, and what a box must show.
alter table public.workspace_branding add constraint workspace_branding_company_check check (
  char_length(coalesce(data ->> 'company', '')) <= 120
  and char_length(coalesce(data ->> 'companyLogo', '')) <= 300000
  and (coalesce(data ->> 'companyLogo', '') = '' or data ->> 'companyLogo' ~ '^data:image/(png|jpeg|webp|svg\+xml|gif);base64,')
  and (data -> 'boxFields' is null or (jsonb_typeof(data -> 'boxFields') = 'array' and jsonb_array_length(data -> 'boxFields') <= 20))
);

-- ---------------------------------------------------------------------------
-- What a diagram shows: its fingerprint, and the picture of it a viewer draws
-- ---------------------------------------------------------------------------

-- What the diagram shows, as one hash: its settings, its boxes and where they are (to the pixel),
-- the objects in them and the relationships it draws. Times, who changed what and the information
-- box are left out, so the hash moves only when the picture or what it says moves.
create function public.diagram_fingerprint(p_ws uuid, p_diagram text) returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_diagram public.diagrams;
  v_ids text[];
  v_content jsonb;
begin
  select * into v_diagram from public.diagrams d where d.workspace_id = p_ws and d.id = p_diagram and not d.deleted;
  if not found then
    return null;
  end if;
  select coalesce(array_agg(n.object_id), '{}') into v_ids from public.diagram_nodes n where n.workspace_id = p_ws and n.diagram_id = p_diagram and not n.deleted;
  v_content := jsonb_build_object(
    'diagram', to_jsonb(v_diagram) - array['workspace_id', 'changed_by', 'changed_at', 'created_at', 'updated_at', 'deleted', 'created_by', 'title_block', 'archive'],
    'nodes', coalesce((select jsonb_agg(jsonb_build_array(n.object_id, round(n.x)::integer, round(n.y)::integer) order by n.object_id)
      from public.diagram_nodes n where n.workspace_id = p_ws and n.diagram_id = p_diagram and not n.deleted), '[]'::jsonb),
    'objects', coalesce((select jsonb_agg(to_jsonb(o) - array['workspace_id', 'changed_by', 'changed_at', 'created_at', 'updated_at', 'deleted', 'provenance', 'links'] order by o.id)
      from public.objects o where o.workspace_id = p_ws and not o.deleted and (o.id = any (v_ids) or o.id = v_diagram.scope_id)), '[]'::jsonb),
    'relationships', coalesce((select jsonb_agg(to_jsonb(r) - array['workspace_id', 'changed_by', 'changed_at', 'created_at', 'updated_at', 'deleted', 'provenance', 'links'] order by r.id)
      from public.relationships r where r.workspace_id = p_ws and not r.deleted and r.source_id = any (v_ids) and r.target_id = any (v_ids)
        and not r.id = any (coalesce(v_diagram.hidden_relationship_ids, '{}'))), '[]'::jsonb)
  );
  return encode(sha256(convert_to(v_content::text, 'UTF8')), 'hex');
end
$$;

-- The working model a viewer needs for one diagram, in the shape of a stored version.
create function public.diagram_source(p_ws uuid, p_diagram text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'objects', coalesce((select jsonb_agg(to_jsonb(o) - 'workspace_id' - 'changed_by') from public.objects o where o.workspace_id = p_ws and not o.deleted), '[]'::jsonb),
    'relationships', coalesce((select jsonb_agg(to_jsonb(r) - 'workspace_id' - 'changed_by') from public.relationships r where r.workspace_id = p_ws and not r.deleted), '[]'::jsonb),
    'diagrams', coalesce((select jsonb_agg(to_jsonb(d) - 'workspace_id' - 'changed_by' - 'created_by' - 'title_block') from public.diagrams d where d.workspace_id = p_ws and d.id = p_diagram and not d.deleted), '[]'::jsonb),
    'nodes', coalesce((select jsonb_agg(to_jsonb(n) - 'workspace_id' - 'changed_by') from public.diagram_nodes n where n.workspace_id = p_ws and n.diagram_id = p_diagram and not n.deleted), '[]'::jsonb)
  )
$$;

-- What a viewer of one diagram is given from a source: the diagram, its boxes, the objects it shows
-- (with bare ids for what is nested inside them) and the relationships between them, without the
-- links to repositories and dashboards. Null when the source has no such diagram.
create function public.diagram_view_from(p_source jsonb, p_diagram text) returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  v_diagram jsonb;
  v_nodes jsonb;
  v_objects jsonb;
  v_relationships jsonb;
begin
  select d - 'created_by' - 'title_block' into v_diagram from jsonb_array_elements(p_source -> 'diagrams') d where d ->> 'id' = p_diagram;
  if v_diagram is null then
    return null;
  end if;
  select coalesce(jsonb_agg(n), '[]'::jsonb) into v_nodes from jsonb_array_elements(p_source -> 'nodes') n where n ->> 'diagram_id' = p_diagram;
  with recursive every as (
    select o ->> 'id' as id, o ->> 'parent_id' as parent_id, o as obj from jsonb_array_elements(p_source -> 'objects') o
  ), shown as (
    select e.id from every e where e.id in (select n ->> 'object_id' from jsonb_array_elements(v_nodes) n) or e.id = v_diagram ->> 'scope_id'
  ), inside as (
    select s.id, true as visible from shown s
    union
    select e.id, false from every e join inside i on e.parent_id = i.id
  ), wanted as (
    select i.id, bool_or(i.visible) as visible from inside i group by i.id
  )
  select
    coalesce((select jsonb_agg(case when w.visible
        then jsonb_set(e.obj - 'links', '{provenance}', jsonb_build_object('origin', coalesce(e.obj -> 'provenance' ->> 'origin', 'manual')))
        else jsonb_build_object('id', e.id, 'parent_id', e.parent_id, 'type_id', e.obj ->> 'type_id', 'name', '', 'created_at', e.obj ->> 'created_at', 'updated_at', e.obj ->> 'updated_at')
      end) from every e join wanted w on w.id = e.id), '[]'::jsonb),
    coalesce((select jsonb_agg(case when ws.visible and wt.visible
        then jsonb_set(r - 'links', '{provenance}', jsonb_build_object('origin', coalesce(r -> 'provenance' ->> 'origin', 'manual')))
        else jsonb_build_object('id', r ->> 'id', 'source_id', r ->> 'source_id', 'target_id', r ->> 'target_id', 'kind', r ->> 'kind', 'label', '', 'created_at', r ->> 'created_at', 'updated_at', r ->> 'updated_at')
      end)
      from jsonb_array_elements(p_source -> 'relationships') r
      join wanted ws on ws.id = r ->> 'source_id'
      join wanted wt on wt.id = r ->> 'target_id'), '[]'::jsonb)
  into v_objects, v_relationships;
  return jsonb_build_object('diagram', v_diagram, 'nodes', v_nodes, 'objects', v_objects, 'relationships', v_relationships);
end
$$;

create function public.person_name(p_user uuid) returns text
language sql stable security definer set search_path = ''
as $$ select coalesce((select coalesce(nullif(btrim(p.display_name), ''), p.email) from public.profiles p where p.id = p_user), '') $$;

-- ---------------------------------------------------------------------------
-- Approvers, and whether approval is compulsory
-- ---------------------------------------------------------------------------

alter table public.workspaces add column diagram_approval boolean not null default false;

create table public.approval_roles (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  role text not null check (role in ('ea', 'security')),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (workspace_id, role, user_id)
);
revoke all on public.approval_roles from anon, authenticated;
alter table public.approval_roles enable row level security;

-- Who approves for a role: members of the workspace who were named for it, by name.
create function public.approvers_of(p_ws uuid, p_role text) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.user_id, 'name', public.person_name(a.user_id)) order by lower(public.person_name(a.user_id)), a.user_id), '[]'::jsonb)
  from public.approval_roles a join public.workspace_members m on m.workspace_id = a.workspace_id and m.user_id = a.user_id
  where a.workspace_id = p_ws and a.role = p_role
$$;

create function public.is_approver(p_ws uuid, p_role text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.approval_roles a join public.workspace_members m on m.workspace_id = a.workspace_id and m.user_id = a.user_id
    where a.workspace_id = p_ws and a.role = p_role and a.user_id = auth.uid())
$$;

create function public.diagram_approval_settings(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.can_read(p_workspace) then
    raise exception 'Not a member of this workspace.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'required', coalesce((select w.diagram_approval from public.workspaces w where w.id = p_workspace), false),
    'ea', public.approvers_of(p_workspace, 'ea'),
    'security', public.approvers_of(p_workspace, 'security')
  );
end
$$;

-- Owners name the approvers of both roles (the lists replace the old ones) and say whether a diagram
-- needs their approval before it is published. Compulsory approval needs someone in each role.
create function public.set_diagram_approval(p_workspace uuid, p_required boolean, p_ea uuid[], p_security uuid[]) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_role text;
  v_users uuid[];
begin
  if not public.is_owner(p_workspace) then
    raise exception 'Only an owner can choose who approves diagrams.' using errcode = '42501';
  end if;
  foreach v_role in array array['ea', 'security'] loop
    v_users := coalesce(case v_role when 'ea' then p_ea else p_security end, '{}');
    if cardinality(v_users) > 20 then
      raise exception 'A role can have at most 20 approvers.' using errcode = 'P0001';
    end if;
    if exists (select 1 from unnest(v_users) u where not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = u)) then
      raise exception 'Every approver has to be a member of the workspace.' using errcode = 'P0001';
    end if;
    if p_required and cardinality(v_users) = 0 then
      raise exception 'Name at least one Enterprise Architecture and one Cybersecurity approver before making approval compulsory.' using errcode = 'P0001';
    end if;
    delete from public.approval_roles a where a.workspace_id = p_workspace and a.role = v_role and not a.user_id = any (v_users);
    insert into public.approval_roles (workspace_id, role, user_id) select p_workspace, v_role, u from unnest(v_users) u on conflict do nothing;
  end loop;
  update public.workspaces w set diagram_approval = coalesce(p_required, false) where w.id = p_workspace;
  perform public.audit_write(p_workspace, 'workspace', p_workspace::text, '', 'diagram approval set', jsonb_build_object(
    'compulsory', coalesce(p_required, false),
    'ea', (select coalesce(jsonb_agg(public.person_name(u)), '[]'::jsonb) from unnest(coalesce(p_ea, '{}')) u),
    'security', (select coalesce(jsonb_agg(public.person_name(u)), '[]'::jsonb) from unnest(coalesce(p_security, '{}')) u)));
  return public.diagram_approval_settings(p_workspace);
end
$$;

-- ---------------------------------------------------------------------------
-- Requests for approval and what each role decided
-- ---------------------------------------------------------------------------

create table public.diagram_approval_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  diagram_id text not null,
  -- The version the diagram becomes once both roles approve it.
  version integer not null check (version >= 1),
  status text not null default 'pending' check (status in ('pending', 'returned', 'approved', 'rejected', 'withdrawn')),
  -- How many times it was sent: once, and once more after every return.
  round integer not null default 1,
  note text not null default '' check (char_length(note) <= 2000),
  -- The fingerprint when it was last sent.
  fingerprint text not null,
  approved_fingerprint text,
  requested_by uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create unique index diagram_approval_requests_one_open on public.diagram_approval_requests (workspace_id, diagram_id) where status in ('pending', 'returned');
create index diagram_approval_requests_lookup on public.diagram_approval_requests (workspace_id, diagram_id, requested_at desc);
revoke all on public.diagram_approval_requests from anon, authenticated;
-- Members may read the requests, so a change reaches open pages straight away. They change them only through the functions below.
grant select on public.diagram_approval_requests to authenticated;
alter table public.diagram_approval_requests enable row level security;
create policy "members read approval requests" on public.diagram_approval_requests for select to authenticated using (public.can_read(workspace_id));
alter publication supabase_realtime add table public.diagram_approval_requests;

-- Everything that happened to a request, in order. Rows are only added.
create table public.diagram_approval_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.diagram_approval_requests (id) on delete cascade,
  round integer not null,
  kind text not null check (kind in ('submitted', 'resubmitted', 'approved', 'approved_with_changes', 'returned', 'rejected', 'withdrawn', 'completed')),
  role text check (role in ('ea', 'security')),
  note text not null default '' check (char_length(note) <= 2000),
  fingerprint text not null,
  by_id uuid references auth.users (id) on delete set null,
  by_name text not null default '',
  at timestamptz not null default now()
);
create index diagram_approval_events_request on public.diagram_approval_events (request_id, id);
revoke all on public.diagram_approval_events from anon, authenticated;
alter table public.diagram_approval_events enable row level security;

-- The approved picture and its information box, kept for live links and verified copies.
create table public.diagram_approved_copies (
  request_id uuid primary key references public.diagram_approval_requests (id) on delete cascade,
  snapshot jsonb not null check (pg_column_size(snapshot) <= 8000000),
  record jsonb not null
);
revoke all on public.diagram_approved_copies from anon, authenticated;
alter table public.diagram_approved_copies enable row level security;

create function public.approval_event(p_request public.diagram_approval_requests, p_kind text, p_role text, p_note text, p_fp text) returns void
language sql security definer set search_path = ''
as $$
  insert into public.diagram_approval_events (request_id, round, kind, role, note, fingerprint, by_id, by_name)
  values (p_request.id, p_request.round, p_kind, p_role, coalesce(p_note, ''), p_fp, auth.uid(), public.person_name(auth.uid()));
  update public.diagram_approval_requests r set updated_at = now() where r.id = p_request.id;
$$;

-- Where a role stands on a request: what it last said since the request was last sent, else whether
-- it approved the diagram as it is now (approved), approved an earlier form of it (stale) or not yet (waiting).
create function public.approval_role_state(p_request uuid, p_role text, p_fp text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_since bigint;
  v_event public.diagram_approval_events;
  v_state text;
begin
  select max(e.id) into v_since from public.diagram_approval_events e where e.request_id = p_request and e.kind in ('submitted', 'resubmitted');
  select * into v_event from public.diagram_approval_events e
  where e.request_id = p_request and e.role = p_role and e.kind in ('returned', 'rejected') and e.id > coalesce(v_since, 0) order by e.id desc limit 1;
  if found then
    v_state := v_event.kind;
  else
    select * into v_event from public.diagram_approval_events e
    where e.request_id = p_request and e.role = p_role and e.kind in ('approved', 'approved_with_changes') and e.fingerprint = p_fp order by e.id desc limit 1;
    if found then
      v_state := 'approved';
    else
      select * into v_event from public.diagram_approval_events e
      where e.request_id = p_request and e.role = p_role and e.kind in ('approved', 'approved_with_changes') order by e.id desc limit 1;
      v_state := case when found then 'stale' else 'waiting' end;
    end if;
  end if;
  return jsonb_build_object('state', v_state, 'by', coalesce(v_event.by_name, ''), 'at', v_event.at, 'note', coalesce(v_event.note, ''),
    'withChanges', coalesce(v_event.kind = 'approved_with_changes', false));
end
$$;

-- Where a diagram stands: its fingerprint, its status, the version it is or is becoming, the request
-- that says so, and each role's state.
--   draft     never approved, and not waiting
--   pending   waiting for approval
--   returned  back with the sender for changes
--   approved  the diagram as it is was approved
--   changed   changed since its last approved version, and not sent again yet
--   rejected  its last request was rejected (one withdrawn after it is not)
create function public.diagram_state(p_ws uuid, p_diagram text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_fp text := public.diagram_fingerprint(p_ws, p_diagram);
  v_open public.diagram_approval_requests;
  v_approved public.diagram_approval_requests;
  v_last public.diagram_approval_requests;
  v_req public.diagram_approval_requests;
  v_count integer;
  v_status text;
begin
  select * into v_open from public.diagram_approval_requests r where r.workspace_id = p_ws and r.diagram_id = p_diagram and r.status in ('pending', 'returned');
  select * into v_approved from public.diagram_approval_requests r where r.workspace_id = p_ws and r.diagram_id = p_diagram and r.status = 'approved' order by r.closed_at desc limit 1;
  select * into v_last from public.diagram_approval_requests r where r.workspace_id = p_ws and r.diagram_id = p_diagram order by r.requested_at desc limit 1;
  select count(*) into v_count from public.diagram_approval_requests r where r.workspace_id = p_ws and r.diagram_id = p_diagram and r.status = 'approved';
  if v_open.id is not null then
    v_status := v_open.status;
    v_req := v_open;
  elsif v_approved.id is not null and v_approved.approved_fingerprint = v_fp then
    v_status := 'approved';
    v_req := v_approved;
  elsif v_last.id is not null and v_last.status = 'rejected' and (v_approved.id is null or v_last.requested_at > v_approved.requested_at) then
    v_status := 'rejected';
    v_req := v_last;
  elsif v_approved.id is not null then
    v_status := 'changed';
    v_req := v_approved;
  else
    v_status := 'draft';
  end if;
  return jsonb_build_object(
    'fingerprint', v_fp,
    'status', v_status,
    'version', case when v_status = 'approved' then v_approved.version else v_count + 1 end,
    'approvedVersion', v_approved.version,
    'approvedAt', v_approved.closed_at,
    'approvedFingerprint', v_approved.approved_fingerprint,
    'request', case when v_req.id is null then null else jsonb_build_object(
      'id', v_req.id, 'version', v_req.version, 'status', v_req.status, 'round', v_req.round, 'note', v_req.note,
      'requestedById', v_req.requested_by, 'requestedBy', public.person_name(v_req.requested_by), 'requestedAt', v_req.requested_at,
      'sentFingerprint', v_req.fingerprint) end,
    'roles', jsonb_build_object(
      'ea', case when v_req.id is null then jsonb_build_object('state', 'waiting', 'by', '', 'at', null, 'note', '', 'withChanges', false) else public.approval_role_state(v_req.id, 'ea', v_fp) end,
      'security', case when v_req.id is null then jsonb_build_object('state', 'waiting', 'by', '', 'at', null, 'note', '', 'withChanges', false) else public.approval_role_state(v_req.id, 'security', v_fp) end
    )
  );
end
$$;

-- Everything the information box and the approval panel show, for members: where the diagram stands,
-- who made and last changed it and when, who approves, and what happened to its requests.
create function public.diagram_record_of(p_workspace uuid, p_diagram text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_diagram public.diagrams;
  v_changed record;
  v_ids text[];
begin
  select * into v_diagram from public.diagrams d where d.workspace_id = p_workspace and d.id = p_diagram and not d.deleted;
  if not found then
    raise exception 'There is no such diagram.' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(n.object_id), '{}') into v_ids from public.diagram_nodes n where n.workspace_id = p_workspace and n.diagram_id = p_diagram and not n.deleted;
  -- The last change to anything the diagram shows: itself, its boxes, their objects, the arrows between them.
  select t.when_changed, t.who into v_changed from (
    select v_diagram.changed_at as when_changed, v_diagram.changed_by as who
    union all select n.changed_at, n.changed_by from public.diagram_nodes n where n.workspace_id = p_workspace and n.diagram_id = p_diagram
    union all select o.changed_at, o.changed_by from public.objects o where o.workspace_id = p_workspace and o.id = any (v_ids)
    union all select r.changed_at, r.changed_by from public.relationships r where r.workspace_id = p_workspace and r.source_id = any (v_ids) and r.target_id = any (v_ids)
  ) t order by t.when_changed desc limit 1;
  return public.diagram_state(p_workspace, p_diagram) || jsonb_build_object(
    'diagramId', p_diagram,
    'required', coalesce((select w.diagram_approval from public.workspaces w where w.id = p_workspace), false),
    'created', jsonb_build_object('at', v_diagram.created_at, 'by', public.person_name(v_diagram.created_by)),
    'changed', jsonb_build_object('at', v_changed.when_changed, 'by', case when v_changed.who is null then '' else public.person_name(v_changed.who) end),
    'approvers', jsonb_build_object('ea', public.approvers_of(p_workspace, 'ea'), 'security', public.approvers_of(p_workspace, 'security')),
    'mine', jsonb_build_object('ea', public.is_approver(p_workspace, 'ea'), 'security', public.is_approver(p_workspace, 'security')),
    'history', coalesce((select jsonb_agg(jsonb_build_object('kind', h.kind, 'role', h.role, 'by', h.by_name, 'at', h.at, 'note', h.note, 'version', h.version, 'round', h.round) order by h.id desc)
      from (select e.*, r.version from public.diagram_approval_events e join public.diagram_approval_requests r on r.id = e.request_id
            where r.workspace_id = p_workspace and r.diagram_id = p_diagram order by e.id desc limit 60) h), '[]'::jsonb)
  );
end
$$;

create function public.diagram_record(p_workspace uuid, p_diagram text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.can_read(p_workspace) then
    raise exception 'Not a member of this workspace.' using errcode = '42501';
  end if;
  return public.diagram_record_of(p_workspace, p_diagram);
end
$$;

-- What an information box shows outside the app, worked out here: the diagram's name, where it stands,
-- who made and changed it, its company and logo, and which fields to show.
create function public.diagram_box(p_ws uuid, p_diagram text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_box jsonb;
  v_branding jsonb;
  v_name text;
  v_workspace text;
begin
  select d.title_block, d.name into v_box, v_name from public.diagrams d where d.workspace_id = p_ws and d.id = p_diagram;
  select b.data into v_branding from public.workspace_branding b where b.workspace_id = p_ws and not b.deleted;
  select w.name into v_workspace from public.workspaces w where w.id = p_ws;
  return public.diagram_record_of(p_ws, p_diagram) - 'approvers' - 'history' - 'mine' || jsonb_build_object(
    'name', v_name,
    'workspace', v_workspace,
    'company', coalesce(nullif(v_box ->> 'company', ''), nullif(v_branding ->> 'company', ''), v_workspace),
    'logo', coalesce(nullif(v_box ->> 'logo', ''), nullif(v_branding ->> 'companyLogo', ''), ''),
    'show', coalesce((v_box ->> 'show')::boolean, false) or coalesce((v_branding ->> 'boxRequired')::boolean, false),
    'corner', coalesce(v_box ->> 'corner', 'bottom-right'),
    'hidden', coalesce(v_box -> 'hidden', '[]'::jsonb),
    'requiredFields', coalesce(v_branding -> 'boxFields', '[]'::jsonb)
  );
end
$$;

-- Closes a request as approved once both roles have approved the diagram as it is: the version is
-- kept with its picture and information box.
create function public.approval_try_complete(p_request uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_req public.diagram_approval_requests;
  v_fp text;
  v_name text;
begin
  select * into v_req from public.diagram_approval_requests r where r.id = p_request for update;
  if not found or v_req.status <> 'pending' then
    return false;
  end if;
  v_fp := public.diagram_fingerprint(v_req.workspace_id, v_req.diagram_id);
  if not exists (select 1 from public.diagram_approval_events e where e.request_id = p_request and e.role = 'ea' and e.kind in ('approved', 'approved_with_changes') and e.fingerprint = v_fp)
     or not exists (select 1 from public.diagram_approval_events e where e.request_id = p_request and e.role = 'security' and e.kind in ('approved', 'approved_with_changes') and e.fingerprint = v_fp) then
    return false;
  end if;
  update public.diagram_approval_requests r set status = 'approved', approved_fingerprint = v_fp, closed_at = now(), updated_at = now() where r.id = p_request returning * into v_req;
  perform public.approval_event(v_req, 'completed', null, '', v_fp);
  insert into public.diagram_approved_copies (request_id, snapshot, record)
  values (p_request, public.diagram_view_from(public.diagram_source(v_req.workspace_id, v_req.diagram_id), v_req.diagram_id), public.diagram_box(v_req.workspace_id, v_req.diagram_id));
  select d.name into v_name from public.diagrams d where d.workspace_id = v_req.workspace_id and d.id = v_req.diagram_id;
  perform public.audit_write(v_req.workspace_id, 'diagram', v_req.diagram_id, v_name, 'approved as version ' || v_req.version, jsonb_build_object('fingerprint', v_fp));
  return true;
end
$$;

-- An editor sends the diagram for approval, or sends a returned one again.
create function public.submit_diagram_for_approval(p_workspace uuid, p_diagram text, p_note text default '') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text;
  v_fp text;
  v_note text := btrim(coalesce(p_note, ''));
  v_req public.diagram_approval_requests;
  v_count integer;
begin
  if not public.can_edit(p_workspace) then
    raise exception 'Only owners and editors can send a diagram for approval.' using errcode = '42501';
  end if;
  select d.name into v_name from public.diagrams d where d.workspace_id = p_workspace and d.id = p_diagram and not d.deleted;
  if not found then
    raise exception 'There is no such diagram.' using errcode = 'P0001';
  end if;
  if public.approvers_of(p_workspace, 'ea') = '[]'::jsonb or public.approvers_of(p_workspace, 'security') = '[]'::jsonb then
    raise exception 'An owner has to name the Enterprise Architecture and Cybersecurity approvers in Settings first.' using errcode = 'P0001';
  end if;
  if char_length(v_note) > 2000 then
    raise exception 'The note is longer than 2000 characters.' using errcode = 'P0001';
  end if;
  v_fp := public.diagram_fingerprint(p_workspace, p_diagram);
  select * into v_req from public.diagram_approval_requests r where r.workspace_id = p_workspace and r.diagram_id = p_diagram and r.status in ('pending', 'returned') for update;
  if found then
    if v_req.status = 'pending' then
      raise exception 'This diagram is already waiting for approval.' using errcode = 'P0001';
    end if;
    update public.diagram_approval_requests r set status = 'pending', round = r.round + 1, fingerprint = v_fp, note = case when v_note = '' then r.note else v_note end, updated_at = now()
    where r.id = v_req.id returning * into v_req;
    perform public.approval_event(v_req, 'resubmitted', null, v_note, v_fp);
    perform public.audit_write(p_workspace, 'diagram', p_diagram, v_name, 'sent for approval again', jsonb_build_object('version', v_req.version, 'round', v_req.round));
  else
    if exists (select 1 from public.diagram_approval_requests r where r.workspace_id = p_workspace and r.diagram_id = p_diagram and r.status = 'approved' and r.approved_fingerprint = v_fp) then
      raise exception 'This diagram is approved as it is. Change it to start its next version.' using errcode = 'P0001';
    end if;
    select count(*) into v_count from public.diagram_approval_requests r where r.workspace_id = p_workspace and r.diagram_id = p_diagram and r.status = 'approved';
    insert into public.diagram_approval_requests (workspace_id, diagram_id, version, note, fingerprint, requested_by)
    values (p_workspace, p_diagram, v_count + 1, v_note, v_fp, auth.uid()) returning * into v_req;
    perform public.approval_event(v_req, 'submitted', null, v_note, v_fp);
    perform public.audit_write(p_workspace, 'diagram', p_diagram, v_name, 'sent for approval', jsonb_build_object('version', v_req.version));
  end if;
  -- Sent again unchanged, it may already carry both approvals.
  perform public.approval_try_complete(v_req.id);
  return public.diagram_record(p_workspace, p_diagram);
end
$$;

-- Whether the signed-in person changed what the diagram shows since a moment: the diagram, its
-- boxes, their objects or the arrows between them.
create function public.changed_by_me_since(p_ws uuid, p_diagram text, p_since timestamptz) returns boolean
language sql stable security definer set search_path = ''
as $$
  with ids as (select n.object_id from public.diagram_nodes n where n.workspace_id = p_ws and n.diagram_id = p_diagram and not n.deleted)
  select auth.uid() is not null and (
    exists (select 1 from public.diagrams d where d.workspace_id = p_ws and d.id = p_diagram and d.changed_by = auth.uid() and d.changed_at > p_since)
    or exists (select 1 from public.diagram_nodes n where n.workspace_id = p_ws and n.diagram_id = p_diagram and n.changed_by = auth.uid() and n.changed_at > p_since)
    or exists (select 1 from public.objects o where o.workspace_id = p_ws and o.id in (select object_id from ids) and o.changed_by = auth.uid() and o.changed_at > p_since)
    or exists (select 1 from public.relationships r where r.workspace_id = p_ws and r.source_id in (select object_id from ids) and r.target_id in (select object_id from ids)
      and r.changed_by = auth.uid() and r.changed_at > p_since))
$$;

-- An approver's decision on the diagram as it is now: approve (also after changing it), return it to
-- the sender with notes to fix, or reject it. Returning and rejecting say why.
create function public.decide_diagram_approval(p_workspace uuid, p_diagram text, p_role text, p_decision text, p_note text default '') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text;
  v_fp text;
  v_note text := btrim(coalesce(p_note, ''));
  v_req public.diagram_approval_requests;
  v_kind text;
  v_role_name text := case p_role when 'ea' then 'Enterprise Architecture' else 'Cybersecurity' end;
begin
  if p_role is null or p_role not in ('ea', 'security') then
    raise exception 'The role is ea or security.' using errcode = 'P0001';
  end if;
  if p_decision is null or p_decision not in ('approve', 'return', 'reject') then
    raise exception 'The decision is approve, return or reject.' using errcode = 'P0001';
  end if;
  if not public.is_approver(p_workspace, p_role) then
    raise exception 'Only a % approver can decide this.', v_role_name using errcode = '42501';
  end if;
  select d.name into v_name from public.diagrams d where d.workspace_id = p_workspace and d.id = p_diagram and not d.deleted;
  if not found then
    raise exception 'There is no such diagram.' using errcode = 'P0001';
  end if;
  select * into v_req from public.diagram_approval_requests r where r.workspace_id = p_workspace and r.diagram_id = p_diagram and r.status in ('pending', 'returned') for update;
  if not found then
    raise exception 'Nothing on this diagram is waiting for approval.' using errcode = 'P0001';
  end if;
  if v_req.status = 'returned' then
    raise exception 'This diagram is back with its sender for changes. It can be decided once it is sent again.' using errcode = 'P0001';
  end if;
  if p_decision <> 'approve' and v_note = '' then
    raise exception 'Say what has to change, so the sender knows what to fix.' using errcode = 'P0001';
  end if;
  if char_length(v_note) > 2000 then
    raise exception 'The note is longer than 2000 characters.' using errcode = 'P0001';
  end if;
  v_fp := public.diagram_fingerprint(p_workspace, p_diagram);
  if p_decision = 'approve' then
    if exists (select 1 from public.diagram_approval_events e where e.request_id = v_req.id and e.role = p_role and e.kind in ('approved', 'approved_with_changes') and e.fingerprint = v_fp) then
      raise exception '% has already approved the diagram as it is.', v_role_name using errcode = 'P0001';
    end if;
    -- An approver who changed the diagram after it was sent approves it with their changes.
    v_kind := case when v_fp <> v_req.fingerprint and public.changed_by_me_since(p_workspace, p_diagram,
        (select max(e.at) from public.diagram_approval_events e where e.request_id = v_req.id and e.kind in ('submitted', 'resubmitted')))
      then 'approved_with_changes' else 'approved' end;
    perform public.approval_event(v_req, v_kind, p_role, v_note, v_fp);
    perform public.audit_write(p_workspace, 'diagram', p_diagram, v_name,
      case v_kind when 'approved' then 'approved by ' else 'changed and approved by ' end || v_role_name, jsonb_build_object('version', v_req.version, 'fingerprint', v_fp)
        || case when v_note <> '' then jsonb_build_object('note', v_note) else '{}'::jsonb end);
    perform public.approval_try_complete(v_req.id);
  elsif p_decision = 'return' then
    update public.diagram_approval_requests r set status = 'returned' where r.id = v_req.id returning * into v_req;
    perform public.approval_event(v_req, 'returned', p_role, v_note, v_fp);
    perform public.audit_write(p_workspace, 'diagram', p_diagram, v_name, 'returned for changes by ' || v_role_name, jsonb_build_object('version', v_req.version, 'note', v_note));
  else
    update public.diagram_approval_requests r set status = 'rejected', closed_at = now() where r.id = v_req.id returning * into v_req;
    perform public.approval_event(v_req, 'rejected', p_role, v_note, v_fp);
    perform public.audit_write(p_workspace, 'diagram', p_diagram, v_name, 'rejected by ' || v_role_name, jsonb_build_object('version', v_req.version, 'note', v_note));
  end if;
  return public.diagram_record(p_workspace, p_diagram);
end
$$;

-- The sender, or an owner, takes a request back.
create function public.withdraw_diagram_approval(p_workspace uuid, p_diagram text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_req public.diagram_approval_requests;
begin
  select * into v_req from public.diagram_approval_requests r where r.workspace_id = p_workspace and r.diagram_id = p_diagram and r.status in ('pending', 'returned') for update;
  if not found then
    raise exception 'Nothing on this diagram is waiting for approval.' using errcode = 'P0001';
  end if;
  if not (v_req.requested_by = auth.uid() and public.can_edit(p_workspace)) and not public.is_owner(p_workspace) then
    raise exception 'Only the person who sent it, or an owner, can withdraw it.' using errcode = '42501';
  end if;
  update public.diagram_approval_requests r set status = 'withdrawn', closed_at = now() where r.id = v_req.id returning * into v_req;
  perform public.approval_event(v_req, 'withdrawn', null, '', coalesce(public.diagram_fingerprint(p_workspace, p_diagram), ''));
  perform public.audit_write(p_workspace, 'diagram', p_diagram, coalesce((select d.name from public.diagrams d where d.workspace_id = p_workspace and d.id = p_diagram), ''), 'approval request withdrawn', jsonb_build_object('version', v_req.version));
  return public.diagram_record(p_workspace, p_diagram);
end
$$;

-- What waits for approval in a workspace, and what was decided lately, for the approvals page.
create function public.diagram_approval_queue(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.can_read(p_workspace) then
    raise exception 'Not a member of this workspace.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'mine', jsonb_build_object('ea', public.is_approver(p_workspace, 'ea'), 'security', public.is_approver(p_workspace, 'security')),
    'open', coalesce((select jsonb_agg(jsonb_build_object(
        'requestId', x.id, 'diagramId', x.diagram_id, 'name', x.name, 'version', x.version, 'status', x.status, 'round', x.round, 'note', x.note,
        'requestedBy', public.person_name(x.requested_by), 'requestedById', x.requested_by, 'requestedAt', x.requested_at, 'updatedAt', x.updated_at,
        'ea', public.approval_role_state(x.id, 'ea', x.fp), 'security', public.approval_role_state(x.id, 'security', x.fp)) order by x.requested_at)
      from (select r.*, d.name, public.diagram_fingerprint(r.workspace_id, r.diagram_id) as fp
            from public.diagram_approval_requests r join public.diagrams d on d.workspace_id = r.workspace_id and d.id = r.diagram_id and not d.deleted
            where r.workspace_id = p_workspace and r.status in ('pending', 'returned')) x), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object(
        'requestId', x.id, 'diagramId', x.diagram_id, 'name', x.name, 'version', x.version, 'status', x.status, 'requestedBy', public.person_name(x.requested_by), 'closedAt', x.closed_at) order by x.closed_at desc)
      from (select r.*, d.name from public.diagram_approval_requests r join public.diagrams d on d.workspace_id = r.workspace_id and d.id = r.diagram_id and not d.deleted
            where r.workspace_id = p_workspace and r.status in ('approved', 'rejected', 'withdrawn') order by r.closed_at desc limit 30) x), '[]'::jsonb)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Verified copies
-- ---------------------------------------------------------------------------

create table public.diagram_publications (
  id uuid primary key default gen_random_uuid(),
  -- The secret part of the link. Whoever has it can see the copy and check it.
  token text not null unique,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  diagram_id text not null,
  fingerprint text not null,
  version integer,
  -- The diagram as it was, for the page to draw: the diagram, its boxes, objects and relationships.
  snapshot jsonb not null check (pg_column_size(snapshot) <= 8000000),
  -- What its information box said: company, maker, last change, version, approvals.
  record jsonb not null,
  note text not null default '' check (char_length(note) <= 500),
  -- SHA-256 of the files exported with it, to check a copy someone was sent.
  files jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  views integer not null default 0
);
create index diagram_publications_lookup on public.diagram_publications (workspace_id, diagram_id, created_at desc);
revoke all on public.diagram_publications from anon, authenticated;
alter table public.diagram_publications enable row level security;

-- Publishes a verified copy. Owners and editors. Without an end it stays until switched off.
-- While approval is compulsory, the copy is of the last approved version.
create function public.publish_diagram(p_workspace uuid, p_diagram text, p_expires_at timestamptz default null, p_note text default '') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.diagram_publications;
  v_req public.diagram_approval_requests;
  v_copy public.diagram_approved_copies;
  v_box jsonb;
  v_name text;
begin
  if not public.can_edit(p_workspace) then
    raise exception 'Only owners and editors can publish a copy.' using errcode = '42501';
  end if;
  select d.name into v_name from public.diagrams d where d.workspace_id = p_workspace and d.id = p_diagram and not d.deleted;
  if not found then
    raise exception 'There is no such diagram.' using errcode = 'P0001';
  end if;
  if p_expires_at is not null and (p_expires_at <= now() + interval '1 minute' or p_expires_at > now() + interval '1 year') then
    raise exception 'Choose an end between a few minutes and a year from now, or none.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.diagram_publications p where p.workspace_id = p_workspace and p.revoked_at is null and (p.expires_at is null or p.expires_at > now())) >= 500 then
    raise exception 'This workspace already has 500 copies published. Switch some off first.' using errcode = 'P0001';
  end if;
  if coalesce((select w.diagram_approval from public.workspaces w where w.id = p_workspace), false) then
    select * into v_req from public.diagram_approval_requests r where r.workspace_id = p_workspace and r.diagram_id = p_diagram and r.status = 'approved' order by r.closed_at desc limit 1;
    select * into v_copy from public.diagram_approved_copies c where c.request_id = v_req.id;
    if v_copy.request_id is null then
      raise exception 'This diagram has no approved version yet. Approval by Enterprise Architecture and Cybersecurity comes before publishing.' using errcode = 'P0001';
    end if;
    insert into public.diagram_publications (token, workspace_id, diagram_id, fingerprint, version, snapshot, record, note, created_by, expires_at)
    values (public.random_token(), p_workspace, p_diagram, v_req.approved_fingerprint, v_req.version, v_copy.snapshot, v_copy.record, left(btrim(coalesce(p_note, '')), 500), auth.uid(), p_expires_at)
    returning * into v_row;
  else
    v_box := public.diagram_box(p_workspace, p_diagram);
    insert into public.diagram_publications (token, workspace_id, diagram_id, fingerprint, version, snapshot, record, note, created_by, expires_at)
    values (public.random_token(), p_workspace, p_diagram, v_box ->> 'fingerprint', case when v_box ->> 'status' = 'approved' then (v_box ->> 'version')::integer end,
      public.diagram_view_from(public.diagram_source(p_workspace, p_diagram), p_diagram), v_box, left(btrim(coalesce(p_note, '')), 500), auth.uid(), p_expires_at)
    returning * into v_row;
  end if;
  perform public.audit_write(p_workspace, 'diagram', p_diagram, v_name, 'published a verified copy',
    jsonb_build_object('fingerprint', v_row.fingerprint, 'version', v_row.version, 'expires', v_row.expires_at));
  return jsonb_build_object('id', v_row.id, 'token', v_row.token, 'createdAt', v_row.created_at, 'expiresAt', v_row.expires_at, 'fingerprint', v_row.fingerprint, 'version', v_row.version);
end
$$;

-- The copies of a diagram, for owners and editors: the link, when it ends, how often it was opened.
create function public.list_publications(p_workspace uuid, p_diagram text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.can_edit(p_workspace) then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'token', p.token, 'createdAt', p.created_at, 'createdBy', public.person_name(p.created_by), 'expiresAt', p.expires_at,
      'revokedAt', p.revoked_at, 'views', p.views, 'note', p.note, 'fingerprint', p.fingerprint, 'version', p.version, 'files', jsonb_array_length(p.files),
      'current', p.fingerprint = public.diagram_fingerprint(p.workspace_id, p.diagram_id)) order by p.created_at desc)
    from public.diagram_publications p where p.workspace_id = p_workspace and p.diagram_id = p_diagram), '[]'::jsonb);
end
$$;

create function public.revoke_publication(p_workspace uuid, p_publication uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.diagram_publications;
begin
  update public.diagram_publications p set revoked_at = now()
  where p.id = p_publication and p.workspace_id = p_workspace and p.revoked_at is null and public.can_edit(p_workspace)
  returning * into v_row;
  if not found then
    raise exception 'That copy no longer exists, or you may not switch it off.' using errcode = '42501';
  end if;
  perform public.audit_write(p_workspace, 'diagram', v_row.diagram_id, v_row.record ->> 'name', 'switched off a verified copy', '{}'::jsonb);
end
$$;

-- Records the SHA-256 of a file exported with a copy, so the file can be checked later.
create function public.add_publication_file(p_workspace uuid, p_publication uuid, p_sha256 text, p_name text) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.can_edit(p_workspace) then
    raise exception 'Only owners and editors can add a file to a copy.' using errcode = '42501';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'That is not a SHA-256.' using errcode = 'P0001';
  end if;
  update public.diagram_publications p set files = p.files || jsonb_build_array(jsonb_build_object('sha256', p_sha256, 'name', left(coalesce(p_name, ''), 200), 'at', now()))
  where p.id = p_publication and p.workspace_id = p_workspace and p.revoked_at is null and jsonb_array_length(p.files) < 50;
  if not found then
    raise exception 'That copy no longer takes files.' using errcode = 'P0001';
  end if;
end
$$;

-- What anyone with the link sees. The token is the permission.
create function public.publication_view(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_row public.diagram_publications;
  v_now text;
  v_alive boolean;
begin
  select * into v_row from public.diagram_publications p where p.token = p_token;
  if not found or v_row.revoked_at is not null then
    return jsonb_build_object('status', 'gone');
  end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then
    return jsonb_build_object('status', 'expired', 'expiredAt', v_row.expires_at, 'name', v_row.record ->> 'name', 'company', v_row.record ->> 'company');
  end if;
  update public.diagram_publications p set views = p.views + 1 where p.id = v_row.id;
  v_alive := exists (select 1 from public.diagrams d where d.workspace_id = v_row.workspace_id and d.id = v_row.diagram_id and not d.deleted);
  v_now := case when v_alive then public.diagram_fingerprint(v_row.workspace_id, v_row.diagram_id) end;
  return jsonb_build_object(
    'status', 'ok',
    'publishedAt', v_row.created_at,
    'publishedBy', public.person_name(v_row.created_by),
    'expiresAt', v_row.expires_at,
    'note', v_row.note,
    'fingerprint', v_row.fingerprint,
    'version', v_row.version,
    'record', v_row.record,
    'snapshot', v_row.snapshot,
    'files', v_row.files,
    -- Whether the diagram in the workspace still matches this copy, whether it was removed, and its newest approved version.
    'current', case when not v_alive then 'removed' when v_now = v_row.fingerprint then 'same' else 'changed' end,
    'latestVersion', (select max(r.version) from public.diagram_approval_requests r where r.workspace_id = v_row.workspace_id and r.diagram_id = v_row.diagram_id and r.status = 'approved'),
    'at', now()
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Live links: while approval is compulsory they show the last approved version
-- ---------------------------------------------------------------------------

create or replace function public.embed_view(p_token text, p_password text default null) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_embed public.embeds;
  v_ws public.workspaces;
  v_source jsonb;
  v_view jsonb;
  v_kind text;
  v_box jsonb;
  v_version integer;
  v_secret public.embed_secrets;
  v_req public.diagram_approval_requests;
begin
  select * into v_embed from public.embeds e where e.token = p_token and e.revoked_at is null;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  if v_embed.expires_at is not null and v_embed.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if v_embed.protected then
    select * into v_secret from public.embed_secrets s where s.embed_id = v_embed.id;
    -- A link marked as protected whose secret is missing stays shut.
    if not found then
      return jsonb_build_object('status', 'locked', 'wrong', false);
    end if;
    if v_secret.locked_until is not null and v_secret.locked_until > now() then
      return jsonb_build_object('status', 'throttled', 'minutes', greatest(1, ceil(extract(epoch from v_secret.locked_until - now()) / 60)::integer));
    end if;
    if coalesce(p_password, '') = '' then
      return jsonb_build_object('status', 'locked', 'wrong', false);
    end if;
    if public.embed_password_hash(v_secret.salt, p_password) <> v_secret.hash then
      -- Five wrong guesses close the link for fifteen minutes, so a password cannot be tried at speed.
      update public.embed_secrets s set
        failed = case when s.failed + 1 >= 5 then 0 else s.failed + 1 end,
        locked_until = case when s.failed + 1 >= 5 then now() + interval '15 minutes' else null end
      where s.embed_id = v_embed.id;
      return jsonb_build_object('status', 'locked', 'wrong', true);
    end if;
    if v_secret.failed > 0 or v_secret.locked_until is not null then
      update public.embed_secrets s set failed = 0, locked_until = null where s.embed_id = v_embed.id;
    end if;
  end if;
  select * into v_ws from public.workspaces w where w.id = v_embed.workspace_id;
  if v_ws.diagram_approval then
    -- Only what both roles approved leaves the workspace.
    if not exists (select 1 from public.diagrams d where d.workspace_id = v_ws.id and d.id = v_embed.diagram_id and not d.deleted) then
      return jsonb_build_object('status', 'gone');
    end if;
    v_kind := 'approved';
    select * into v_req from public.diagram_approval_requests r where r.workspace_id = v_ws.id and r.diagram_id = v_embed.diagram_id and r.status = 'approved' order by r.closed_at desc limit 1;
    select c.snapshot, c.record into v_view, v_box from public.diagram_approved_copies c where c.request_id = v_req.id;
    if v_view is null then
      return jsonb_build_object('status', 'unpublished');
    end if;
    v_version := v_req.version;
    if not coalesce((v_box ->> 'show')::boolean, false) then
      v_box := null;
    end if;
  else
    if v_ws.review_required then
      v_kind := 'published';
      select v.snapshot into v_source from public.versions v where v.id = v_ws.published_version_id;
      if v_source is null then
        return jsonb_build_object('status', 'unpublished');
      end if;
    else
      v_kind := 'working';
      v_source := public.diagram_source(v_ws.id, v_embed.diagram_id);
    end if;
    v_view := public.diagram_view_from(v_source, v_embed.diagram_id);
    if v_view is null then
      return jsonb_build_object('status', case when v_kind = 'published' then 'unpublished' else 'gone' end);
    end if;
    if v_kind = 'working' then
      v_box := public.diagram_box(v_ws.id, v_embed.diagram_id);
      if not coalesce((v_box ->> 'show')::boolean, false) then
        v_box := null;
      end if;
    end if;
  end if;
  return v_view || jsonb_build_object('status', 'ok', 'source', v_kind, 'version', v_version, 'box', v_box, 'at', now());
end
$$;

revoke all on function
  public.keep_diagram_creator(), public.audit_title_block(), public.diagram_fingerprint(uuid, text), public.diagram_source(uuid, text), public.diagram_view_from(jsonb, text),
  public.person_name(uuid), public.approvers_of(uuid, text), public.is_approver(uuid, text),
  public.approval_event(public.diagram_approval_requests, text, text, text, text), public.approval_role_state(uuid, text, text), public.diagram_state(uuid, text),
  public.diagram_box(uuid, text), public.approval_try_complete(uuid), public.changed_by_me_since(uuid, text, timestamptz), public.diagram_record_of(uuid, text)
from public, anon, authenticated;
revoke all on function
  public.diagram_approval_settings(uuid), public.set_diagram_approval(uuid, boolean, uuid[], uuid[]), public.diagram_record(uuid, text),
  public.submit_diagram_for_approval(uuid, text, text), public.decide_diagram_approval(uuid, text, text, text, text), public.withdraw_diagram_approval(uuid, text),
  public.diagram_approval_queue(uuid), public.publish_diagram(uuid, text, timestamptz, text), public.list_publications(uuid, text),
  public.revoke_publication(uuid, uuid), public.add_publication_file(uuid, uuid, text, text), public.publication_view(text)
from public, anon;
grant execute on function
  public.diagram_approval_settings(uuid), public.set_diagram_approval(uuid, boolean, uuid[], uuid[]), public.diagram_record(uuid, text),
  public.submit_diagram_for_approval(uuid, text, text), public.decide_diagram_approval(uuid, text, text, text, text), public.withdraw_diagram_approval(uuid, text),
  public.diagram_approval_queue(uuid), public.publish_diagram(uuid, text, timestamptz, text), public.list_publications(uuid, text),
  public.revoke_publication(uuid, uuid), public.add_publication_file(uuid, uuid, text, text)
to authenticated;
grant execute on function public.publication_view(text) to anon, authenticated;
