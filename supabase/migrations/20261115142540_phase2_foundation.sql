-- ArchONE Diagrams, phase 2 foundation.
--
-- Accounts are Supabase Auth users. A workspace holds one architecture model and is shared
-- with its members. Every table is protected by row-level security:
--   owner      everything, including members and deleting the workspace
--   editor     read and change the model
--   commenter  read (comments arrive in a later migration)
--   viewer     read
--
-- Model rows are never hard-deleted by the app: a row is marked `deleted` instead. Realtime
-- cannot filter or permission-check DELETE events, while an UPDATE is checked like any read.

create type public.workspace_role as enum ('owner', 'editor', 'commenter', 'viewer');

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null default '' check (char_length(display_name) <= 80),
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(coalesce(new.email, '')),
    left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 80)
  )
  on conflict (id) do nothing;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Workspaces, members, invites
-- ---------------------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.workspace_role not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user on public.workspace_members (user_id);

create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1 and char_length(email) <= 254),
  role public.workspace_role not null check (role <> 'owner'),
  invited_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);

-- Role lookups run as the definer so that policies on workspace_members do not recurse.
create function public.member_role(ws uuid) returns public.workspace_role
language sql stable security definer set search_path = ''
as $$
  select m.role from public.workspace_members m
  where m.workspace_id = ws and m.user_id = (select auth.uid())
$$;

