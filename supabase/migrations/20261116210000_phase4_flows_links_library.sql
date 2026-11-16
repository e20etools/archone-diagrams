-- ArchONE Diagrams, phase 4: flows, links to the real thing, protected live links, and the
-- component library.
--
-- 1. A diagram can carry flows: a use case told step by step over its boxes.
-- 2. An object or a relationship can link to where it really lives: a repository, a runbook,
--    a dashboard.
-- 3. A live link can ask for a password and can stop working on a date.
--
-- The three columns are free-form JSON written by the app. They are left nullable, without a
-- default, because the API builds rows field by field and inserts the whole record.

alter table public.objects add column links jsonb check (links is null or (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 20));
alter table public.relationships add column links jsonb check (links is null or (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 20));
-- 4. An object can remember which library component it was made from ("network.firewall",
--    "aws.simple-storage-service-s3"), for its icon and the basic information it asks for.
alter table public.objects add column component_id text check (component_id is null or char_length(component_id) <= 120);
alter table public.diagrams add column flows jsonb check (flows is null or (jsonb_typeof(flows) = 'array' and jsonb_array_length(flows) <= 30 and pg_column_size(flows) <= 400000));

-- A scenario keeps the links and the flows of what it copies.
create or replace function public.create_scenario(p_workspace uuid, p_name text, p_note text default '') returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_source public.workspaces;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Sign in first.' using errcode = '28000';
  end if;
  if not public.can_edit(p_workspace) then
    raise exception 'Only owners and editors can create a scenario.' using errcode = '42501';
  end if;
  select * into v_source from public.workspaces w where w.id = p_workspace;
  if v_source.scenario_of is not null then
    raise exception 'A scenario cannot have scenarios of its own. Create it from the main workspace.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.workspaces w where w.scenario_of = p_workspace) >= 20 then
    raise exception 'This workspace already has 20 scenarios. Delete one first.' using errcode = 'P0001';
  end if;

  insert into public.workspaces (name, created_by, scenario_of, scenario_note)
  values (btrim(p_name), v_user, p_workspace, coalesce(p_note, '')) returning id into v_id;

  perform set_config('archone.audit_off', '1', true);
  -- Only people who already see the working model come along. With review on, viewers and
  -- commenters are held on the published version, and a scenario must not show them more.
  insert into public.workspace_members (workspace_id, user_id, role)
    select v_id, m.user_id, m.role from public.workspace_members m where m.workspace_id = p_workspace and m.role in ('owner', 'editor');
  insert into public.objects (workspace_id, id, type_id, name, description, owner, lifecycle, tags, parent_id, technology, fields, links, component_id, provenance, created_at, updated_at)
    select v_id, o.id, o.type_id, o.name, o.description, o.owner, o.lifecycle, o.tags, o.parent_id, o.technology, o.fields, o.links, o.component_id, o.provenance, o.created_at, o.updated_at
    from public.objects o where o.workspace_id = p_workspace and not o.deleted;
  insert into public.relationships (workspace_id, id, source_id, target_id, kind, label, protocol, port, description, links, provenance, created_at, updated_at)
    select v_id, r.id, r.source_id, r.target_id, r.kind, r.label, r.protocol, r.port, r.description, r.links, r.provenance, r.created_at, r.updated_at
    from public.relationships r where r.workspace_id = p_workspace and not r.deleted;
  insert into public.diagrams (workspace_id, id, name, description, view_type, scope_id, direction, hidden_relationship_ids, edge_kinds, color_by, notation, flows, created_at, updated_at)
    select v_id, d.id, d.name, d.description, d.view_type, d.scope_id, d.direction, d.hidden_relationship_ids, d.edge_kinds, d.color_by, d.notation, d.flows, d.created_at, d.updated_at
    from public.diagrams d where d.workspace_id = p_workspace and not d.deleted;
  insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y, pinned)
    select v_id, n.diagram_id, n.object_id, n.x, n.y, n.pinned
    from public.diagram_nodes n where n.workspace_id = p_workspace and not n.deleted;
  perform set_config('archone.audit_off', '', true);

  perform public.audit_write(p_workspace, 'scenario', v_id::text, btrim(p_name), 'created', '{}'::jsonb);
  perform public.audit_write(v_id, 'scenario', v_id::text, btrim(p_name), 'created', jsonb_build_object('copied from', v_source.name));
  return v_id;
