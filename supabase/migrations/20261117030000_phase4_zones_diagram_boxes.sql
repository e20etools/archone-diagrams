-- ArchONE Diagrams, phase 4: network zones, and boxes that stand for other diagrams.
--
--  * A network zone is a kind of object on the system level: servers, applications and
--    databases are put inside it, and the zone is drawn around them. It belongs to the
--    Infrastructure category.
--  * A diagram box stands for another diagram of the workspace, so a component can connect to
--    everything that diagram shows. It belongs to no category: the workspace role decides who
--    changes it. The diagram it stands for is kept in diagram_ref.

insert into public.object_types (id, level) values ('zone', 2), ('diagram', 2) on conflict (id) do nothing;

alter table public.objects add column diagram_ref text check (diagram_ref is null or char_length(diagram_ref) between 1 and 64);

create or replace function public.type_categories(p_type text) returns text[]
language sql immutable set search_path = ''
as $$
  select case
    when p_type in ('domain', 'actor') then array['applications', 'business']
    when p_type in ('system', 'external-system', 'application', 'web-app', 'mobile-app', 'service', 'component', 'ai-agent', 'ai-model', 'mcp-server') then array['applications']
    when p_type in ('database', 'queue', 'cache', 'storage') then array['data']
    when p_type in ('gateway', 'server', 'cluster', 'network', 'zone') then array['infrastructure']
    when p_type in ('process', 'task', 'event', 'decision') then array['business']
    else array[]::text[]
  end
$$;
