-- ArchONE Diagrams, phase 4: diagram kinds by category, and roles per category.
--
--  * Every diagram belongs to one category: Applications (the C4 views: system landscape,
--    level 1 system context, level 2 containers), Data, Infrastructure, Business or Custom.
--    Business is a new kind of diagram.
--  * An owner can give a member a role per category: editor, commenter, viewer or none. It can
--    narrow the member's workspace role, never widen it; a category without one keeps the
--    workspace role. Owners always have every category.
--  * The role of a category governs its diagrams (seeing, commenting, changing them) and the
--    objects of the shared model that belong to it. People and domains belong to both
--    Applications and Business; external systems to Applications. A relationship can be
--    changed by whoever can change either of its ends.
--  * None hides the category's diagrams, their boxes and their comments, in the working model
--    and in versions. The objects stay readable: the model is shared, and other diagrams draw
--    them.
--  * These are row-level rules, so they hold for anything that reaches the database directly.
--    API keys keep their own access and domain limits.

-- ---------------------------------------------------------------------------
-- The Business kind of diagram
-- ---------------------------------------------------------------------------

alter table public.diagrams drop constraint diagrams_view_type_check;
alter table public.diagrams add constraint diagrams_view_type_check
  check (view_type in ('landscape', 'context', 'container', 'deployment', 'dataflow', 'business', 'custom'));

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------

-- The categories an object of this type belongs to. Unknown types belong to none, and are then
-- governed by the workspace role alone.
create function public.type_categories(p_type text) returns text[]
language sql immutable set search_path = ''
as $$
  select case
    when p_type in ('domain', 'actor') then array['applications', 'business']
    when p_type in ('system', 'external-system', 'application', 'web-app', 'mobile-app', 'service', 'component', 'ai-agent', 'ai-model', 'mcp-server') then array['applications']
    when p_type in ('database', 'queue', 'cache', 'storage') then array['data']
    when p_type in ('gateway', 'server', 'cluster', 'network') then array['infrastructure']
    when p_type in ('process', 'task', 'event', 'decision') then array['business']
    else array[]::text[]
  end
$$;

-- The category a kind of diagram belongs to.
create function public.view_category(p_view text) returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_view in ('landscape', 'context', 'container') then 'applications'
    when p_view = 'dataflow' then 'data'
    when p_view = 'deployment' then 'infrastructure'
    when p_view = 'business' then 'business'
    else 'custom'
  end
$$;

create function public.role_rank(p_role text) returns integer
language sql immutable set search_path = ''
as $$
  select case p_role when 'owner' then 4 when 'editor' then 3 when 'commenter' then 2 when 'viewer' then 1 else 0 end
$$;

