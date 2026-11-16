-- ArchONE Diagrams, phase 4: which way a connection goes, and what it carries.
--
--  * flow: out (from the source to the target, the usual), in (from the target), or both.
--  * protocols: one or more protocols and ports; the protocol and port columns repeat them as text.
--  * network: what it runs over, such as MPLS or the Internet. encrypted: yes or no.
--  * A scenario's copy of a connection keeps all of these.

alter table public.relationships
  add column flow text check (flow in ('out', 'in', 'both')),
  add column protocols jsonb check (protocols is null or (jsonb_typeof(protocols) = 'array' and jsonb_array_length(protocols) <= 12 and pg_column_size(protocols) <= 8000)),
  add column network text check (network is null or char_length(network) <= 80),
  add column encrypted text check (encrypted in ('yes', 'no'));

create function public.inherit_connection_properties() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_source uuid := (select w.scenario_of from public.workspaces w where w.id = new.workspace_id);
begin
  if v_source is not null and new.flow is null and new.protocols is null and new.network is null and new.encrypted is null then
    select r.flow, r.protocols, r.network, r.encrypted into new.flow, new.protocols, new.network, new.encrypted
    from public.relationships r where r.workspace_id = v_source and r.id = new.id;
  end if;
  return new;
end
$$;
create trigger inherit_connection_properties before insert on public.relationships for each row execute function public.inherit_connection_properties();
revoke all on function public.inherit_connection_properties() from public, anon, authenticated;
