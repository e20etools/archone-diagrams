-- ArchONE Diagrams, phase 4: business processes through the REST API and the MCP server.
--
--  * /processes lists the process landscape (with filters, among them which processes use a
--    system), /processes/{id} returns one process with its BPMN 2.0 file, what the app keeps
--    about its steps, its KPIs, risks, decision tables and published versions.
--  * A key with write access creates, changes, publishes and deletes processes. A key that may
--    only read or propose cannot, and neither can a write key limited to domains, since a
--    process is not inside a domain. Every change is in the audit log under the key's name.
--  * What is written is checked here and stored in the shape the app keeps, so a process made
--    through the API opens in the app like any other.
--  * Webhooks report changed processes with "resource": "processes".

create function public.api_iso_now() returns text
language sql stable set search_path = ''
as $$ select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- One process as the API shows it. The list leaves out the BPMN file and what goes with it.
create function public.api_process(p public.process_models, p_full boolean) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'name', d ->> 'name',
    'description', coalesce(d ->> 'description', ''),
    'level', coalesce((d ->> 'level')::integer, 2),
    'parentId', d ->> 'parentId',
    'category', coalesce(d ->> 'category', 'core'),
    'owner', coalesce(d ->> 'owner', ''),
    'status', coalesce(d ->> 'status', 'draft'),
    'version', coalesce((d ->> 'version')::integer, 0),
    'objectId', d ->> 'objectId',
    'tags', coalesce(d -> 'tags', '[]'::jsonb),
    'frequency', coalesce(d ->> 'frequency', ''),
    'modelled', coalesce(d ->> 'xml', '') <> '',
    'steps', (select count(*) from regexp_matches(coalesce(d ->> 'xml', ''), '<([A-Za-z0-9_-]+:)?(task|userTask|serviceTask|manualTask|scriptTask|businessRuleTask|sendTask|receiveTask|subProcess|callActivity|transaction)[\s/>]', 'g')),
    'kpis', coalesce(d -> 'kpis', '[]'::jsonb),
    'risks', coalesce(d -> 'risks', '[]'::jsonb),
    'createdAt', d ->> 'createdAt',
    'updatedAt', d ->> 'updatedAt'
  ) || case when p_full then jsonb_build_object(
    'xml', coalesce(d ->> 'xml', ''),
    'elements', coalesce(d -> 'elements', '{}'::jsonb),
    'decisions', coalesce(d -> 'decisions', '{}'::jsonb),
    'scenarios', coalesce(d -> 'scenarios', '[]'::jsonb),
    'mining', d -> 'mining',
    'reviewer', coalesce(d ->> 'reviewer', ''),
    'reviewNote', coalesce(d ->> 'reviewNote', ''),
    'versions', coalesce((select jsonb_agg(v - 'xml' order by (v ->> 'version')::integer desc) from jsonb_array_elements(coalesce(d -> 'versions', '[]'::jsonb)) v), '[]'::jsonb),
    -- The objects its steps use, by id, so a reader can name them without another request.
    'objects', coalesce((
      select jsonb_object_agg(o.id, jsonb_build_object('name', o.name, 'typeId', o.type_id))
      from public.objects o
      where o.workspace_id = p.workspace_id and not o.deleted
        and o.id in (select jsonb_array_elements_text(e.value -> 'objectIds') from jsonb_each(coalesce(d -> 'elements', '{}'::jsonb)) e where jsonb_typeof(e.value -> 'objectIds') = 'array')
    ), '{}'::jsonb)
  ) else '{}'::jsonb end
  from (select p.data as d) x
$$;

-- A number from the request, or null when it is not given. Anything else is refused.
create function public.api_number(p_body jsonb, p_field text, p_min numeric, p_max numeric) returns numeric
language plpgsql immutable set search_path = ''
as $$
declare
  v jsonb := p_body -> p_field;