end
$$;

-- The public trust page shows the picture, never the steps of a flow. Links were never part of it.
create or replace function public.trust_view(p_token text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_page public.trust_pages;
  v_ws public.workspaces;
  v_source jsonb;
  v_published boolean;
  v_diagram jsonb;
  v_nodes jsonb := '[]'::jsonb;
  v_objects jsonb;
  v_relationships jsonb;
begin
  select * into v_page from public.trust_pages t where t.token = p_token and t.enabled;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  select * into v_ws from public.workspaces w where w.id = v_page.workspace_id;
  v_published := v_ws.review_required;
  if v_published then
    select v.snapshot into v_source from public.versions v where v.id = v_ws.published_version_id;
    if v_source is null then
      return jsonb_build_object('status', 'unpublished');
    end if;
  else
    v_source := jsonb_build_object(
      'objects', coalesce((select jsonb_agg(to_jsonb(o)) from public.objects o where o.workspace_id = v_ws.id and not o.deleted), '[]'::jsonb),
      'relationships', coalesce((select jsonb_agg(to_jsonb(r)) from public.relationships r where r.workspace_id = v_ws.id and not r.deleted), '[]'::jsonb),
      'diagrams', coalesce((select jsonb_agg(to_jsonb(d) - 'workspace_id' - 'changed_by') from public.diagrams d where d.workspace_id = v_ws.id and d.id = v_page.diagram_id and not d.deleted), '[]'::jsonb),
      'nodes', coalesce((select jsonb_agg(to_jsonb(n) - 'workspace_id' - 'changed_by') from public.diagram_nodes n where n.workspace_id = v_ws.id and n.diagram_id = v_page.diagram_id and not n.deleted), '[]'::jsonb)
    );
  end if;

  -- A diagram that has gone, or is not in the published version yet, leaves the page without a picture.
  select d into v_diagram from jsonb_array_elements(v_source -> 'diagrams') d where d ->> 'id' = v_page.diagram_id;
  if v_diagram is not null then
    select coalesce(jsonb_agg(n), '[]'::jsonb) into v_nodes from jsonb_array_elements(v_source -> 'nodes') n where n ->> 'diagram_id' = v_page.diagram_id;
    -- The steps of a flow are written for the team, not for the public.
    v_diagram := jsonb_set(v_diagram, '{description}', '""'::jsonb) - 'flows';
  end if;

  with recursive every as (
    select o ->> 'id' as id, o ->> 'parent_id' as parent_id, o as obj,
      lower(btrim(coalesce(o -> 'fields' ->> 'Personal data', ''))) ~ '^(yes|y|true|1)$' as personal,
      btrim(coalesce(o -> 'fields' ->> 'Data residency', '')) as residency,
      (o ->> 'type_id') = 'external-system' as external
    from jsonb_array_elements(v_source -> 'objects') o
  ), rels as (
    select r, r ->> 'source_id' as s, r ->> 'target_id' as t from jsonb_array_elements(v_source -> 'relationships') r
  ), shown as (
    select e.id from every e where v_diagram is not null and (e.id in (select n ->> 'object_id' from jsonb_array_elements(v_nodes) n) or e.id = v_diagram ->> 'scope_id')
  ), inside as (
    select s.id, true as visible from shown s
    union
    select e.id, false from every e join inside i on e.parent_id = i.id
  ), drawn as (
    select i.id, bool_or(i.visible) as visible from inside i group by i.id
  ), near as (
    -- Outside parties and other regions that personal data may reach.
    select distinct e.id from every e
    join rels x on e.id in (x.s, x.t)
    join every p on p.id = case when e.id = x.s then x.t else x.s end
    where p.personal and p.id <> e.id and (e.external or e.residency <> '')
  ), wanted as (
    select e.id, e.parent_id, e.obj, e.personal, e.residency, e.external,
      coalesce(d.visible, false) as visible, d.id is not null as drawn, n.id is not null as near
    from every e left join drawn d on d.id = e.id left join near n on n.id = e.id
    where d.id is not null or e.personal or n.id is not null
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
        'id', w.id,
        'type_id', w.obj ->> 'type_id',
        'parent_id', case when exists (select 1 from wanted p where p.id = w.parent_id) then w.parent_id end,
        'name', case when w.visible or (w.external and w.near) then w.obj ->> 'name' else '' end,
        'lifecycle', case when w.visible then w.obj ->> 'lifecycle' else 'active' end,
        'fields', jsonb_strip_nulls(jsonb_build_object(
          'Personal data', case when w.personal then 'Yes' end,
          'Data residency', nullif(w.residency, ''),
          'Public purpose', case when w.external and w.near then nullif(btrim(coalesce(w.obj -> 'fields' ->> 'Public purpose', '')), '') end)),
        'created_at', w.obj ->> 'created_at',
        'updated_at', w.obj ->> 'updated_at'
      )) from wanted w), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.r ->> 'id', 'source_id', x.s, 'target_id', x.t, 'kind', x.r ->> 'kind',
        'label', case when a.visible and b.visible then coalesce(x.r ->> 'label', '') else '' end,
        'created_at', x.r ->> 'created_at', 'updated_at', x.r ->> 'updated_at'
      ))
      from rels x join wanted a on a.id = x.s join wanted b on b.id = x.t
      where (a.drawn and b.drawn) or a.personal or b.personal), '[]'::jsonb)
  into v_objects, v_relationships;

  return jsonb_build_object(
    'status', 'ok',
    'source', case when v_published then 'published' else 'working' end,
    'title', v_page.title, 'intro', v_page.intro, 'contact', v_page.contact,
    'diagram', v_diagram, 'nodes', v_nodes, 'objects', v_objects, 'relationships', v_relationships,
    'at', now()
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Protected live links
-- ---------------------------------------------------------------------------

alter table public.embeds add column protected boolean not null default false;
alter table public.embeds add column expires_at timestamptz;

-- The password of a link, salted and hashed, and the count of wrong guesses. Kept apart from
-- the link itself so that it is never written to the audit log and never selected by the app.
create table public.embed_secrets (
  embed_id uuid primary key references public.embeds (id) on delete cascade,
  salt text not null,
  hash text not null,
  failed integer not null default 0,
  locked_until timestamptz
);
alter table public.embed_secrets enable row level security;
revoke all on public.embed_secrets from public, anon, authenticated;

-- Salted SHA-256, repeated, with the built-in sha256() so no further extension is needed.
create function public.embed_password_hash(p_salt text, p_password text) returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v bytea := sha256(convert_to(p_salt || ':' || p_password, 'UTF8'));
begin
  for i in 1..5000 loop
    v := sha256(v || convert_to(p_salt, 'UTF8'));
  end loop;
  return encode(v, 'hex');
end
$$;

drop function public.create_embed(uuid, text);
create function public.create_embed(p_workspace uuid, p_diagram text, p_password text default null, p_expires_at timestamptz default null) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_token text := left(public.random_token(), 40);
  v_id uuid;
  v_salt text := left(public.random_token(), 32);
  v_password text := coalesce(p_password, '');
begin
  if not public.can_edit(p_workspace) then
    raise exception 'Only owners and editors can create a live link.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.diagrams d where d.workspace_id = p_workspace and d.id = p_diagram and not d.deleted) then
    raise exception 'That diagram no longer exists.' using errcode = 'P0002';
  end if;
  if (select count(*) from public.embeds e where e.workspace_id = p_workspace and e.revoked_at is null) >= 200 then
    raise exception 'This workspace already has 200 live links. Switch some off first.' using errcode = 'P0001';
  end if;
  if v_password <> '' and (char_length(v_password) < 8 or char_length(v_password) > 200) then
    raise exception 'Use a password of at least 8 characters.' using errcode = 'P0001';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'Choose a date in the future for the link to stop working.' using errcode = 'P0001';
  end if;
  insert into public.embeds (token, workspace_id, diagram_id, created_by, protected, expires_at)
  values (v_token, p_workspace, p_diagram, auth.uid(), v_password <> '', p_expires_at) returning id into v_id;
  if v_password <> '' then
    insert into public.embed_secrets (embed_id, salt, hash) values (v_id, v_salt, public.embed_password_hash(v_salt, v_password));
  end if;
  return v_token;
end
$$;

-- What a live link shows. Callable without signing in: the token is the permission, and for
-- a protected link the password as well. Links to repositories and dashboards are left out,
-- because they often point at internal tools.
drop function public.embed_view(text);
create function public.embed_view(p_token text, p_password text default null) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_embed public.embeds;
  v_ws public.workspaces;
  v_source jsonb;
  v_diagram jsonb;
  v_nodes jsonb;
  v_objects jsonb;
  v_relationships jsonb;
  v_published boolean;
  v_secret public.embed_secrets;
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
  v_published := v_ws.review_required;
  if v_published then
    select v.snapshot into v_source from public.versions v where v.id = v_ws.published_version_id;
    if v_source is null then
      return jsonb_build_object('status', 'unpublished');
    end if;
  else
    v_source := jsonb_build_object(
      'objects', coalesce((select jsonb_agg(to_jsonb(o) - 'workspace_id' - 'changed_by') from public.objects o where o.workspace_id = v_ws.id and not o.deleted), '[]'::jsonb),
      'relationships', coalesce((select jsonb_agg(to_jsonb(r) - 'workspace_id' - 'changed_by') from public.relationships r where r.workspace_id = v_ws.id and not r.deleted), '[]'::jsonb),
      'diagrams', coalesce((select jsonb_agg(to_jsonb(d) - 'workspace_id' - 'changed_by') from public.diagrams d where d.workspace_id = v_ws.id and d.id = v_embed.diagram_id and not d.deleted), '[]'::jsonb),
      'nodes', coalesce((select jsonb_agg(to_jsonb(n) - 'workspace_id' - 'changed_by') from public.diagram_nodes n where n.workspace_id = v_ws.id and n.diagram_id = v_embed.diagram_id and not n.deleted), '[]'::jsonb)
    );
  end if;

  select d into v_diagram from jsonb_array_elements(v_source -> 'diagrams') d where d ->> 'id' = v_embed.diagram_id;
  if v_diagram is null then
    return jsonb_build_object('status', case when v_published then 'unpublished' else 'gone' end);
  end if;
  select coalesce(jsonb_agg(n), '[]'::jsonb) into v_nodes from jsonb_array_elements(v_source -> 'nodes') n where n ->> 'diagram_id' = v_embed.diagram_id;

  with recursive every as (
    select o ->> 'id' as id, o ->> 'parent_id' as parent_id, o as obj from jsonb_array_elements(v_source -> 'objects') o
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
      from jsonb_array_elements(v_source -> 'relationships') r
      join wanted ws on ws.id = r ->> 'source_id'
      join wanted wt on wt.id = r ->> 'target_id'), '[]'::jsonb)
  into v_objects, v_relationships;

  return jsonb_build_object(
    'status', 'ok',
    'source', case when v_published then 'published' else 'working' end,
    'diagram', v_diagram, 'nodes', v_nodes, 'objects', v_objects, 'relationships', v_relationships,
    'at', now()
  );
end
$$;

revoke execute on function public.create_embed(uuid, text, text, timestamptz), public.embed_view(text, text), public.embed_password_hash(text, text) from public, anon, authenticated;
grant execute on function public.create_embed(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.embed_view(text, text) to anon, authenticated;
grant select (protected, expires_at) on public.embeds to authenticated;