create function public.can_read(ws uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select public.member_role(ws) is not null $$;

create function public.can_edit(ws uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(public.member_role(ws) in ('owner', 'editor'), false) $$;

create function public.is_owner(ws uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(public.member_role(ws) = 'owner', false) $$;

create function public.shares_workspace(other uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = (select auth.uid()) and theirs.user_id = other
  )
$$;

-- The caller's confirmed email address, or null. Invites are matched on this, never on a typed value.
create function public.my_confirmed_email() returns text
language sql stable security definer set search_path = ''
as $$
  select lower(u.email) from auth.users u
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null
$$;

create function public.create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if (select count(*) from public.workspace_members m where m.user_id = v_user and m.role = 'owner') >= 50 then
    raise exception 'You already own 50 workspaces.' using errcode = 'P0001';
  end if;
  insert into public.workspaces (name, created_by) values (btrim(p_name), v_user) returning id into v_id;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_id, v_user, 'owner');
  return v_id;
end
$$;

create function public.my_invites()
returns table (id uuid, workspace_id uuid, workspace_name text, role public.workspace_role, invited_by_name text)
language sql stable security definer set search_path = ''
as $$
  select i.id, i.workspace_id, w.name, i.role, coalesce(nullif(p.display_name, ''), p.email, '')
  from public.workspace_invites i
  join public.workspaces w on w.id = i.workspace_id
  left join public.profiles p on p.id = i.invited_by
  where i.email = public.my_confirmed_email()
  order by i.created_at
$$;

create function public.accept_invite(p_invite uuid) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_email text := public.my_confirmed_email();
  v_invite public.workspace_invites;
begin
  if v_user is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if v_email is null then
    raise exception 'Confirm your email address first.' using errcode = '42501';
  end if;
  select * into v_invite from public.workspace_invites i where i.id = p_invite and i.email = v_email;
  if not found then
    raise exception 'This invitation no longer exists.' using errcode = 'P0002';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_invite.workspace_id, v_user, v_invite.role)
  on conflict (workspace_id, user_id) do nothing;
  delete from public.workspace_invites i where i.id = v_invite.id;
  return v_invite.workspace_id;
end
$$;

create function public.decline_invite(p_invite uuid) returns void
language sql security definer set search_path = ''
as $$
  delete from public.workspace_invites i where i.id = p_invite and i.email = public.my_confirmed_email()
$$;

create function public.workspace_people(p_workspace uuid)
returns table (user_id uuid, email text, display_name text, role public.workspace_role)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, coalesce(p.email, ''), coalesce(p.display_name, ''), m.role
  from public.workspace_members m
  left join public.profiles p on p.id = m.user_id
  where m.workspace_id = p_workspace and public.can_read(p_workspace)
  order by m.created_at
$$;

-- A workspace always keeps at least one owner. Deleting the workspace itself still cascades.
create function public.keep_one_owner() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
    if exists (select 1 from public.workspaces w where w.id = old.workspace_id)
       and not exists (
         select 1 from public.workspace_members m
         where m.workspace_id = old.workspace_id and m.role = 'owner' and m.user_id <> old.user_id
       ) then
      raise exception 'A workspace needs at least one owner. Make someone else an owner first.' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

create trigger keep_one_owner
  before update or delete on public.workspace_members
  for each row execute function public.keep_one_owner();

-- ---------------------------------------------------------------------------
-- The model: one row per object, relationship, diagram, placed box and AI draft
-- ---------------------------------------------------------------------------

create function public.stamp_change() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.changed_at := now();
  new.changed_by := auth.uid();
  return new;
end
$$;

create table public.objects (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  type_id text not null check (char_length(type_id) between 1 and 64),
  name text not null check (char_length(name) <= 300),
  description text not null default '' check (char_length(description) <= 20000),
  owner text not null default '' check (char_length(owner) <= 300),
  lifecycle text not null default 'active' check (lifecycle in ('planned', 'active', 'deprecated', 'retired')),
  tags text[] not null default '{}',
  parent_id text,
  technology text not null default '' check (char_length(technology) <= 300),
  fields jsonb not null default '{}',
  provenance jsonb not null default '{"origin":"manual"}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create table public.relationships (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  source_id text not null,
  target_id text not null,
  kind text not null check (kind in ('calls', 'depends_on', 'reads_writes', 'hosted_on', 'routes_to', 'replicates_to')),
  label text not null default '' check (char_length(label) <= 300),
  protocol text not null default '' check (char_length(protocol) <= 100),
  port text not null default '' check (char_length(port) <= 100),
  description text not null default '' check (char_length(description) <= 20000),
  provenance jsonb not null default '{"origin":"manual"}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create table public.diagrams (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  name text not null check (char_length(name) <= 300),
  description text not null default '' check (char_length(description) <= 20000),
  view_type text not null check (view_type in ('landscape', 'context', 'container', 'deployment', 'dataflow', 'custom')),
  scope_id text,
  direction text not null default 'TB' check (direction in ('TB', 'LR')),
  hidden_relationship_ids text[] not null default '{}',
  edge_kinds text[],
  color_by text not null default 'type' check (color_by in ('type', 'lifecycle', 'owner')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

-- One row per box on a diagram, so two people moving different boxes never overwrite each other.
create table public.diagram_nodes (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  diagram_id text not null,
  object_id text not null,
  x double precision not null,
  y double precision not null,
  pinned boolean not null default false,
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, diagram_id, object_id)
);

create table public.proposals (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  status text not null check (status in ('pending', 'applied', 'dismissed')),
  data jsonb not null,
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create trigger stamp_change before insert or update on public.objects for each row execute function public.stamp_change();
create trigger stamp_change before insert or update on public.relationships for each row execute function public.stamp_change();
create trigger stamp_change before insert or update on public.diagrams for each row execute function public.stamp_change();
create trigger stamp_change before insert or update on public.diagram_nodes for each row execute function public.stamp_change();
create trigger stamp_change before insert or update on public.proposals for each row execute function public.stamp_change();

-- Removes rows that were marked deleted long enough ago that every open browser has seen the mark.
create function public.purge_deleted(p_workspace uuid, p_older_than interval default interval '30 days') returns integer
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
  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges: signed-in people only, and only what the policies below then allow
-- ---------------------------------------------------------------------------

-- Only this application's own tables and functions are touched, in case the project holds others.
revoke all on
  public.profiles, public.workspaces, public.workspace_members, public.workspace_invites,
  public.objects, public.relationships, public.diagrams, public.diagram_nodes, public.proposals
from anon, authenticated;

revoke execute on function
  public.handle_new_user(), public.keep_one_owner(), public.stamp_change(),
  public.member_role(uuid), public.can_read(uuid), public.can_edit(uuid), public.is_owner(uuid),
  public.shares_workspace(uuid), public.my_confirmed_email(), public.create_workspace(text),
  public.my_invites(), public.accept_invite(uuid), public.decline_invite(uuid),
  public.workspace_people(uuid), public.purge_deleted(uuid, interval)
from public, anon, authenticated;

grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select, delete on public.workspaces to authenticated;
grant update (name) on public.workspaces to authenticated;
grant select, delete on public.workspace_members to authenticated;
grant update (role) on public.workspace_members to authenticated;
grant select, insert, delete on public.workspace_invites to authenticated;
grant select, insert, update on public.objects, public.relationships, public.diagrams, public.diagram_nodes, public.proposals to authenticated;

grant execute on function
  public.member_role(uuid), public.can_read(uuid), public.can_edit(uuid), public.is_owner(uuid),
  public.shares_workspace(uuid), public.my_confirmed_email(), public.create_workspace(text),
  public.my_invites(), public.accept_invite(uuid), public.decline_invite(uuid),
  public.workspace_people(uuid), public.purge_deleted(uuid, interval), public.stamp_change()
to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.objects enable row level security;
alter table public.relationships enable row level security;
alter table public.diagrams enable row level security;
alter table public.diagram_nodes enable row level security;
alter table public.proposals enable row level security;

create policy "people see themselves and co-members" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or public.shares_workspace(id));
create policy "people rename themselves" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Workspaces are created through create_workspace(), so there is no insert policy.
create policy "members see their workspaces" on public.workspaces
  for select to authenticated using (public.can_read(id));
create policy "owners rename the workspace" on public.workspaces
  for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));
