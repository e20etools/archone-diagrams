-- ArchONE Diagrams, phase 4: changes that arrive through the API or MCP wait for a person.
--
--  * A key can now have "propose" access: it reads the model and files proposals. A proposal
--    changes nothing until someone with edit access reviews it in the app.
--  * A key with write access can be limited to domains, exactly like an editor.
--  * New object types for AI: an agent, a model and an MCP server.

insert into public.object_types (id, level) values ('ai-agent', 3), ('ai-model', 3), ('mcp-server', 3);

alter table public.api_keys drop constraint api_keys_access_check;
alter table public.api_keys add constraint api_keys_access_check check (access in ('read', 'propose', 'write'));
alter table public.api_keys add column domains text[];

create or replace function public.create_api_key(p_workspace uuid, p_name text, p_access text)
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
  if p_access is null or p_access not in ('read', 'propose', 'write') then
    raise exception 'Choose read, propose or write access for the key.' using errcode = 'P0001';
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

-- Limits a write key to what sits inside the given domains. Null or empty removes the limit.
create function public.set_api_key_domains(p_key uuid, p_domains text[]) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_key public.api_keys;
  v_domains text[] := (select array_agg(distinct d order by d) from unnest(coalesce(p_domains, '{}')) d);
begin
  select * into v_key from public.api_keys k where k.id = p_key;
  if not found or not public.is_owner(v_key.workspace_id) then
    raise exception 'Only an owner can change an API key.' using errcode = '42501';
  end if;
  if v_key.access <> 'write' and v_domains is not null then
    raise exception 'Only a key with write access can be limited to domains.' using errcode = 'P0001';
  end if;
  if coalesce(array_length(v_domains, 1), 0) > 50 then
    raise exception 'A key can be limited to at most 50 domains.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from unnest(coalesce(v_domains, '{}')) d
    where not exists (select 1 from public.objects o where o.workspace_id = v_key.workspace_id and o.id = d and o.type_id = 'domain' and not o.deleted)
  ) then
    raise exception 'Every limit has to be a domain of this workspace.' using errcode = 'P0001';
  end if;
  update public.api_keys k set domains = v_domains where k.id = p_key;
end
$$;
revoke all on function public.set_api_key_domains(uuid, text[]) from public, anon;
grant execute on function public.set_api_key_domains(uuid, text[]) to authenticated;

-- The limit of whoever is making the change: a signed-in editor's, or the API key's of this request.
create or replace function public.my_domains(ws uuid) returns text[]
language sql stable security definer set search_path = ''
as $$
  select case
    when auth.uid() is null and nullif(current_setting('archone.api_key', true), '') is not null then
      (select k.domains from public.api_keys k where k.id = nullif(current_setting('archone.api_key', true), '')::uuid and k.workspace_id = ws)
    else
      (select m.domains from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'editor')
  end
$$;

-- One proposal as the API shows it.
create function public.api_proposal(p public.proposals) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'status', p.status, 'title', p.data ->> 'source', 'notes', p.data ->> 'notes', 'createdAt', p.created_at,
    'decidedBy', p.data ->> 'decidedBy', 'decidedAt', p.data ->> 'decidedAt',
    'objects', coalesce((select jsonb_agg(jsonb_build_object('key', o ->> 'key', 'name', o ->> 'name', 'typeId', o ->> 'typeId', 'existingId', o -> 'matchId', 'decision', o ->> 'decision') order by n) from jsonb_array_elements(p.data -> 'objects') with ordinality t(o, n)), '[]'::jsonb),
    'relationships', coalesce((select jsonb_agg(jsonb_build_object('key', r ->> 'key', 'sourceKey', r ->> 'sourceKey', 'targetKey', r ->> 'targetKey', 'kind', r ->> 'kind', 'decision', r ->> 'decision') order by n) from jsonb_array_elements(p.data -> 'relationships') with ordinality t(r, n)), '[]'::jsonb)
  )
$$;