create function public.valid_category_roles(p_roles jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select jsonb_typeof(p_roles) = 'object' and not exists (
    select 1 from jsonb_each(p_roles) e
    where e.key not in ('applications', 'data', 'infrastructure', 'business', 'custom')
       or jsonb_typeof(e.value) <> 'string'
       or e.value #>> '{}' not in ('editor', 'commenter', 'viewer', 'none')
  )
$$;

alter table public.workspace_members add column category_roles jsonb not null default '{}'::jsonb
  check (public.valid_category_roles(category_roles));

-- An owner has every category; a role per category belongs to the other members.
create or replace function public.clear_domains_with_role() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.role <> 'editor' then
    new.domains := null;
  end if;
  if new.role = 'owner' then
    new.category_roles := '{}'::jsonb;
  end if;
  return new;
end
$$;

-- What the signed-in person may do in a category: 0 nothing, 1 view, 2 comment, 3 edit, 4 own.
-- Outside a signed-in session (an API key, the database's own functions) categories do not narrow.
create function public.category_rank(ws uuid, p_category text) returns integer
language sql stable security definer set search_path = ''
as $$
  select case
    when auth.uid() is null then 4
    else coalesce((
      select case
        when m.role = 'owner' then 4
        else least(public.role_rank(m.role::text), public.role_rank(coalesce(m.category_roles ->> p_category, m.role::text)))
      end
      from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid()
    ), 0)
  end
$$;

-- Edit rights for something that belongs to these categories: any one of them is enough.
-- Something that belongs to no category is governed by the workspace role alone.
create function public.can_edit_categories(ws uuid, p_categories text[]) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(cardinality(p_categories), 0) = 0 or exists (select 1 from unnest(p_categories) c where public.category_rank(ws, c) >= 3)
$$;

create function public.object_editable(ws uuid, p_object text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select public.can_edit_categories(ws, public.type_categories(o.type_id)) from public.objects o where o.workspace_id = ws and o.id = p_object), true)
$$;

-- The rank the signed-in person has for a diagram's category. A diagram not found is not narrowed.
create function public.diagram_rank(ws uuid, p_diagram text) returns integer
language sql stable security definer set search_path = ''
as $$
  select coalesce((select public.category_rank(ws, public.view_category(d.view_type)) from public.diagrams d where d.workspace_id = ws and d.id = p_diagram), 4)
$$;

-- ---------------------------------------------------------------------------
-- The rules, added to the existing ones (restrictive: both have to allow)
-- ---------------------------------------------------------------------------

create policy "category: see diagrams" on public.diagrams as restrictive for select to authenticated
  using (public.category_rank(workspace_id, public.view_category(view_type)) >= 1);
create policy "category: add diagrams" on public.diagrams as restrictive for insert to authenticated
  with check (public.category_rank(workspace_id, public.view_category(view_type)) >= 3);
create policy "category: change diagrams" on public.diagrams as restrictive for update to authenticated
  using (public.category_rank(workspace_id, public.view_category(view_type)) >= 3)
  with check (public.category_rank(workspace_id, public.view_category(view_type)) >= 3);

create policy "category: see diagram boxes" on public.diagram_nodes as restrictive for select to authenticated
  using (public.diagram_rank(workspace_id, diagram_id) >= 1);
create policy "category: add diagram boxes" on public.diagram_nodes as restrictive for insert to authenticated
  with check (public.diagram_rank(workspace_id, diagram_id) >= 3);
create policy "category: change diagram boxes" on public.diagram_nodes as restrictive for update to authenticated
  using (public.diagram_rank(workspace_id, diagram_id) >= 3)
  with check (public.diagram_rank(workspace_id, diagram_id) >= 3);

create policy "category: add objects" on public.objects as restrictive for insert to authenticated
  with check (public.can_edit_categories(workspace_id, public.type_categories(type_id)));
create policy "category: change objects" on public.objects as restrictive for update to authenticated
  using (public.can_edit_categories(workspace_id, public.type_categories(type_id)))
  with check (public.can_edit_categories(workspace_id, public.type_categories(type_id)));

create policy "category: add relationships" on public.relationships as restrictive for insert to authenticated
  with check (public.object_editable(workspace_id, source_id) or public.object_editable(workspace_id, target_id));
create policy "category: change relationships" on public.relationships as restrictive for update to authenticated
  using (public.object_editable(workspace_id, source_id) or public.object_editable(workspace_id, target_id))
  with check (public.object_editable(workspace_id, source_id) or public.object_editable(workspace_id, target_id));

create policy "category: see comments" on public.comments as restrictive for select to authenticated
  using (diagram_id is null or public.diagram_rank(workspace_id, diagram_id) >= 1);
create policy "category: write comments" on public.comments as restrictive for insert to authenticated
  with check (diagram_id is null or public.diagram_rank(workspace_id, diagram_id) >= 2);
create policy "category: change comments" on public.comments as restrictive for update to authenticated
  using (diagram_id is null or public.diagram_rank(workspace_id, diagram_id) >= 2)
  with check (diagram_id is null or public.diagram_rank(workspace_id, diagram_id) >= 2);

create policy "category: see templates" on public.diagram_templates as restrictive for select to authenticated
  using (public.category_rank(workspace_id, data ->> 'perspective') >= 1);
create policy "category: add templates" on public.diagram_templates as restrictive for insert to authenticated
  with check (public.category_rank(workspace_id, data ->> 'perspective') >= 3);
create policy "category: change templates" on public.diagram_templates as restrictive for update to authenticated
  using (public.category_rank(workspace_id, data ->> 'perspective') >= 3)
  with check (public.category_rank(workspace_id, data ->> 'perspective') >= 3);

-- ---------------------------------------------------------------------------
-- Versions: their copy of the model is read through a function that leaves out what is hidden
-- ---------------------------------------------------------------------------

revoke select on public.versions from authenticated;
grant select (id, workspace_id, name, note, kind, object_count, relationship_count, diagram_count, created_by, created_at) on public.versions to authenticated;

create function public.version_snapshot(p_workspace uuid, p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_diagrams jsonb;
begin
  if not public.version_visible(p_workspace, p_version) then
    return null;
  end if;
  select v.snapshot into v_snapshot from public.versions v where v.workspace_id = p_workspace and v.id = p_version;
  if v_snapshot is null then
    return null;
  end if;
  select coalesce(jsonb_agg(d), '[]'::jsonb) into v_diagrams
    from jsonb_array_elements(coalesce(v_snapshot -> 'diagrams', '[]'::jsonb)) d
    where public.category_rank(p_workspace, public.view_category(d ->> 'view_type')) >= 1;
  return v_snapshot
    || jsonb_build_object('diagrams', v_diagrams)
    || jsonb_build_object('nodes', coalesce((
      select jsonb_agg(n) from jsonb_array_elements(coalesce(v_snapshot -> 'nodes', '[]'::jsonb)) n
      where exists (select 1 from jsonb_array_elements(v_diagrams) d where d ->> 'id' = n ->> 'diagram_id')
    ), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------
-- Setting the roles
-- ---------------------------------------------------------------------------

create function public.set_member_category_roles(p_workspace uuid, p_user uuid, p_roles jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_role public.workspace_role;
  v_roles jsonb := coalesce(p_roles, '{}'::jsonb);
begin
  if not public.is_owner(p_workspace) then
    raise exception 'Only an owner can set roles per category.' using errcode = '42501';
  end if;
  select m.role into v_role from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user;
  if v_role is null then
    raise exception 'That person is not a member of this workspace.' using errcode = 'P0001';
  end if;
  if v_role = 'owner' then
    raise exception 'An owner has every category. Change the role first.' using errcode = 'P0001';
  end if;
  if not public.valid_category_roles(v_roles) then
    raise exception 'Each category takes editor, commenter, viewer or none.' using errcode = 'P0001';
  end if;
  -- A role above the workspace role would not be used; it is kept as the workspace role.
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_roles
    from jsonb_each(v_roles) e where public.role_rank(e.value #>> '{}') < public.role_rank(v_role::text);
  update public.workspace_members m set category_roles = v_roles where m.workspace_id = p_workspace and m.user_id = p_user;
end
$$;

-- The members list says each member's roles per category.
drop function public.workspace_people(uuid);
create function public.workspace_people(p_workspace uuid)
returns table (user_id uuid, email text, display_name text, role public.workspace_role, domains text[], category_roles jsonb)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, coalesce(p.email, ''), coalesce(p.display_name, ''), m.role, m.domains, m.category_roles
  from public.workspace_members m
  left join public.profiles p on p.id = m.user_id
  where m.workspace_id = p_workspace and public.can_read(p_workspace)
  order by m.created_at
$$;

create or replace function public.audit_member() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_write(new.workspace_id, 'member', new.user_id::text, public.audit_person(new.user_id), 'added', jsonb_build_object('role', jsonb_build_array(null, new.role)));
  elsif tg_op = 'DELETE' then
    perform public.audit_write(old.workspace_id, 'member', old.user_id::text, public.audit_person(old.user_id), 'removed', jsonb_build_object('role', jsonb_build_array(old.role, null)));
  else
    if old.role is distinct from new.role then
      perform public.audit_write(new.workspace_id, 'member', new.user_id::text, public.audit_person(new.user_id), 'role changed', jsonb_build_object('role', jsonb_build_array(old.role, new.role)));
    end if;
    if old.domains is distinct from new.domains then
      perform public.audit_write(new.workspace_id, 'member', new.user_id::text, public.audit_person(new.user_id), 'limit changed', jsonb_build_object('domains', jsonb_build_array(
        (select coalesce(jsonb_agg(o.name order by o.name), '[]'::jsonb) from public.objects o where o.workspace_id = new.workspace_id and o.id = any (coalesce(old.domains, '{}'))),
        (select coalesce(jsonb_agg(o.name order by o.name), '[]'::jsonb) from public.objects o where o.workspace_id = new.workspace_id and o.id = any (coalesce(new.domains, '{}'))))));
    end if;
    if old.category_roles is distinct from new.category_roles then
      perform public.audit_write(new.workspace_id, 'member', new.user_id::text, public.audit_person(new.user_id), 'category roles changed',
        jsonb_build_object('categories', jsonb_build_array(old.category_roles, new.category_roles)));
    end if;
  end if;
  return null;
end
$$;

-- A scenario's members keep their roles per category from the workspace it was made from.
create function public.inherit_category_roles() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_source uuid := (select w.scenario_of from public.workspaces w where w.id = new.workspace_id);
begin
  if v_source is not null and new.role <> 'owner' and new.category_roles = '{}'::jsonb then
    new.category_roles := coalesce((select m.category_roles from public.workspace_members m where m.workspace_id = v_source and m.user_id = new.user_id), '{}'::jsonb);
  end if;
  return new;
end
$$;
create trigger inherit_category_roles before insert on public.workspace_members for each row execute function public.inherit_category_roles();

-- ---------------------------------------------------------------------------
-- The API accepts the Business kind
-- ---------------------------------------------------------------------------

create or replace function public.api_diagrams(p_ws uuid, p_method text, p_id text, p_query jsonb, p_body jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  d public.diagrams;
  v_limit integer := public.api_page(p_query);
  v_rows jsonb;
  v_last text;
begin
  if p_method in ('POST', 'PATCH') and (p_body is null or jsonb_typeof(p_body) <> 'object') then
    perform public.api_fail(400, 'invalid', 'Send a JSON object.');
  end if;
  if p_id is null then
    if p_method = 'GET' then
      select coalesce(jsonb_agg(public.api_diagram(t) order by t.id), '[]'::jsonb), max(t.id) into v_rows, v_last
      from (
        select * from public.diagrams x
        where x.workspace_id = p_ws and not x.deleted and (p_query ->> 'cursor' is null or x.id > p_query ->> 'cursor')
        order by x.id limit v_limit
      ) t;
      return public.api_reply(200, jsonb_build_object('data', v_rows, 'nextCursor', case when jsonb_array_length(v_rows) = v_limit then v_last end));
    elsif p_method = 'POST' then
      d.workspace_id := p_ws;
      d.id := 'dia_' || left(public.random_token(), 12);
      d.name := btrim(public.api_text(p_body, 'name', 300));
      if d.name = '' then
        perform public.api_fail(422, 'invalid', '"name" is required.');
      end if;
      d.description := public.api_text(p_body, 'description', 20000);
      d.view_type := public.api_text(p_body, 'viewType', 20, 'custom');
      d.direction := public.api_text(p_body, 'direction', 2, 'TB');
      if d.view_type not in ('landscape', 'context', 'container', 'deployment', 'dataflow', 'business', 'custom') or d.direction not in ('TB', 'LR') then
        perform public.api_fail(422, 'invalid', '"viewType" has to be landscape, context, container, deployment, dataflow, business or custom, and "direction" TB or LR.');
      end if;
      d.hidden_relationship_ids := '{}'; d.color_by := 'type';
      d.created_at := now(); d.updated_at := now(); d.deleted := false;
      insert into public.diagrams select d.*;
      perform public.api_place_nodes(p_ws, d.id, p_body -> 'nodes');
      return public.api_reply(201, public.api_diagram(d));
    end if;
    perform public.api_fail(405, 'method', 'Use GET or POST on /diagrams.');
  end if;

  select * into d from public.diagrams x where x.workspace_id = p_ws and x.id = p_id and not x.deleted;
  if not found then
    perform public.api_fail(404, 'not_found', format('There is no diagram %s in this workspace.', p_id));
  end if;
  if p_method = 'GET' then
    return public.api_reply(200, public.api_diagram(d));
  elsif p_method = 'PATCH' then
    if p_body ? 'name' then
      d.name := btrim(public.api_text(p_body, 'name', 300));
      if d.name = '' then
        perform public.api_fail(422, 'invalid', '"name" cannot be empty.');
      end if;
    end if;
    if p_body ? 'description' then d.description := public.api_text(p_body, 'description', 20000); end if;
    if p_body ? 'direction' then
      d.direction := public.api_text(p_body, 'direction', 2, 'TB');
      if d.direction not in ('TB', 'LR') then
        perform public.api_fail(422, 'invalid', '"direction" has to be TB or LR.');
      end if;
    end if;
    d.updated_at := now();
    update public.diagrams x set name = d.name, description = d.description, direction = d.direction, updated_at = d.updated_at where x.workspace_id = p_ws and x.id = d.id;
    perform public.api_place_nodes(p_ws, d.id, p_body -> 'nodes');
    if p_body ? 'removeNodes' then
      if jsonb_typeof(p_body -> 'removeNodes') <> 'array' then
        perform public.api_fail(422, 'invalid', '"removeNodes" has to be a list of object ids.');
      end if;
      update public.diagram_nodes n set deleted = true
      where n.workspace_id = p_ws and n.diagram_id = d.id and not n.deleted and n.object_id in (select e #>> '{}' from jsonb_array_elements(p_body -> 'removeNodes') e);
    end if;
    return public.api_reply(200, public.api_diagram(d));
  elsif p_method = 'DELETE' then
    update public.diagram_nodes n set deleted = true where n.workspace_id = p_ws and n.diagram_id = d.id and not n.deleted;
    update public.diagrams x set deleted = true where x.workspace_id = p_ws and x.id = d.id;
    update public.embeds e set revoked_at = now() where e.workspace_id = p_ws and e.diagram_id = d.id and e.revoked_at is null;
    return public.api_reply(204, null);
  end if;
  perform public.api_fail(405, 'method', 'Use GET, PATCH or DELETE on /diagrams/{id}.');
  return null;
end
$$;

revoke all on function
  public.type_categories(text), public.view_category(text), public.role_rank(text), public.valid_category_roles(jsonb),
  public.category_rank(uuid, text), public.can_edit_categories(uuid, text[]), public.object_editable(uuid, text), public.diagram_rank(uuid, text),
  public.version_snapshot(uuid, uuid), public.set_member_category_roles(uuid, uuid, jsonb), public.workspace_people(uuid),
  public.audit_member(), public.inherit_category_roles(), public.clear_domains_with_role(), public.api_diagrams(uuid, text, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function
  public.type_categories(text), public.view_category(text), public.role_rank(text), public.valid_category_roles(jsonb),
  public.category_rank(uuid, text), public.can_edit_categories(uuid, text[]), public.object_editable(uuid, text), public.diagram_rank(uuid, text),
  public.version_snapshot(uuid, uuid), public.set_member_category_roles(uuid, uuid, jsonb), public.workspace_people(uuid)
  to authenticated;