create policy "owners delete the workspace" on public.workspaces
  for delete to authenticated using (public.is_owner(id));

-- Members are added through create_workspace() and accept_invite(), so there is no insert policy.
create policy "members see the member list" on public.workspace_members
  for select to authenticated using (public.can_read(workspace_id));
create policy "owners change roles" on public.workspace_members
  for update to authenticated using (public.is_owner(workspace_id)) with check (public.is_owner(workspace_id));
create policy "owners remove members, members leave" on public.workspace_members
  for delete to authenticated using (public.is_owner(workspace_id) or user_id = (select auth.uid()));

create policy "owners see invites" on public.workspace_invites
  for select to authenticated using (public.is_owner(workspace_id));
create policy "owners invite" on public.workspace_invites
  for insert to authenticated with check (public.is_owner(workspace_id) and invited_by = (select auth.uid()));
create policy "owners cancel invites" on public.workspace_invites
  for delete to authenticated using (public.is_owner(workspace_id));

create policy "members read objects" on public.objects for select to authenticated using (public.can_read(workspace_id));
create policy "editors add objects" on public.objects for insert to authenticated with check (public.can_edit(workspace_id));
create policy "editors change objects" on public.objects for update to authenticated using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));

create policy "members read relationships" on public.relationships for select to authenticated using (public.can_read(workspace_id));
create policy "editors add relationships" on public.relationships for insert to authenticated with check (public.can_edit(workspace_id));
create policy "editors change relationships" on public.relationships for update to authenticated using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));

create policy "members read diagrams" on public.diagrams for select to authenticated using (public.can_read(workspace_id));
create policy "editors add diagrams" on public.diagrams for insert to authenticated with check (public.can_edit(workspace_id));
create policy "editors change diagrams" on public.diagrams for update to authenticated using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));

create policy "members read diagram nodes" on public.diagram_nodes for select to authenticated using (public.can_read(workspace_id));
create policy "editors add diagram nodes" on public.diagram_nodes for insert to authenticated with check (public.can_edit(workspace_id));
create policy "editors change diagram nodes" on public.diagram_nodes for update to authenticated using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));

create policy "members read proposals" on public.proposals for select to authenticated using (public.can_read(workspace_id));
create policy "editors add proposals" on public.proposals for insert to authenticated with check (public.can_edit(workspace_id));
create policy "editors change proposals" on public.proposals for update to authenticated using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id));

-- ---------------------------------------------------------------------------
-- Realtime: other members' changes arrive as they are saved
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table
  public.objects, public.relationships, public.diagrams, public.diagram_nodes, public.proposals, public.workspace_members;