-- /proposals: list the proposals this workspace received through the API, read one, or file a new one.
create function public.api_proposals(p_ws uuid, p_method text, p_id text, p_query jsonb, p_body jsonb, p_source text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_kinds constant text[] := array['calls', 'depends_on', 'reads_writes', 'hosted_on', 'routes_to', 'replicates_to', 'flows_to'];
  v_row public.proposals;
  v_objects jsonb := '[]'::jsonb;
  v_relationships jsonb := '[]'::jsonb;
  v_keys text[] := '{}';
  v_item jsonb;
  v_key text;
  v_name text;
  v_type text;
  v_match text;
  v_existing public.objects;
  v_provided text[];
  v_entry jsonb;
  v_end text;
  v_ends text[];
  v_n integer := 0;
  v_id text;
  v_title text;
  v_diagram text;
begin
  if p_method = 'GET' and p_id is null then
    return public.api_reply(200, jsonb_build_object('data', coalesce((
      select jsonb_agg(public.api_proposal(t) order by t.created_at desc)
      from (select * from public.proposals p where p.workspace_id = p_ws and not p.deleted and p.data ->> 'origin' = 'api'
              and (p_query ->> 'status' is null or p.status = p_query ->> 'status')
            order by p.created_at desc limit 100) t), '[]'::jsonb)));
  elsif p_method = 'GET' then
    select * into v_row from public.proposals p where p.workspace_id = p_ws and p.id = p_id and not p.deleted and p.data ->> 'origin' = 'api';
    if not found then
      perform public.api_fail(404, 'not_found', 'There is no proposal with this id.');
    end if;
    return public.api_reply(200, public.api_proposal(v_row));
  elsif p_method <> 'POST' or p_id is not null then
    perform public.api_fail(405, 'method', 'Proposals can be listed, read and created. A person decides them in the app.');
  end if;

  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    perform public.api_fail(400, 'invalid', 'Send a JSON object.');
  end if;
  v_title := btrim(public.api_text(p_body, 'title', 300));
  if v_title = '' then
    perform public.api_fail(422, 'invalid', '"title" is required: one line that tells the reviewer what this proposal is.');
  end if;
  if coalesce(jsonb_typeof(p_body -> 'objects'), 'array') <> 'array' or coalesce(jsonb_typeof(p_body -> 'relationships'), 'array') <> 'array' then
    perform public.api_fail(422, 'invalid', '"objects" and "relationships" have to be lists.');
  end if;
  if jsonb_array_length(coalesce(p_body -> 'objects', '[]')) > 200 or jsonb_array_length(coalesce(p_body -> 'relationships', '[]')) > 400 then
    perform public.api_fail(422, 'invalid', 'A proposal holds at most 200 objects and 400 relationships.');
  end if;
  if (select count(*) from public.proposals p where p.workspace_id = p_ws and p.status = 'pending' and not p.deleted and p.data ->> 'origin' = 'api') >= 50 then
    perform public.api_fail(409, 'too_many', 'This workspace already has 50 API proposals waiting for review.');
  end if;
  v_diagram := nullif(public.api_text(p_body, 'diagramId', 64, null), '');
  if v_diagram is not null and not exists (select 1 from public.diagrams d where d.workspace_id = p_ws and d.id = v_diagram and not d.deleted) then
    perform public.api_fail(422, 'invalid', format('"diagramId" %s is not a diagram in this workspace.', v_diagram));
  end if;

  for v_item in select e from jsonb_array_elements(coalesce(p_body -> 'objects', '[]')) e loop
    v_n := v_n + 1;
    if jsonb_typeof(v_item) <> 'object' then
      perform public.api_fail(422, 'invalid', 'Every object has to be a JSON object.');
    end if;
    v_match := nullif(public.api_text(v_item, 'id', 64, null), '');
    v_key := coalesce(nullif(public.api_text(v_item, 'key', 64, null), ''), v_match, 'o' || v_n);
    if v_key = any (v_keys) then
      perform public.api_fail(422, 'invalid', format('The key "%s" is used twice.', v_key));
    end if;
    v_provided := '{}';
    if v_match is not null then
      select * into v_existing from public.objects o where o.workspace_id = p_ws and o.id = v_match and not o.deleted;
      if not found then
        perform public.api_fail(422, 'invalid', format('"id" %s is not an object in this workspace.', v_match));
      end if;
      v_name := v_existing.name;
      v_type := coalesce(nullif(public.api_text(v_item, 'typeId', 64, null), ''), v_existing.type_id);
    else
      v_name := btrim(regexp_replace(public.api_text(v_item, 'name', 300), '\s+', ' ', 'g'));
      if v_name = '' then
        perform public.api_fail(422, 'invalid', 'Every new object needs a "name". To refer to an existing object, send its "id".');
      end if;
      v_type := public.api_text(v_item, 'typeId', 64, 'application');
      -- The same name as an existing object means that object, so a proposal never makes a duplicate.
      select * into v_existing from public.objects o where o.workspace_id = p_ws and not o.deleted and lower(o.name) = lower(v_name) order by o.id limit 1;
      v_match := case when found then v_existing.id end;
    end if;
    if not exists (select 1 from public.object_types t where t.id = v_type) then
      perform public.api_fail(422, 'invalid', format('"typeId" has to be one of: %s.', (select string_agg(t.id, ', ' order by t.level, t.id) from public.object_types t)));
    end if;
    if v_item ? 'lifecycle' and public.api_text(v_item, 'lifecycle', 20) not in ('planned', 'active', 'deprecated', 'retired') then
      perform public.api_fail(422, 'invalid', '"lifecycle" has to be planned, active, deprecated or retired.');
    end if;
    if v_item ? 'tags' and (jsonb_typeof(v_item -> 'tags') <> 'array' or jsonb_array_length(v_item -> 'tags') > 30
       or exists (select 1 from jsonb_array_elements(v_item -> 'tags') e where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') > 60)) then
      perform public.api_fail(422, 'invalid', '"tags" has to be a list of up to 30 short texts.');
    end if;
    -- On an existing object, accepting writes exactly the fields the request gave.
    if v_item ? 'typeId' then v_provided := array_append(v_provided, 'type'); end if;
    if v_item ? 'description' then v_provided := array_append(v_provided, 'description'); end if;
    if v_item ? 'owner' then v_provided := array_append(v_provided, 'owner'); end if;
    if v_item ? 'lifecycle' then v_provided := array_append(v_provided, 'lifecycle'); end if;
    if v_item ? 'technology' then v_provided := array_append(v_provided, 'technology'); end if;
    if v_item ? 'tags' then v_provided := array_append(v_provided, 'tags'); end if;
    if v_item ? 'parentKey' then v_provided := array_append(v_provided, 'parent'); end if;
    v_entry := jsonb_build_object(
      'key', v_key, 'name', v_name, 'typeId', v_type,
      'description', public.api_text(v_item, 'description', 20000),
      'technology', public.api_text(v_item, 'technology', 300),
      'parentKey', nullif(public.api_text(v_item, 'parentKey', 64, null), ''),
      'decision', 'pending', 'matchId', v_match, 'provided', to_jsonb(v_provided)
    );
    if v_item ? 'owner' then v_entry := v_entry || jsonb_build_object('owner', public.api_text(v_item, 'owner', 300)); end if;
    if v_item ? 'lifecycle' then v_entry := v_entry || jsonb_build_object('lifecycle', v_item ->> 'lifecycle'); end if;
    if v_item ? 'tags' then
      v_entry := v_entry || jsonb_build_object('tags', coalesce((select jsonb_agg(distinct lower(btrim(e #>> '{}'))) from jsonb_array_elements(v_item -> 'tags') e where btrim(e #>> '{}') <> ''), '[]'::jsonb));
    end if;
    v_objects := v_objects || jsonb_build_array(v_entry);
    v_keys := array_append(v_keys, v_key);
  end loop;

  v_n := 0;
  for v_item in select e from jsonb_array_elements(coalesce(p_body -> 'relationships', '[]')) e loop
    v_n := v_n + 1;
    if jsonb_typeof(v_item) <> 'object' then
      perform public.api_fail(422, 'invalid', 'Every relationship has to be a JSON object.');
    end if;
    v_ends := array[public.api_text(v_item, 'sourceKey', 64), public.api_text(v_item, 'targetKey', 64)];
    if v_ends[1] = '' or v_ends[2] = '' or v_ends[1] = v_ends[2] then
      perform public.api_fail(422, 'invalid', 'Every relationship needs a "sourceKey" and a different "targetKey": the key of an object in this proposal, or the id of an existing object.');
    end if;
    -- An end that names an existing object is added to the proposal as a reference, unchanged.
    foreach v_end in array v_ends loop
      if not v_end = any (v_keys) then
        select * into v_existing from public.objects o where o.workspace_id = p_ws and o.id = v_end and not o.deleted;
        if not found then
          perform public.api_fail(422, 'invalid', format('"%s" is neither a key in this proposal nor the id of an object in this workspace.', v_end));
        end if;
        v_objects := v_objects || jsonb_build_array(jsonb_build_object(
          'key', v_end, 'name', v_existing.name, 'typeId', v_existing.type_id, 'description', '', 'technology', '', 'parentKey', null,
          'decision', 'pending', 'matchId', v_existing.id, 'provided', '[]'::jsonb));
        v_keys := array_append(v_keys, v_end);
      end if;
    end loop;
    if not public.api_text(v_item, 'kind', 20, 'calls') = any (v_kinds) then
      perform public.api_fail(422, 'invalid', format('"kind" has to be one of: %s.', array_to_string(v_kinds, ', ')));
    end if;
    v_relationships := v_relationships || jsonb_build_array(jsonb_build_object(
      'key', 'r' || v_n, 'sourceKey', v_ends[1], 'targetKey', v_ends[2], 'kind', public.api_text(v_item, 'kind', 20, 'calls'),
      'label', public.api_text(v_item, 'label', 300), 'decision', 'pending',
      'protocol', public.api_text(v_item, 'protocol', 60), 'port', public.api_text(v_item, 'port', 20),
      'description', public.api_text(v_item, 'description', 20000)));
  end loop;

  if jsonb_array_length(v_objects) = 0 then
    perform public.api_fail(422, 'invalid', 'A proposal needs at least one object or relationship.');
  end if;
  -- A parent that names an existing object is added as a reference too.
  for v_end in select distinct o ->> 'parentKey' from jsonb_array_elements(v_objects) o where o ->> 'parentKey' is not null loop
    if not v_end = any (v_keys) then
      select * into v_existing from public.objects o where o.workspace_id = p_ws and o.id = v_end and not o.deleted;
      if not found then
        perform public.api_fail(422, 'invalid', format('The "parentKey" %s is neither a key in this proposal nor the id of an object in this workspace.', v_end));
      end if;
      v_objects := v_objects || jsonb_build_array(jsonb_build_object(
        'key', v_end, 'name', v_existing.name, 'typeId', v_existing.type_id, 'description', '', 'technology', '', 'parentKey', null,
        'decision', 'pending', 'matchId', v_existing.id, 'provided', '[]'::jsonb));
      v_keys := array_append(v_keys, v_end);
    end if;
  end loop;

  v_id := 'prop_' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  insert into public.proposals (workspace_id, id, status, data)
  values (p_ws, v_id, 'pending', jsonb_build_object(
    'id', v_id, 'origin', 'api', 'withoutDiagram', v_diagram is null, 'source', v_title, 'engine', p_source,
    'notes', public.api_text(p_body, 'notes', 4000), 'createdAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'status', 'pending', 'targetDiagramId', v_diagram, 'objects', v_objects, 'relationships', v_relationships))
  returning * into v_row;
  perform public.audit_write(p_ws, 'proposal', v_id, v_title, 'created',
    jsonb_build_object('objects', jsonb_array_length(v_objects), 'relationships', jsonb_array_length(v_relationships)));
  return public.api_reply(201, public.api_proposal(v_row));
end
$$;
revoke all on function public.api_proposal(public.proposals), public.api_proposals(uuid, text, text, jsonb, jsonb, text) from public, anon, authenticated;

-- The dispatcher behind api_request(), with proposals and the three kinds of access.
create or replace function public.api_dispatch(p_key text, p_method text, p_path text, p_query jsonb default '{}', p_body jsonb default null) returns jsonb
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
  v_what := coalesce(nullif(v_parts[1], ''), '');
  if v_method <> 'GET' and v_key.access = 'read' then
    return public.api_error(403, 'read_only', 'This key can only read. An owner can create a key that proposes or writes.');
  end if;
  if v_method <> 'GET' and v_key.access = 'propose' and v_what <> 'proposals' then
    return public.api_error(403, 'propose_only', 'This key cannot change the model directly. Send the change to POST /proposals and a person will review it in the app.');
  end if;
  v_id := nullif(v_parts[2], '');
  if array_length(v_parts, 1) > 2 then
    return public.api_error(404, 'not_found', 'There is nothing at this address.');
  end if;

  begin
    if v_what = '' and v_method = 'GET' then
      return public.api_reply(200, jsonb_build_object(
        'workspace', (select jsonb_build_object('id', w.id, 'name', w.name) from public.workspaces w where w.id = v_key.workspace_id),
        'access', v_key.access, 'resources', jsonb_build_array('objects', 'relationships', 'diagrams', 'model', 'proposals')
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
    elsif v_what = 'proposals' then
      return public.api_proposals(v_key.workspace_id, v_method, v_id, v_query, p_body, 'API key: ' || v_key.name);
    elsif v_what = 'diagrams' then
      return public.api_diagrams(v_key.workspace_id, v_method, v_id, v_query, p_body);
    end if;
    return public.api_error(404, 'not_found', 'There is nothing at this address. The resources are /objects, /relationships, /diagrams, /model and /proposals.');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
    -- Replies raised on purpose carry their status in the code; a broken table rule is the caller's data; anything else is ours.
    if v_state like 'AR___' then
      return public.api_error(substr(v_state, 3)::integer, coalesce(nullif(v_hint, ''), 'invalid'), v_message);
    elsif v_state = '42501' then
      return public.api_error(403, 'outside_limit', v_message);
    elsif v_state in ('23514', '23502', '22001', '22P02', '22003') then
      return public.api_error(422, 'invalid', 'A value in the request is not allowed: ' || v_message);
    end if;
    return public.api_error(500, 'server_error', 'The request could not be completed.');
  end;
end
$$;

-- The audit log records what became of every proposal.
create function public.audit_proposal() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    perform public.audit_write(new.workspace_id, 'proposal', new.id, coalesce(new.data ->> 'source', ''), new.status,
      jsonb_build_object('origin', new.data ->> 'origin', 'from', coalesce(new.data ->> 'engine', '')));
  end if;
  return null;
end
$$;
create trigger audit after update on public.proposals for each row execute function public.audit_proposal();
revoke all on function public.audit_proposal() from public, anon, authenticated;

grant select (domains) on public.api_keys to authenticated;
