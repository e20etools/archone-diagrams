-- ArchONE Diagrams, phase 4: a public trust page.
--
-- One page per workspace, open to anyone who has its address, that says where personal data
-- is kept, which outside parties receive it and between which regions it moves. An owner
-- switches it on, writes its heading, and may choose one diagram to show with it.
--
-- Very little leaves the workspace. trust_view() sends:
--   * the outside systems connected to something that holds personal data, by name, with
--     their region and their "Public purpose" field;
--   * the systems that hold personal data, and their neighbours that state a region, with no
--     name: only whether they hold personal data and which region they are in;
--   * the chosen diagram, with the names and kinds of its boxes and the labels of its arrows.
-- Descriptions, owners, tags, technology, protocols, classifications and every other field
-- stay behind. With review switched on, the page is drawn from the published version.

create table public.trust_pages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces (id) on delete cascade,
  -- The secret part of the address until the page is shared; after that it is simply the address.
  token text not null unique,
  enabled boolean not null default false,
  title text not null default '' check (char_length(title) <= 160),
  intro text not null default '' check (char_length(intro) <= 4000),
  contact text not null default '' check (char_length(contact) <= 300),
  diagram_id text,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.trust_pages enable row level security;
revoke all on public.trust_pages from anon, authenticated;
grant select on public.trust_pages to authenticated;
create policy "owners see the trust page settings" on public.trust_pages for select to authenticated using (public.is_owner(workspace_id));

create trigger audit after insert or update or delete on public.trust_pages for each row execute function public.audit_row('trust page', 'title', 'token,updated_by');

create function public.set_trust_page(p_workspace uuid, p_enabled boolean, p_title text, p_intro text, p_contact text, p_diagram text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_page public.trust_pages;
  v_diagram text := nullif(btrim(coalesce(p_diagram, '')), '');
begin
  if not public.is_owner(p_workspace) then
    raise exception 'Only an owner can change the trust page.' using errcode = '42501';
  end if;
  if coalesce(p_enabled, false) and btrim(coalesce(p_title, '')) = '' then
    raise exception 'Give the page a heading before switching it on.' using errcode = 'P0001';
  end if;
  if v_diagram is not null and not exists (select 1 from public.diagrams d where d.workspace_id = p_workspace and d.id = v_diagram and not d.deleted) then
    raise exception 'That diagram no longer exists.' using errcode = 'P0002';
  end if;
  insert into public.trust_pages (workspace_id, token, enabled, title, intro, contact, diagram_id, updated_by)
  values (p_workspace, left(public.random_token(), 32), coalesce(p_enabled, false), btrim(coalesce(p_title, '')), btrim(coalesce(p_intro, '')), btrim(coalesce(p_contact, '')), v_diagram, auth.uid())
  on conflict (workspace_id) do update set enabled = excluded.enabled, title = excluded.title, intro = excluded.intro, contact = excluded.contact, diagram_id = excluded.diagram_id, updated_by = excluded.updated_by, updated_at = now()
  returning * into v_page;
  return jsonb_build_object('token', v_page.token, 'enabled', v_page.enabled, 'title', v_page.title, 'intro', v_page.intro, 'contact', v_page.contact, 'diagram_id', v_page.diagram_id, 'updated_at', v_page.updated_at);
end
$$;

-- What the public page is built from. Callable without signing in.
create function public.trust_view(p_token text) returns jsonb
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
    v_diagram := jsonb_set(v_diagram, '{description}', '""'::jsonb);
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

revoke all on function public.set_trust_page(uuid, boolean, text, text, text, text), public.trust_view(text) from public, anon, authenticated;
grant execute on function public.set_trust_page(uuid, boolean, text, text, text, text) to authenticated;
grant execute on function public.trust_view(text) to anon, authenticated;
