-- ArchONE Diagrams, phase 2 integration: a REST API with keys, webhooks, and live links.
--
-- API       An owner creates keys for a workspace. A request carries a key; api_request()
--           checks it and does the work. All of the API's rules live in this file, so they are
--           the same whatever sits in front of the database.
-- Webhooks  After a change to the model is saved, each of the workspace's webhooks is sent a
--           signed note of what changed. Sending needs Supabase's pg_net extension.
-- Live links  A link that shows one diagram, read-only and up to date, to anyone who has
--           it, until someone switches it off. Used for sharing and for embedding in a wiki.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- The object types the application knows, and how high each sits in the nesting.
-- Kept equal to src/lib/catalog.ts; a test compares the two.
create table public.object_types (
  id text primary key,
  level integer not null check (level between 1 and 4)
);
insert into public.object_types (id, level) values
  ('domain', 1), ('actor', 2), ('system', 2), ('external-system', 2),
  ('application', 3), ('web-app', 3), ('mobile-app', 3), ('service', 3), ('database', 3), ('queue', 3),
  ('cache', 3), ('storage', 3), ('gateway', 3), ('server', 3), ('cluster', 3), ('network', 3),
  ('component', 4);

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- The first characters of the key, so its owner can tell keys apart. The key itself is never stored.
  prefix text not null,
  key_hash text not null unique,
  access text not null check (access in ('read', 'write')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_workspace on public.api_keys (workspace_id);

create table public.api_usage (
  key_id uuid not null references public.api_keys (id) on delete cascade,
  minute timestamptz not null,
  calls integer not null default 0,
  primary key (key_id, minute)
);

create table public.webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  url text not null check (char_length(url) <= 2000),
  -- Signs each delivery so the receiver can tell it came from here.
  secret text not null,
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index webhooks_workspace on public.webhooks (workspace_id);

create table public.embeds (
  id uuid primary key default gen_random_uuid(),
  -- The secret part of the link. Whoever has it can see the diagram.
  token text not null unique,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  diagram_id text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index embeds_workspace on public.embeds (workspace_id, diagram_id);

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

-- 61 characters of randomness, from the database's own generator.
create function public.random_token() returns text
language sql volatile set search_path = ''
as $$ select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') $$;

create function public.sha256_hex(p_text text) returns text
language sql immutable set search_path = ''
as $$ select encode(sha256(convert_to(p_text, 'UTF8')), 'hex') $$;

-- HMAC-SHA256 (RFC 2104) with the built-in sha256(), so webhooks need no further extension.
create function public.hmac_sha256(p_key bytea, p_message bytea) returns bytea
language plpgsql immutable set search_path = ''
as $$
declare
  v_key bytea := p_key;
  v_inner bytea := decode(repeat('36', 64), 'hex');
  v_outer bytea := decode(repeat('5c', 64), 'hex');
  i integer;
begin
  if length(v_key) > 64 then
    v_key := sha256(v_key);
  end if;
  v_key := v_key || decode(repeat('00', 64 - length(v_key)), 'hex');
  for i in 0..63 loop
    v_inner := set_byte(v_inner, i, get_byte(v_key, i) # 54);
    v_outer := set_byte(v_outer, i, get_byte(v_key, i) # 92);
  end loop;
  return sha256(v_outer || sha256(v_inner || p_message));
end
$$;

-- ---------------------------------------------------------------------------
-- API keys
-- ---------------------------------------------------------------------------

-- Returns the key once. Only its hash is kept, so it cannot be shown again.
create function public.create_api_key(p_workspace uuid, p_name text, p_access text)
returns table (id uuid, key text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text := 'ark_' || left(public.random_token(), 44);
  v_id uuid;
begin
  if not public.is_owner(p_workspace) then
    raise exception 'Only an owner can create API keys.' using errcode = '42501';
  end if;
  if p_access is null or p_access not in ('read', 'write') then
    raise exception 'Choose read or write access for the key.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.api_keys k where k.workspace_id = p_workspace and k.revoked_at is null) >= 20 then
    raise exception 'This workspace already has 20 active API keys. Revoke one first.' using errcode = 'P0001';
  end if;
  insert into public.api_keys (workspace_id, name, prefix, key_hash, access, created_by)
  values (p_workspace, btrim(p_name), left(v_key, 12), public.sha256_hex(v_key), p_access, auth.uid())
  returning api_keys.id into v_id;
  return query select v_id, v_key;
end
$$;

create function public.revoke_api_key(p_key uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.api_keys k set revoked_at = now()
  where k.id = p_key and k.revoked_at is null and public.is_owner(k.workspace_id);
  if not found then
    raise exception 'That key no longer exists, or you are not an owner of its workspace.' using errcode = '42501';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The API itself
-- ---------------------------------------------------------------------------

create function public.api_reply(p_status integer, p_body jsonb) returns jsonb
language sql immutable set search_path = ''
as $$ select jsonb_build_object('status', p_status, 'body', p_body) $$;

create function public.api_error(p_status integer, p_code text, p_message text) returns jsonb
language sql immutable set search_path = ''
as $$ select jsonb_build_object('status', p_status, 'body', jsonb_build_object('error', jsonb_build_object('code', p_code, 'message', p_message))) $$;

create function public.api_object(o public.objects) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id, 'typeId', o.type_id, 'name', o.name, 'description', o.description, 'owner', o.owner,
    'lifecycle', o.lifecycle, 'tags', to_jsonb(o.tags), 'parentId', o.parent_id, 'technology', o.technology,
    'fields', o.fields, 'origin', o.provenance ->> 'origin', 'createdAt', o.created_at, 'updatedAt', o.updated_at
  )
$$;

create function public.api_relationship(r public.relationships) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'sourceId', r.source_id, 'targetId', r.target_id, 'kind', r.kind, 'label', r.label,
    'protocol', r.protocol, 'port', r.port, 'description', r.description,
    'origin', r.provenance ->> 'origin', 'createdAt', r.created_at, 'updatedAt', r.updated_at
  )
$$;

create function public.api_diagram(d public.diagrams) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id, 'name', d.name, 'description', d.description, 'viewType', d.view_type, 'scopeId', d.scope_id,
    'direction', d.direction, 'createdAt', d.created_at, 'updatedAt', d.updated_at,
    'nodes', coalesce((
      select jsonb_agg(jsonb_build_object('objectId', n.object_id, 'x', n.x, 'y', n.y, 'pinned', n.pinned) order by n.object_id)
      from public.diagram_nodes n where n.workspace_id = d.workspace_id and n.diagram_id = d.id and not n.deleted
    ), '[]'::jsonb)
  )
$$;

-- Raised inside the API to stop with a reply; api_request() turns it into that reply.
create function public.api_fail(p_status integer, p_code text, p_message text) returns void
language plpgsql set search_path = ''
as $$
begin
  raise exception '%', p_message using errcode = 'AR' || p_status::text, hint = p_code;
end
$$;

create function public.api_text(p_body jsonb, p_field text, p_limit integer, p_default text default '') returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v jsonb := p_body -> p_field;
begin
  if v is null or v = 'null'::jsonb then
    return p_default;
  end if;
  if jsonb_typeof(v) <> 'string' then
    perform public.api_fail(422, 'invalid', format('"%s" has to be text.', p_field));
  end if;
  if char_length(v #>> '{}') > p_limit then
    perform public.api_fail(422, 'invalid', format('"%s" is longer than %s characters.', p_field, p_limit));
  end if;
  return v #>> '{}';
end
$$;

-- Checks the fields of an object that a request sends, and returns the row with them applied.
create function public.api_apply_object(p_row public.objects, p_body jsonb, p_new boolean) returns public.objects
language plpgsql stable set search_path = ''
as $$
declare
  o public.objects := p_row;
  v_level integer;
  v_parent public.objects;
  v_parent_level integer;
begin
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    perform public.api_fail(400, 'invalid', 'Send a JSON object.');
  end if;
  if p_new or p_body ? 'name' then
    o.name := btrim(regexp_replace(public.api_text(p_body, 'name', 300), '\s+', ' ', 'g'));
    if o.name = '' then
      perform public.api_fail(422, 'invalid', '"name" is required.');
    end if;
  end if;
  if p_new or p_body ? 'typeId' then
    o.type_id := public.api_text(p_body, 'typeId', 64);
    if not exists (select 1 from public.object_types t where t.id = o.type_id) then
      perform public.api_fail(422, 'invalid', format('"typeId" has to be one of: %s.', (select string_agg(t.id, ', ' order by t.level, t.id) from public.object_types t)));
    end if;
  end if;
  if p_body ? 'description' then o.description := public.api_text(p_body, 'description', 20000); end if;
  if p_body ? 'owner' then o.owner := public.api_text(p_body, 'owner', 300); end if;
  if p_body ? 'technology' then o.technology := public.api_text(p_body, 'technology', 300); end if;
  if p_body ? 'lifecycle' then
    o.lifecycle := public.api_text(p_body, 'lifecycle', 20, 'active');
    if o.lifecycle not in ('planned', 'active', 'deprecated', 'retired') then
      perform public.api_fail(422, 'invalid', '"lifecycle" has to be planned, active, deprecated or retired.');
    end if;
  end if;
  if p_body ? 'tags' then
    if jsonb_typeof(p_body -> 'tags') <> 'array' or jsonb_array_length(p_body -> 'tags') > 30
       or exists (select 1 from jsonb_array_elements(p_body -> 'tags') e where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') > 60) then
      perform public.api_fail(422, 'invalid', '"tags" has to be a list of up to 30 short texts.');
    end if;
    o.tags := coalesce((select array_agg(distinct lower(btrim(e #>> '{}')) order by lower(btrim(e #>> '{}'))) from jsonb_array_elements(p_body -> 'tags') e where btrim(e #>> '{}') <> ''), '{}');
  end if;
  if p_body ? 'fields' then
    if jsonb_typeof(p_body -> 'fields') <> 'object' or exists (select 1 from jsonb_each(p_body -> 'fields') f where jsonb_typeof(f.value) <> 'string') or pg_column_size(p_body -> 'fields') > 20000 then
      perform public.api_fail(422, 'invalid', '"fields" has to be an object whose values are text.');
    end if;
    o.fields := p_body -> 'fields';
  end if;
  if p_body ? 'parentId' then
    o.parent_id := nullif(public.api_text(p_body, 'parentId', 64, null), '');
  end if;
  -- The nesting rule: an object sits inside one of a higher level. Levels only go down, so there are no loops.
  if o.parent_id is not null then
    select t.level into v_level from public.object_types t where t.id = o.type_id;
    select * into v_parent from public.objects p where p.workspace_id = o.workspace_id and p.id = o.parent_id and not p.deleted;
    if not found then
      perform public.api_fail(422, 'invalid', format('"parentId" %s is not an object in this workspace.', o.parent_id));
    end if;
    select t.level into v_parent_level from public.object_types t where t.id = v_parent.type_id;
    if coalesce(v_parent_level, 9) >= coalesce(v_level, 0) then
      perform public.api_fail(422, 'invalid', format('A %s cannot sit inside a %s. The parent has to be of a higher level.', o.type_id, v_parent.type_id));
    end if;
  end if;
  o.updated_at := now();
  return o;
end
$$;

create function public.api_page(p_query jsonb) returns integer
language sql immutable set search_path = ''
as $$ select least(500, greatest(1, coalesce(nullif(regexp_replace(coalesce(p_query ->> 'limit', ''), '\D', '', 'g'), '')::integer, 100))) $$;

create function public.api_objects(p_ws uuid, p_method text, p_id text, p_query jsonb, p_body jsonb, p_source text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  o public.objects;
  v_limit integer := public.api_page(p_query);
  v_rows jsonb;
  v_last text;
  v_since timestamptz;
  v_children integer;
begin
  if p_id is null then
    if p_method = 'GET' then
      begin
        v_since := nullif(p_query ->> 'updatedSince', '')::timestamptz;
      exception when others then
        perform public.api_fail(422, 'invalid', '"updatedSince" has to be a date and time, for example 2026-01-31T00:00:00Z.');
      end;
      select coalesce(jsonb_agg(public.api_object(t) order by t.id), '[]'::jsonb), max(t.id) into v_rows, v_last
      from (
        select * from public.objects x
        where x.workspace_id = p_ws and not x.deleted
          and (p_query ->> 'cursor' is null or x.id > p_query ->> 'cursor')
          and (p_query ->> 'type' is null or x.type_id = p_query ->> 'type')
          and (p_query ->> 'lifecycle' is null or x.lifecycle = p_query ->> 'lifecycle')
          and (p_query ->> 'owner' is null or lower(x.owner) = lower(p_query ->> 'owner'))
          and (p_query ->> 'tag' is null or lower(p_query ->> 'tag') = any (x.tags))
          and (p_query ->> 'parent' is null or x.parent_id = p_query ->> 'parent')
          and (p_query ->> 'q' is null or position(lower(p_query ->> 'q') in lower(x.name)) > 0)
          and (v_since is null or x.updated_at >= v_since)
        order by x.id limit v_limit
      ) t;
      return public.api_reply(200, jsonb_build_object('data', v_rows, 'nextCursor', case when jsonb_array_length(v_rows) = v_limit then v_last end));
    elsif p_method = 'POST' then
      if (select count(*) from public.objects x where x.workspace_id = p_ws and not x.deleted) >= 20000 then
        perform public.api_fail(422, 'limit', 'This workspace already holds 20000 objects.');
      end if;
      o.workspace_id := p_ws;
      o.id := 'obj_' || left(public.random_token(), 12);
      o.description := ''; o.owner := ''; o.lifecycle := 'active'; o.tags := '{}'; o.technology := ''; o.fields := '{}';
      o.provenance := jsonb_build_object('origin', 'api', 'source', p_source);
      o.created_at := now(); o.deleted := false;
      o := public.api_apply_object(o, p_body, true);
      insert into public.objects select o.*;
      return public.api_reply(201, public.api_object(o));
    end if;
    perform public.api_fail(405, 'method', 'Use GET or POST on /objects.');
  end if;

  select * into o from public.objects x where x.workspace_id = p_ws and x.id = p_id and not x.deleted;
  if not found then
    perform public.api_fail(404, 'not_found', format('There is no object %s in this workspace.', p_id));
  end if;
  if p_method = 'GET' then
    return public.api_reply(200, public.api_object(o));
  elsif p_method = 'PATCH' then
    o := public.api_apply_object(o, p_body, false);
    -- A new type must still sit above everything inside the object.
    select count(*) into v_children from public.objects c join public.object_types ct on ct.id = c.type_id
    where c.workspace_id = p_ws and c.parent_id = o.id and not c.deleted
      and ct.level <= (select t.level from public.object_types t where t.id = o.type_id);
    if v_children > 0 then
      perform public.api_fail(422, 'invalid', format('%s object(s) inside this one would no longer fit under a %s.', v_children, o.type_id));
    end if;
    update public.objects x set type_id = o.type_id, name = o.name, description = o.description, owner = o.owner, lifecycle = o.lifecycle,
      tags = o.tags, parent_id = o.parent_id, technology = o.technology, fields = o.fields, updated_at = o.updated_at
    where x.workspace_id = p_ws and x.id = o.id;
    return public.api_reply(200, public.api_object(o));
  elsif p_method = 'DELETE' then
    -- As in the application: what was inside moves up one level, and the object's arrows and boxes go with it.
    update public.objects c set parent_id = o.parent_id, updated_at = now() where c.workspace_id = p_ws and c.parent_id = o.id and not c.deleted;
    update public.relationships r set deleted = true where r.workspace_id = p_ws and not r.deleted and (r.source_id = o.id or r.target_id = o.id);
    update public.diagram_nodes n set deleted = true where n.workspace_id = p_ws and n.object_id = o.id and not n.deleted;
    update public.diagrams d set scope_id = null, updated_at = now() where d.workspace_id = p_ws and d.scope_id = o.id and not d.deleted;
    update public.objects x set deleted = true where x.workspace_id = p_ws and x.id = o.id;
    return public.api_reply(204, null);
  end if;
  perform public.api_fail(405, 'method', 'Use GET, PATCH or DELETE on /objects/{id}.');
  return null;
end
$$;

create function public.api_relationships(p_ws uuid, p_method text, p_id text, p_query jsonb, p_body jsonb, p_source text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.relationships;
  v_existing public.relationships;
  v_limit integer := public.api_page(p_query);
  v_rows jsonb;
  v_last text;
  v_kinds constant text[] := array['calls', 'depends_on', 'reads_writes', 'hosted_on', 'routes_to', 'replicates_to'];
begin
  if p_method in ('POST', 'PATCH') and (p_body is null or jsonb_typeof(p_body) <> 'object') then
    perform public.api_fail(400, 'invalid', 'Send a JSON object.');
  end if;
  if p_id is null then
    if p_method = 'GET' then
      select coalesce(jsonb_agg(public.api_relationship(t) order by t.id), '[]'::jsonb), max(t.id) into v_rows, v_last
      from (
        select * from public.relationships x
        where x.workspace_id = p_ws and not x.deleted
          and (p_query ->> 'cursor' is null or x.id > p_query ->> 'cursor')
          and (p_query ->> 'source' is null or x.source_id = p_query ->> 'source')
          and (p_query ->> 'target' is null or x.target_id = p_query ->> 'target')
          and (p_query ->> 'object' is null or x.source_id = p_query ->> 'object' or x.target_id = p_query ->> 'object')
          and (p_query ->> 'kind' is null or x.kind = p_query ->> 'kind')
        order by x.id limit v_limit
      ) t;
      return public.api_reply(200, jsonb_build_object('data', v_rows, 'nextCursor', case when jsonb_array_length(v_rows) = v_limit then v_last end));
    elsif p_method = 'POST' then
      r.workspace_id := p_ws;
      r.source_id := public.api_text(p_body, 'sourceId', 64);
      r.target_id := public.api_text(p_body, 'targetId', 64);
      r.kind := public.api_text(p_body, 'kind', 20, 'calls');
      if r.source_id = '' or r.target_id = '' then
        perform public.api_fail(422, 'invalid', '"sourceId" and "targetId" are required.');
      end if;
      if r.source_id = r.target_id then
        perform public.api_fail(422, 'invalid', 'A relationship needs two different objects.');
      end if;
      if (select count(*) from public.objects o where o.workspace_id = p_ws and not o.deleted and o.id in (r.source_id, r.target_id)) <> 2 then
        perform public.api_fail(422, 'invalid', '"sourceId" and "targetId" have to be objects in this workspace.');
      end if;
      if not r.kind = any (v_kinds) then
        perform public.api_fail(422, 'invalid', format('"kind" has to be one of: %s.', array_to_string(v_kinds, ', ')));
      end if;
      -- The same source, target and kind is stored once; asking again returns what is stored.
      select * into v_existing from public.relationships x
      where x.workspace_id = p_ws and not x.deleted and x.source_id = r.source_id and x.target_id = r.target_id and x.kind = r.kind;
      if found then
        return public.api_reply(200, public.api_relationship(v_existing));
      end if;
      r.id := 'rel_' || left(public.random_token(), 12);
      r.label := public.api_text(p_body, 'label', 300);
      r.protocol := public.api_text(p_body, 'protocol', 100);
      r.port := public.api_text(p_body, 'port', 100);
      r.description := public.api_text(p_body, 'description', 20000);
      r.provenance := jsonb_build_object('origin', 'api', 'source', p_source);
      r.created_at := now(); r.updated_at := now(); r.deleted := false;
      insert into public.relationships select r.*;
      return public.api_reply(201, public.api_relationship(r));
    end if;
    perform public.api_fail(405, 'method', 'Use GET or POST on /relationships.');
  end if;

  select * into r from public.relationships x where x.workspace_id = p_ws and x.id = p_id and not x.deleted;
  if not found then
    perform public.api_fail(404, 'not_found', format('There is no relationship %s in this workspace.', p_id));
  end if;
  if p_method = 'GET' then
    return public.api_reply(200, public.api_relationship(r));
  elsif p_method = 'PATCH' then
    if p_body ? 'sourceId' or p_body ? 'targetId' then
      perform public.api_fail(422, 'invalid', 'The ends of a relationship cannot be changed. Delete it and create another.');
    end if;
    if p_body ? 'kind' then
      r.kind := public.api_text(p_body, 'kind', 20, 'calls');
      if not r.kind = any (v_kinds) then
        perform public.api_fail(422, 'invalid', format('"kind" has to be one of: %s.', array_to_string(v_kinds, ', ')));
      end if;
      if exists (select 1 from public.relationships x where x.workspace_id = p_ws and not x.deleted and x.id <> r.id and x.source_id = r.source_id and x.target_id = r.target_id and x.kind = r.kind) then
        perform public.api_fail(409, 'conflict', 'A relationship of that kind already joins these two objects.');
      end if;
    end if;
    if p_body ? 'label' then r.label := public.api_text(p_body, 'label', 300); end if;
    if p_body ? 'protocol' then r.protocol := public.api_text(p_body, 'protocol', 100); end if;
    if p_body ? 'port' then r.port := public.api_text(p_body, 'port', 100); end if;
    if p_body ? 'description' then r.description := public.api_text(p_body, 'description', 20000); end if;
    r.updated_at := now();
    update public.relationships x set kind = r.kind, label = r.label, protocol = r.protocol, port = r.port, description = r.description, updated_at = r.updated_at
    where x.workspace_id = p_ws and x.id = r.id;
    return public.api_reply(200, public.api_relationship(r));
  elsif p_method = 'DELETE' then
    update public.relationships x set deleted = true where x.workspace_id = p_ws and x.id = r.id;
    update public.diagrams d set hidden_relationship_ids = array_remove(d.hidden_relationship_ids, r.id)
    where d.workspace_id = p_ws and r.id = any (d.hidden_relationship_ids);
    return public.api_reply(204, null);
  end if;
  perform public.api_fail(405, 'method', 'Use GET, PATCH or DELETE on /relationships/{id}.');
  return null;
end
$$;

-- Places boxes on a diagram from a list of { objectId, x, y, pinned }.
create function public.api_place_nodes(p_ws uuid, p_diagram text, p_nodes jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_node jsonb;
begin
  if p_nodes is null then
    return;
  end if;
  if jsonb_typeof(p_nodes) <> 'array' or jsonb_array_length(p_nodes) > 2000 then
    perform public.api_fail(422, 'invalid', '"nodes" has to be a list of up to 2000 boxes.');
  end if;
  for v_node in select * from jsonb_array_elements(p_nodes) loop
    if jsonb_typeof(v_node) <> 'object' or jsonb_typeof(v_node -> 'objectId') is distinct from 'string'
       or jsonb_typeof(coalesce(v_node -> 'x', '0')) <> 'number' or jsonb_typeof(coalesce(v_node -> 'y', '0')) <> 'number' then
      perform public.api_fail(422, 'invalid', 'Each box needs an "objectId" and may have numbers "x" and "y".');
    end if;
    if not exists (select 1 from public.objects o where o.workspace_id = p_ws and o.id = v_node ->> 'objectId' and not o.deleted) then
      perform public.api_fail(422, 'invalid', format('%s is not an object in this workspace.', v_node ->> 'objectId'));
    end if;
    insert into public.diagram_nodes (workspace_id, diagram_id, object_id, x, y, pinned, deleted)
    values (p_ws, p_diagram, v_node ->> 'objectId', coalesce((v_node ->> 'x')::double precision, 0), coalesce((v_node ->> 'y')::double precision, 0), coalesce((v_node ->> 'pinned')::boolean, true), false)
    on conflict (workspace_id, diagram_id, object_id) do update set x = excluded.x, y = excluded.y, pinned = excluded.pinned, deleted = false;
  end loop;
end
$$;

create function public.api_diagrams(p_ws uuid, p_method text, p_id text, p_query jsonb, p_body jsonb) returns jsonb
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
      if d.view_type not in ('landscape', 'context', 'container', 'deployment', 'dataflow', 'custom') or d.direction not in ('TB', 'LR') then
        perform public.api_fail(422, 'invalid', '"viewType" has to be landscape, context, container, deployment, dataflow or custom, and "direction" TB or LR.');
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

-- One request to the API. p_path is what follows the version, for example "/objects/obj_1".
-- Returns { "status": number, "body": json }; whatever serves the API passes both on.
create function public.api_request(p_key text, p_method text, p_path text, p_query jsonb default '{}', p_body jsonb default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_key public.api_keys;
  v_calls integer;
  v_method text := upper(coalesce(p_method, ''));
  v_parts text[] := string_to_array(btrim(coalesce(p_path, ''), '/'), '/');
  v_query jsonb := coalesce(p_query, '{}'::jsonb);
  v_what text;
  v_id text;
  v_state text;
  v_message text;
  v_hint text;
begin
  select * into v_key from public.api_keys k where k.key_hash = public.sha256_hex(coalesce(p_key, '')) and k.revoked_at is null;
  if not found then
    return public.api_error(401, 'unauthorized', 'The API key is missing, wrong or revoked. Send it as "Authorization: Bearer <key>".');
  end if;

  insert into public.api_usage as u (key_id, minute, calls) values (v_key.id, date_trunc('minute', now()), 1)
  on conflict (key_id, minute) do update set calls = u.calls + 1
  returning u.calls into v_calls;
  if v_calls > 300 then
    return public.api_error(429, 'rate_limited', 'More than 300 requests in a minute with this key. Wait for the next minute.');
  end if;
  if v_calls = 1 then
    delete from public.api_usage u where u.key_id = v_key.id and u.minute < now() - interval '1 hour';
    update public.api_keys k set last_used_at = now() where k.id = v_key.id;
  end if;

  if v_method not in ('GET', 'POST', 'PATCH', 'DELETE') then
    return public.api_error(405, 'method', 'Use GET, POST, PATCH or DELETE.');
  end if;
  if v_method <> 'GET' and v_key.access <> 'write' then
    return public.api_error(403, 'read_only', 'This key can only read. An owner can create a key with write access.');
  end if;
  v_what := coalesce(nullif(v_parts[1], ''), '');
  v_id := nullif(v_parts[2], '');
  if array_length(v_parts, 1) > 2 then
    return public.api_error(404, 'not_found', 'There is nothing at this address.');
  end if;

  begin
    if v_what = '' and v_method = 'GET' then
      return public.api_reply(200, jsonb_build_object(
        'workspace', (select jsonb_build_object('id', w.id, 'name', w.name) from public.workspaces w where w.id = v_key.workspace_id),
        'access', v_key.access, 'resources', jsonb_build_array('objects', 'relationships', 'diagrams', 'model')
      ));
    elsif v_what = 'model' and v_id is null and v_method = 'GET' then
      return public.api_reply(200, jsonb_build_object(
        'workspace', (select jsonb_build_object('id', w.id, 'name', w.name) from public.workspaces w where w.id = v_key.workspace_id),
        'objects', coalesce((select jsonb_agg(public.api_object(o) order by o.id) from public.objects o where o.workspace_id = v_key.workspace_id and not o.deleted), '[]'::jsonb),
        'relationships', coalesce((select jsonb_agg(public.api_relationship(r) order by r.id) from public.relationships r where r.workspace_id = v_key.workspace_id and not r.deleted), '[]'::jsonb),
        'diagrams', coalesce((select jsonb_agg(public.api_diagram(d) order by d.id) from public.diagrams d where d.workspace_id = v_key.workspace_id and not d.deleted), '[]'::jsonb)
      ));
    elsif v_what = 'objects' then
      return public.api_objects(v_key.workspace_id, v_method, v_id, v_query, p_body, 'API key: ' || v_key.name);
    elsif v_what = 'relationships' then
      return public.api_relationships(v_key.workspace_id, v_method, v_id, v_query, p_body, 'API key: ' || v_key.name);
    elsif v_what = 'diagrams' then
      return public.api_diagrams(v_key.workspace_id, v_method, v_id, v_query, p_body);
    end if;
    return public.api_error(404, 'not_found', 'There is nothing at this address. The resources are /objects, /relationships, /diagrams and /model.');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
    -- Replies raised on purpose carry their status in the code; a broken table rule is the caller's data; anything else is ours.
    if v_state like 'AR___' then
      return public.api_error(substr(v_state, 3)::integer, coalesce(nullif(v_hint, ''), 'invalid'), v_message);
    elsif v_state in ('23514', '23502', '22001', '22P02', '22003') then
      return public.api_error(422, 'invalid', 'A value in the request is not allowed: ' || v_message);
    end if;
    return public.api_error(500, 'server_error', 'The request could not be completed.');
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- Webhooks
-- ---------------------------------------------------------------------------

create function public.create_webhook(p_workspace uuid, p_url text)
returns table (id uuid, secret text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text := btrim(coalesce(p_url, ''));
  v_host text := lower(substring(v_url from '^https://([^/:?#]+)'));
  v_secret text := 'whsec_' || left(public.random_token(), 40);
  v_id uuid;
begin
  if not public.is_owner(p_workspace) then
    raise exception 'Only an owner can add webhooks.' using errcode = '42501';
  end if;
  -- Deliveries leave from the database's network, so they may only go to public https addresses.
  if v_host is null or char_length(v_url) > 2000 or position('.' in v_host) = 0 or v_host ~ '^[0-9.]+$' or v_host ~ '^\[' or v_host ~ '(^|\.)(localhost|local|internal|lan|home|corp)$' then
    raise exception 'Give a public https address with a host name, for example https://example.com/hooks/archone.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.webhooks w where w.workspace_id = p_workspace) >= 5 then
    raise exception 'This workspace already has 5 webhooks. Delete one first.' using errcode = 'P0001';
  end if;
  insert into public.webhooks (workspace_id, url, secret, created_by) values (p_workspace, v_url, v_secret, auth.uid()) returning webhooks.id into v_id;
  return query select v_id, v_secret;
end
$$;

-- Queues one signed delivery. The signature is the HMAC-SHA256 of the exact body, keyed with the webhook's secret.
create function public.deliver_webhook(p_url text, p_secret text, p_payload jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform net.http_post(
    url := p_url,
    body := p_payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-ArchONE-Event', p_payload ->> 'event',
      'X-ArchONE-Signature', 'sha256=' || encode(public.hmac_sha256(convert_to(p_secret, 'UTF8'), convert_to(p_payload::text, 'UTF8')), 'hex')
    ),
    timeout_milliseconds := 5000
  );
exception when others then
  -- A webhook that cannot be queued must never stop the model from being saved.
  null;
end
$$;

create function public.test_webhook(p_webhook uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_hook public.webhooks;
begin
  select * into v_hook from public.webhooks w where w.id = p_webhook and public.is_owner(w.workspace_id);
  if not found then
    raise exception 'That webhook no longer exists, or you are not an owner of its workspace.' using errcode = '42501';
  end if;
  perform public.deliver_webhook(v_hook.url, v_hook.secret, jsonb_build_object('event', 'ping', 'workspaceId', v_hook.workspace_id, 'at', now()));
end
$$;

-- After a statement changed model rows: one delivery per webhook, listing what changed.
create function public.notify_webhooks() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_batch record;
  v_hook record;
  v_payload jsonb;
begin
  for v_batch in
    select c.workspace_id,
      coalesce(jsonb_agg(distinct c.ref) filter (where not c.gone), '[]'::jsonb) as changed,
      coalesce(jsonb_agg(distinct c.ref) filter (where c.gone), '[]'::jsonb) as deleted
    from (
      -- A moved box is reported as a change to its diagram.
      select t.workspace_id, coalesce(to_jsonb(t) ->> 'id', to_jsonb(t) ->> 'diagram_id') as ref, (to_jsonb(t) ? 'id') and t.deleted as gone
      from changed_rows t
    ) c
    where exists (select 1 from public.webhooks w where w.workspace_id = c.workspace_id and w.active)
    group by c.workspace_id
  loop
    v_payload := jsonb_build_object('event', 'model.changed', 'workspaceId', v_batch.workspace_id, 'resource', tg_argv[0], 'changed', v_batch.changed, 'deleted', v_batch.deleted, 'at', now());
    for v_hook in select w.url, w.secret from public.webhooks w where w.workspace_id = v_batch.workspace_id and w.active loop
      perform public.deliver_webhook(v_hook.url, v_hook.secret, v_payload);
    end loop;
  end loop;
  return null;
exception when others then
  return null;
end
$$;

create trigger webhooks_on_insert after insert on public.objects referencing new table as changed_rows for each statement execute function public.notify_webhooks('objects');
create trigger webhooks_on_update after update on public.objects referencing new table as changed_rows for each statement execute function public.notify_webhooks('objects');
create trigger webhooks_on_insert after insert on public.relationships referencing new table as changed_rows for each statement execute function public.notify_webhooks('relationships');
create trigger webhooks_on_update after update on public.relationships referencing new table as changed_rows for each statement execute function public.notify_webhooks('relationships');
create trigger webhooks_on_insert after insert on public.diagrams referencing new table as changed_rows for each statement execute function public.notify_webhooks('diagrams');
create trigger webhooks_on_update after update on public.diagrams referencing new table as changed_rows for each statement execute function public.notify_webhooks('diagrams');
create trigger webhooks_on_insert after insert on public.diagram_nodes referencing new table as changed_rows for each statement execute function public.notify_webhooks('diagrams');
create trigger webhooks_on_update after update on public.diagram_nodes referencing new table as changed_rows for each statement execute function public.notify_webhooks('diagrams');

-- ---------------------------------------------------------------------------
-- Live links
-- ---------------------------------------------------------------------------

create function public.create_embed(p_workspace uuid, p_diagram text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_token text := left(public.random_token(), 40);
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
  insert into public.embeds (token, workspace_id, diagram_id, created_by) values (v_token, p_workspace, p_diagram, auth.uid());
  return v_token;
end
$$;

create function public.revoke_embed(p_embed uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.embeds e set revoked_at = now() where e.id = p_embed and e.revoked_at is null and public.can_edit(e.workspace_id);
  if not found then
    raise exception 'That link no longer exists, or you may not switch it off.' using errcode = '42501';
  end if;
end
$$;

-- What a live link shows. Callable without signing in: the token is the permission.
-- With review switched on it shows the published version, as a viewer would see it.
-- It returns the boxes on the diagram in full. Objects nested inside them are returned as
-- bare ids, and the relationships between those as bare ends, because the picture rolls
-- them up into the arrows between the boxes; their names and details are not sent.
create function public.embed_view(p_token text) returns jsonb
language plpgsql stable security definer set search_path = ''
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
begin
  select * into v_embed from public.embeds e where e.token = p_token and e.revoked_at is null;
  if not found then
    return jsonb_build_object('status', 'gone');
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
        then jsonb_set(e.obj, '{provenance}', jsonb_build_object('origin', coalesce(e.obj -> 'provenance' ->> 'origin', 'manual')))
        else jsonb_build_object('id', e.id, 'parent_id', e.parent_id, 'type_id', e.obj ->> 'type_id', 'name', '', 'created_at', e.obj ->> 'created_at', 'updated_at', e.obj ->> 'updated_at')
      end) from every e join wanted w on w.id = e.id), '[]'::jsonb),
    coalesce((select jsonb_agg(case when ws.visible and wt.visible
        then jsonb_set(r, '{provenance}', jsonb_build_object('origin', coalesce(r -> 'provenance' ->> 'origin', 'manual')))
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

-- A deleted diagram takes its live links with it.
create function public.revoke_embeds_of_deleted_diagram() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.deleted and not old.deleted then
    update public.embeds e set revoked_at = now() where e.workspace_id = new.workspace_id and e.diagram_id = new.id and e.revoked_at is null;
  end if;
  return null;
end
$$;
create trigger revoke_embeds after update of deleted on public.diagrams for each row execute function public.revoke_embeds_of_deleted_diagram();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on public.object_types, public.api_keys, public.api_usage, public.webhooks, public.embeds from anon, authenticated;

revoke execute on function
  public.random_token(), public.sha256_hex(text), public.hmac_sha256(bytea, bytea),
  public.create_api_key(uuid, text, text), public.revoke_api_key(uuid),
  public.api_reply(integer, jsonb), public.api_error(integer, text, text), public.api_fail(integer, text, text),
  public.api_object(public.objects), public.api_relationship(public.relationships), public.api_diagram(public.diagrams),
  public.api_text(jsonb, text, integer, text), public.api_apply_object(public.objects, jsonb, boolean), public.api_page(jsonb),
  public.api_objects(uuid, text, text, jsonb, jsonb, text), public.api_relationships(uuid, text, text, jsonb, jsonb, text),
  public.api_place_nodes(uuid, text, jsonb), public.api_diagrams(uuid, text, text, jsonb, jsonb),
  public.api_request(text, text, text, jsonb, jsonb),
  public.create_webhook(uuid, text), public.deliver_webhook(text, text, jsonb), public.test_webhook(uuid), public.notify_webhooks(),
  public.create_embed(uuid, text), public.revoke_embed(uuid), public.embed_view(text), public.revoke_embeds_of_deleted_diagram()
from public, anon, authenticated;

-- Owners see their keys and webhooks, but never a key's hash or a webhook's secret.
grant select (id, workspace_id, name, prefix, access, created_by, created_at, last_used_at, revoked_at) on public.api_keys to authenticated;
grant select (id, workspace_id, url, active, created_by, created_at) on public.webhooks to authenticated;
grant delete on public.webhooks to authenticated;
grant select (id, token, workspace_id, diagram_id, created_by, created_at, revoked_at) on public.embeds to authenticated;

grant execute on function
  public.create_api_key(uuid, text, text), public.revoke_api_key(uuid),
  public.create_webhook(uuid, text), public.test_webhook(uuid),
  public.create_embed(uuid, text), public.revoke_embed(uuid)
to authenticated;

-- The API and live links are reached without signing in: the key or the token is the permission.
grant execute on function public.api_request(text, text, text, jsonb, jsonb), public.embed_view(text) to anon, authenticated;

alter table public.object_types enable row level security;
alter table public.api_keys enable row level security;
alter table public.api_usage enable row level security;
alter table public.webhooks enable row level security;
alter table public.embeds enable row level security;

create policy "owners see API keys" on public.api_keys for select to authenticated using (public.is_owner(workspace_id));
create policy "owners see webhooks" on public.webhooks for select to authenticated using (public.is_owner(workspace_id));
create policy "owners delete webhooks" on public.webhooks for delete to authenticated using (public.is_owner(workspace_id));
create policy "editors see live links" on public.embeds for select to authenticated using (public.can_edit(workspace_id));