begin
  if v is null or v = 'null'::jsonb then
    return null;
  end if;
  if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric < p_min or (v #>> '{}')::numeric > p_max then
    perform public.api_fail(422, 'invalid', format('"%s" has to be a number from %s to %s.', p_field, p_min, p_max));
  end if;
  return (v #>> '{}')::numeric;
end
$$;

-- What the app keeps about each step and flow, checked and in its shape.
create function public.api_process_elements(p jsonb) returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_val jsonb;
  v_el jsonb;
  v_ids jsonb;
  v_raci jsonb;
  v_d jsonb;
  v_min numeric;
  v_mode numeric;
  v_max numeric;
begin
  if p is null or p = 'null'::jsonb then
    return '{}'::jsonb;
  end if;
  if jsonb_typeof(p) <> 'object' then
    perform public.api_fail(422, 'invalid', '"elements" has to be an object keyed by the id of a step or a flow.');
  end if;
  if (select count(*) from jsonb_object_keys(p)) > 2000 then
    perform public.api_fail(422, 'invalid', '"elements" holds at most 2000 entries.');
  end if;
  for v_key, v_val in select e.key, e.value from jsonb_each(p) e loop
    if char_length(v_key) > 120 or jsonb_typeof(v_val) <> 'object' then
      perform public.api_fail(422, 'invalid', format('"elements" → "%s" has to be an object, under an id of at most 120 characters.', left(v_key, 40)));
    end if;
    v_ids := coalesce(v_val -> 'objectIds', '[]'::jsonb);
    if jsonb_typeof(v_ids) <> 'array' or jsonb_array_length(v_ids) > 100
       or exists (select 1 from jsonb_array_elements(v_ids) i where jsonb_typeof(i) <> 'string' or char_length(i #>> '{}') > 120) then
      perform public.api_fail(422, 'invalid', format('"objectIds" of "%s" has to be a list of up to 100 object ids.', v_key));
    end if;
    v_raci := coalesce(v_val -> 'raci', '{}'::jsonb);
    if jsonb_typeof(v_raci) <> 'object' or (select count(*) from jsonb_object_keys(v_raci)) > 30
       or exists (select 1 from jsonb_each(v_raci) r where char_length(r.key) > 80 or coalesce(r.value #>> '{}', '') not in ('R', 'A', 'C', 'I')) then
      perform public.api_fail(422, 'invalid', format('"raci" of "%s" has to map role names to R, A, C or I.', v_key));
    end if;
    v_el := jsonb_build_object('objectIds', (select coalesce(jsonb_agg(distinct i), '[]'::jsonb) from jsonb_array_elements(v_ids) i), 'raci', v_raci);
    v_d := v_val -> 'duration';
    if v_d is not null and v_d <> 'null'::jsonb then
      if jsonb_typeof(v_d) <> 'object' then
        perform public.api_fail(422, 'invalid', format('"duration" of "%s" has to be {"min", "mode", "max"} in minutes.', v_key));
      end if;
      v_mode := public.api_number(v_d, 'mode', 0, 10000000);
      v_min := coalesce(public.api_number(v_d, 'min', 0, 10000000), v_mode);
      v_max := coalesce(public.api_number(v_d, 'max', 0, 10000000), v_mode);
      v_mode := coalesce(v_mode, v_min, v_max);
      if v_mode is not null then
        -- Least ≤ usually ≤ most, whatever order they came in.
        v_min := least(v_min, v_mode);
        v_max := greatest(v_max, v_mode);
        v_el := v_el || jsonb_build_object('duration', jsonb_build_object('min', v_min, 'mode', v_mode, 'max', v_max));
      end if;
    end if;
    if v_val ? 'cost' and public.api_number(v_val, 'cost', 0, 1000000000) is not null then
      v_el := v_el || jsonb_build_object('cost', public.api_number(v_val, 'cost', 0, 1000000000));
    end if;
    if v_val ? 'probability' and public.api_number(v_val, 'probability', 0, 100) is not null then
      v_el := v_el || jsonb_build_object('probability', public.api_number(v_val, 'probability', 0, 100));
    end if;
    if nullif(btrim(public.api_text(v_val, 'resource', 80)), '') is not null then
      v_el := v_el || jsonb_build_object('resource', btrim(public.api_text(v_val, 'resource', 80)));
    end if;
    if v_val ? 'automation' and v_val -> 'automation' <> 'null'::jsonb then
      if public.api_text(v_val, 'automation', 20) not in ('manual', 'partly', 'automated', 'candidate') then
        perform public.api_fail(422, 'invalid', '"automation" has to be manual, partly, automated or candidate.');
      end if;
      v_el := v_el || jsonb_build_object('automation', v_val ->> 'automation');
    end if;
    if nullif(public.api_text(v_val, 'decisionId', 120), '') is not null then
      v_el := v_el || jsonb_build_object('decisionId', v_val ->> 'decisionId');
    end if;
    if nullif(public.api_text(v_val, 'calledProcessId', 120), '') is not null then
      v_el := v_el || jsonb_build_object('calledProcessId', v_val ->> 'calledProcessId');
    end if;
    if nullif(btrim(public.api_text(v_val, 'notes', 4000)), '') is not null then
      v_el := v_el || jsonb_build_object('notes', btrim(v_val ->> 'notes'));
    end if;
    v_out := v_out || jsonb_build_object(v_key, v_el);
  end loop;
  return v_out;
end
$$;

-- KPIs and risks, each a list the request replaces whole.
create function public.api_process_list(p jsonb, p_kind text) returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_id text;
begin
  if p is null or p = 'null'::jsonb then
    return '[]'::jsonb;
  end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 50 then
    perform public.api_fail(422, 'invalid', format('"%s" has to be a list of at most 50.', p_kind));
  end if;
  for v_item in select e from jsonb_array_elements(p) e loop
    if jsonb_typeof(v_item) <> 'object' or btrim(public.api_text(v_item, 'name', 200)) = '' then
      perform public.api_fail(422, 'invalid', format('Every entry of "%s" needs a "name".', p_kind));
    end if;
    v_id := coalesce(nullif(public.api_text(v_item, 'id', 64), ''), left(p_kind, 4) || '_' || left(public.random_token(), 10));
    if p_kind = 'kpis' then
      if coalesce(v_item ->> 'better', 'higher') not in ('higher', 'lower') then
        perform public.api_fail(422, 'invalid', '"better" has to be higher or lower.');
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'id', v_id, 'name', btrim(v_item ->> 'name'), 'unit', public.api_text(v_item, 'unit', 40),
        'target', public.api_text(v_item, 'target', 60), 'actual', public.api_text(v_item, 'actual', 60),
        'better', coalesce(v_item ->> 'better', 'higher')));
    else
      if coalesce(v_item ->> 'severity', 'medium') not in ('low', 'medium', 'high') then
        perform public.api_fail(422, 'invalid', '"severity" has to be low, medium or high.');
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'id', v_id, 'name', btrim(v_item ->> 'name'), 'severity', coalesce(v_item ->> 'severity', 'medium'),
        'control', public.api_text(v_item, 'control', 1000)));
    end if;
  end loop;
  return v_out;
end
$$;

-- The fields a request may set, applied to the stored process; status changes come after.
create function public.api_apply_process(p_ws uuid, p_id text, d jsonb, p_body jsonb, p_creating boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_parent public.process_models;
  v_level integer;
  v_xml text;
  v_name text;
  v_tags jsonb;
begin
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    perform public.api_fail(400, 'invalid', 'Send a JSON object.');
  end if;
  if p_body ? 'name' or p_creating then
    v_name := btrim(regexp_replace(public.api_text(p_body, 'name', 200), '\s+', ' ', 'g'));
    if v_name = '' then
      perform public.api_fail(422, 'invalid', '"name" is required: what the process is called, for example "Order to cash".');
    end if;
    d := d || jsonb_build_object('name', v_name);
  end if;
  if p_body ? 'description' then d := d || jsonb_build_object('description', btrim(public.api_text(p_body, 'description', 4000))); end if;
  if p_body ? 'owner' then d := d || jsonb_build_object('owner', btrim(public.api_text(p_body, 'owner', 120))); end if;
  if p_body ? 'frequency' then d := d || jsonb_build_object('frequency', btrim(public.api_text(p_body, 'frequency', 120))); end if;
  if p_body ? 'category' then
    if public.api_text(p_body, 'category', 20) not in ('management', 'core', 'support') then
      perform public.api_fail(422, 'invalid', '"category" has to be management, core or support.');
    end if;
    d := d || jsonb_build_object('category', p_body ->> 'category');
  end if;
  if p_body ? 'tags' then
    v_tags := p_body -> 'tags';
    if jsonb_typeof(v_tags) <> 'array' or jsonb_array_length(v_tags) > 30
       or exists (select 1 from jsonb_array_elements(v_tags) e where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') > 60) then
      perform public.api_fail(422, 'invalid', '"tags" has to be a list of up to 30 short texts.');
    end if;
    d := d || jsonb_build_object('tags', coalesce((select jsonb_agg(distinct lower(btrim(e #>> '{}'))) from jsonb_array_elements(v_tags) e where btrim(e #>> '{}') <> ''), '[]'::jsonb));
  end if;

  -- Where it sits: a parent above it in the landscape, never itself or something inside it.
  if p_body ? 'parentId' then
    if nullif(public.api_text(p_body, 'parentId', 120), '') is null then
      d := d || jsonb_build_object('parentId', null);
    else
      select * into v_parent from public.process_models x where x.workspace_id = p_ws and x.id = p_body ->> 'parentId' and not x.deleted;
      if not found then
        perform public.api_fail(422, 'invalid', format('"parentId" %s is not a process of this workspace.', p_body ->> 'parentId'));
      end if;
      if v_parent.id = p_id or v_parent.id in (
        with recursive inside(id) as (
          select x.id from public.process_models x where x.workspace_id = p_ws and not x.deleted and x.data ->> 'parentId' = p_id
          union select x.id from public.process_models x join inside i on x.data ->> 'parentId' = i.id where x.workspace_id = p_ws and not x.deleted
        ) select id from inside) then
        perform public.api_fail(422, 'invalid', 'A process cannot sit inside itself or inside a process that is inside it.');
      end if;
      d := d || jsonb_build_object('parentId', v_parent.id);
      if not p_body ? 'category' and p_creating then d := d || jsonb_build_object('category', coalesce(v_parent.data ->> 'category', 'core')); end if;
    end if;
  end if;
  if p_body ? 'level' then
    v_level := public.api_number(p_body, 'level', 0, 4)::integer;
    if v_level is null or public.api_number(p_body, 'level', 0, 4) <> v_level then
      perform public.api_fail(422, 'invalid', '"level" has to be a whole number from 0 (process area) to 4 (activity).');
    end if;
  elsif p_creating then
    v_level := case when v_parent.id is not null then least(4, coalesce((v_parent.data ->> 'level')::integer, 1) + 1) else 2 end;
  else
    v_level := coalesce((d ->> 'level')::integer, 2);
  end if;
  d := d || jsonb_build_object('level', v_level);
  if d ->> 'parentId' is not null and coalesce((select (x.data ->> 'level')::integer from public.process_models x where x.workspace_id = p_ws and x.id = d ->> 'parentId'), 0) >= v_level then
    perform public.api_fail(422, 'invalid', format('A process at level %s has to sit inside one at a lower level number.', v_level));
  end if;

  -- The BPMN file: read by the app's modeler, so it has to be BPMN 2.0 with its diagram.
  if p_body ? 'xml' then
    v_xml := coalesce(public.api_text(p_body, 'xml', 2500000), '');
    if v_xml <> '' and (
      position('http://www.omg.org/spec/BPMN/20100524/MODEL' in v_xml) = 0
      or v_xml !~ '<([A-Za-z0-9_-]+:)?definitions[\s>]'
      or v_xml ~* '<!(DOCTYPE|ENTITY)'
    ) then
      perform public.api_fail(422, 'invalid', '"xml" has to be a BPMN 2.0 file (the definitions element in the BPMN 2.0 model namespace), without a DOCTYPE.');
    end if;
    if v_xml <> '' and v_xml !~ 'BPMNDiagram' then
      perform public.api_fail(422, 'invalid', 'The BPMN file has no diagram (BPMNDiagram) to show. Export it with its diagram, or send "steps" and "flows" and the API lays it out.');
    end if;
    d := d || jsonb_build_object('xml', v_xml);
  elsif p_creating and v_level >= 2 and p_body ? 'defaultXml' then
    -- The empty model the API's handler lays out for a new process: a start, one step and an end.
    return public.api_apply_process(p_ws, p_id, d, (p_body - 'defaultXml') || jsonb_build_object('xml', p_body -> 'defaultXml', 'level', v_level), true);
  end if;
  if p_body ? 'elements' then d := d || jsonb_build_object('elements', public.api_process_elements(p_body -> 'elements')); end if;
  if p_body ? 'kpis' then d := d || jsonb_build_object('kpis', public.api_process_list(p_body -> 'kpis', 'kpis')); end if;
  if p_body ? 'risks' then d := d || jsonb_build_object('risks', public.api_process_list(p_body -> 'risks', 'risks')); end if;
  return d;
end
$$;

-- Draft, in review, published as the next version (keeping the ten latest), or retired.
create function public.api_process_status(d jsonb, p_body jsonb, p_source text) returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_status text := public.api_text(p_body, 'status', 20, null);
  v_note text := btrim(public.api_text(p_body, 'note', 500));
  v_version integer;
begin
  if v_status is null then
    if p_body ? 'reviewer' then d := d || jsonb_build_object('reviewer', btrim(public.api_text(p_body, 'reviewer', 120))); end if;
    return d;
  end if;
  if v_status not in ('draft', 'review', 'published', 'retired') then
    perform public.api_fail(422, 'invalid', '"status" has to be draft, review, published or retired.');
  end if;
  if v_status = 'published' then
    if coalesce(d ->> 'xml', '') = '' then
      perform public.api_fail(422, 'invalid', 'A process without a model cannot be published. Send "xml" or "steps" first.');
    end if;
    v_version := coalesce((d ->> 'version')::integer, 0) + 1;
    d := d || jsonb_build_object(
      'version', v_version,
      'versions', jsonb_build_array(jsonb_build_object('version', v_version, 'publishedAt', public.api_iso_now(), 'publishedBy', p_source, 'note', v_note, 'xml', d ->> 'xml'))
        || coalesce((select jsonb_agg(v order by n) from jsonb_array_elements(coalesce(d -> 'versions', '[]'::jsonb)) with ordinality t(v, n) where n <= 9), '[]'::jsonb));
  end if;
  if v_status = 'review' and p_body ? 'reviewer' then
    d := d || jsonb_build_object('reviewer', btrim(public.api_text(p_body, 'reviewer', 120)));
  end if;
  d := d || jsonb_build_object('status', v_status);
  if v_note <> '' then d := d || jsonb_build_object('reviewNote', v_note); end if;
  return d;
end
$$;

-- /processes and /processes/{id}.
create function public.api_processes(p_ws uuid, p_method text, p_id text, p_query jsonb, p_body jsonb, p_source text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.process_models;
  v_limit integer := public.api_page(p_query);
  v_rows jsonb;
  v_last text;
  v_since timestamptz;
  v_now text := public.api_iso_now();
  v_id text;
  d jsonb;
begin
  if p_method <> 'GET' and coalesce(array_length(public.my_domains(p_ws), 1), 0) > 0 then
    perform public.api_fail(403, 'outside_limit', 'This key is limited to domains, and a process is not inside a domain. An owner can give processes to a key without a limit.');
  end if;

  if p_id is null then
    if p_method = 'GET' then
      begin
        v_since := nullif(p_query ->> 'updatedSince', '')::timestamptz;
      exception when others then
        perform public.api_fail(422, 'invalid', '"updatedSince" has to be a date and time, for example 2026-01-31T00:00:00Z.');
      end;
      select coalesce(jsonb_agg(public.api_process(t, false) order by t.id), '[]'::jsonb), max(t.id) into v_rows, v_last
      from (
        select * from public.process_models x
        where x.workspace_id = p_ws and not x.deleted
          and (p_query ->> 'cursor' is null or x.id > p_query ->> 'cursor')
          and (p_query ->> 'status' is null or coalesce(x.data ->> 'status', 'draft') = p_query ->> 'status')
          and (p_query ->> 'category' is null or coalesce(x.data ->> 'category', 'core') = p_query ->> 'category')
          and (p_query ->> 'level' is null or coalesce(x.data ->> 'level', '2') = p_query ->> 'level')
          and (p_query ->> 'parent' is null or coalesce(x.data ->> 'parentId', '') = case when p_query ->> 'parent' in ('', 'none') then '' else p_query ->> 'parent' end)
          and (p_query ->> 'owner' is null or lower(coalesce(x.data ->> 'owner', '')) = lower(p_query ->> 'owner'))
          and (p_query ->> 'q' is null or position(lower(p_query ->> 'q') in lower(x.data ->> 'name')) > 0)
          and (p_query ->> 'uses' is null or x.data ->> 'objectId' = p_query ->> 'uses' or exists (
                select 1 from jsonb_each(coalesce(x.data -> 'elements', '{}'::jsonb)) e
                where jsonb_typeof(e.value -> 'objectIds') = 'array' and e.value -> 'objectIds' ? (p_query ->> 'uses')))
          and (v_since is null or x.changed_at >= v_since)
        order by x.id limit v_limit
      ) t;
      return public.api_reply(200, jsonb_build_object('data', v_rows, 'nextCursor', case when jsonb_array_length(v_rows) = v_limit then v_last end));
    elsif p_method = 'POST' then
      if (select count(*) from public.process_models x where x.workspace_id = p_ws and not x.deleted) >= 2000 then
        perform public.api_fail(422, 'limit', 'This workspace already holds 2000 processes.');
      end if;
      v_id := 'proc_' || left(public.random_token(), 10);
      d := jsonb_build_object(
        'id', v_id, 'name', '', 'description', '', 'level', 2, 'parentId', null, 'category', 'core', 'owner', '',
        'status', 'draft', 'version', 0, 'objectId', null, 'tags', '[]'::jsonb, 'frequency', '', 'xml', '',
        'elements', '{}'::jsonb, 'kpis', '[]'::jsonb, 'risks', '[]'::jsonb, 'decisions', '{}'::jsonb, 'scenarios', '[]'::jsonb,
        'versions', '[]'::jsonb, 'reviewer', '', 'reviewNote', '', 'createdAt', v_now, 'updatedAt', v_now);
      d := public.api_apply_process(p_ws, v_id, d, p_body, true);
      d := public.api_process_status(d, p_body, p_source);
      insert into public.process_models (workspace_id, id, data) values (p_ws, v_id, d) returning * into v_row;
      return public.api_reply(201, public.api_process(v_row, true));
    end if;
    perform public.api_fail(405, 'method', 'Use GET or POST on /processes.');
  end if;

  select * into v_row from public.process_models x where x.workspace_id = p_ws and x.id = p_id and not x.deleted;
  if not found then
    perform public.api_fail(404, 'not_found', format('There is no process %s in this workspace.', p_id));
  end if;
  if p_method = 'GET' then
    return public.api_reply(200, public.api_process(v_row, true));
  elsif p_method = 'PATCH' then
    d := public.api_apply_process(p_ws, p_id, v_row.data, p_body, false);
    d := public.api_process_status(d, p_body, p_source);
    d := d || jsonb_build_object('updatedAt', v_now);
    update public.process_models x set data = d where x.workspace_id = p_ws and x.id = p_id returning * into v_row;
    return public.api_reply(200, public.api_process(v_row, true));
  elsif p_method = 'DELETE' then
    -- As in the application: what was inside moves up to its parent.
    update public.process_models x
      set data = x.data || jsonb_build_object('parentId', v_row.data -> 'parentId', 'updatedAt', v_now)
    where x.workspace_id = p_ws and not x.deleted and x.data ->> 'parentId' = p_id;
    update public.process_models x set deleted = true where x.workspace_id = p_ws and x.id = p_id;
    return public.api_reply(204, null);
  end if;
  perform public.api_fail(405, 'method', 'Use GET, PATCH or DELETE on /processes/{id}.');
  return null;
end
$$;

revoke all on function
  public.api_iso_now(), public.api_process(public.process_models, boolean), public.api_number(jsonb, text, numeric, numeric),
  public.api_process_elements(jsonb), public.api_process_list(jsonb, text), public.api_apply_process(uuid, text, jsonb, jsonb, boolean),
  public.api_process_status(jsonb, jsonb, text), public.api_processes(uuid, text, text, jsonb, jsonb, text)
from public, anon, authenticated;

-- The dispatcher, now with /processes, and processes in /model (without their BPMN files).
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
  if v_method <> 'GET' and v_key.access = 'propose' and v_what = 'processes' then
    return public.api_error(403, 'propose_only', 'This key may only propose, and processes are changed by a key with write access. An owner can create one under Settings; every change it makes is in the audit log.');
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
        'access', v_key.access, 'resources', jsonb_build_array('objects', 'relationships', 'diagrams', 'model', 'proposals', 'processes')
      ));
    elsif v_what = 'model' and v_id is null and v_method = 'GET' then
      return public.api_reply(200, jsonb_build_object(
        'workspace', (select jsonb_build_object('id', w.id, 'name', w.name) from public.workspaces w where w.id = v_key.workspace_id),
        'objects', coalesce((select jsonb_agg(public.api_object(o) order by o.id) from public.objects o where o.workspace_id = v_key.workspace_id and not o.deleted), '[]'::jsonb),
        'relationships', coalesce((select jsonb_agg(public.api_relationship(r) order by r.id) from public.relationships r where r.workspace_id = v_key.workspace_id and not r.deleted), '[]'::jsonb),
        'diagrams', coalesce((select jsonb_agg(public.api_diagram(d) order by d.id) from public.diagrams d where d.workspace_id = v_key.workspace_id and not d.deleted), '[]'::jsonb),
        'processes', coalesce((select jsonb_agg(public.api_process(p, false) order by p.id) from public.process_models p where p.workspace_id = v_key.workspace_id and not p.deleted), '[]'::jsonb)
      ));
    elsif v_what = 'objects' then
      return public.api_objects(v_key.workspace_id, v_method, v_id, v_query, p_body, 'API key: ' || v_key.name);
    elsif v_what = 'relationships' then
      return public.api_relationships(v_key.workspace_id, v_method, v_id, v_query, p_body, 'API key: ' || v_key.name);
    elsif v_what = 'proposals' then
      return public.api_proposals(v_key.workspace_id, v_method, v_id, v_query, p_body, 'API key: ' || v_key.name);
    elsif v_what = 'diagrams' then
      return public.api_diagrams(v_key.workspace_id, v_method, v_id, v_query, p_body);
    elsif v_what = 'processes' then
      return public.api_processes(v_key.workspace_id, v_method, v_id, v_query, p_body, 'API key: ' || v_key.name);
    end if;
    return public.api_error(404, 'not_found', 'There is nothing at this address. The resources are /objects, /relationships, /diagrams, /model, /proposals and /processes.');
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

-- Webhooks: a changed process is reported like a changed object.
create trigger webhooks_on_insert after insert on public.process_models referencing new table as changed_rows for each statement execute function public.notify_webhooks('processes');
create trigger webhooks_on_update after update on public.process_models referencing new table as changed_rows for each statement execute function public.notify_webhooks('processes');

-- A process published again (its version moves on while it stays published) is a publication too.
create or replace function public.audit_process_model() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := coalesce(new.data ->> 'name', new.id);
  v_status text := coalesce(new.data ->> 'status', 'draft');
begin
  if tg_op = 'INSERT' or (old.deleted and not new.deleted) then
    perform public.audit_write(new.workspace_id, 'process', new.id, v_name, 'added', jsonb_build_object('status', v_status));
  elsif new.deleted and not old.deleted then
    perform public.audit_write(new.workspace_id, 'process', new.id, v_name, 'deleted', '{}'::jsonb);
  elsif coalesce(old.data ->> 'status', 'draft') <> v_status
     or (v_status = 'published' and coalesce(old.data ->> 'version', '0') <> coalesce(new.data ->> 'version', '0')) then
    perform public.audit_write(new.workspace_id, 'process', new.id, v_name,
      case v_status when 'published' then 'published version ' || coalesce(new.data ->> 'version', '?') when 'review' then 'sent for review' when 'retired' then 'retired' else 'back to draft' end,
      jsonb_build_object('from', coalesce(old.data ->> 'status', 'draft'), 'to', v_status));
  elsif (new.data - 'updatedAt' - 'mining') is distinct from (old.data - 'updatedAt' - 'mining') then
    perform public.audit_write(new.workspace_id, 'process', new.id, v_name, 'changed',
      jsonb_build_object('model', (new.data ->> 'xml') is distinct from (old.data ->> 'xml')));
  end if;
  return null;
end
$$;
revoke all on function public.audit_process_model() from public, anon, authenticated;
