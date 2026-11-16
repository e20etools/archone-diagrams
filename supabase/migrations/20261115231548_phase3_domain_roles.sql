-- ArchONE Diagrams, phase 3: roles scoped per domain (PRD NFR-02).
--
-- An owner can limit an editor to one or more domains. That editor then changes only what
-- sits inside those domains: objects there, and relationships that start or end there. They
-- still read the whole model and may arrange diagrams. Owners, and editors with no limit,
-- are unaffected. The rule is enforced here, so it also holds for anything that does not go
-- through the app's screens.

alter table public.workspace_members add column domains text[];

-- The signed-in person's limit in a workspace: null when they have none.
create function public.my_domains(ws uuid) returns text[]
language sql stable security definer set search_path = ''
as $$
  select m.domains from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'editor'
$$;

-- True when the object sits inside one of the domains, at any depth. The domain itself does not count.
create function public.inside_domains(ws uuid, p_object text, p_domains text[]) returns boolean
language sql stable security definer set search_path = ''
as $$
  with recursive up as (
    select o.parent_id as id, 1 as depth from public.objects o where o.workspace_id = ws and o.id = p_object
    union all
    select o.parent_id, up.depth + 1 from up join public.objects o on o.workspace_id = ws and o.id = up.id where up.id is not null and up.depth < 12
  )
  select exists (select 1 from up where up.id = any (p_domains))
$$;

create function public.guard_domain_scope() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_domains text[] := public.my_domains(new.workspace_id);
  v_ok boolean;
begin
  if v_domains is null then
    return new;
  end if;
  if tg_table_name = 'objects' then
    -- Where it is going has to be inside, and so has where it was.
    v_ok := new.parent_id is not null and (new.parent_id = any (v_domains) or public.inside_domains(new.workspace_id, new.parent_id, v_domains));
    if tg_op = 'UPDATE' then
      v_ok := v_ok and old.parent_id is not null and (old.parent_id = any (v_domains) or public.inside_domains(new.workspace_id, old.parent_id, v_domains));
    end if;
  else
    v_ok := public.inside_domains(new.workspace_id, new.source_id, v_domains) or public.inside_domains(new.workspace_id, new.target_id, v_domains);
    if tg_op = 'UPDATE' and v_ok then
      v_ok := public.inside_domains(new.workspace_id, old.source_id, v_domains) or public.inside_domains(new.workspace_id, old.target_id, v_domains);
    end if;
  end if;
  if not v_ok then
    raise exception 'You can only change what is inside the domains you were given.' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger guard_domain_scope before insert or update on public.objects for each row execute function public.guard_domain_scope();
create trigger guard_domain_scope before insert or update on public.relationships for each row execute function public.guard_domain_scope();

-- A limit belongs to the editor role; any other role has none.
create function public.clear_domains_with_role() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.role <> 'editor' then
    new.domains := null;
  end if;
  return new;
end
$$;
create trigger clear_domains_with_role before insert or update on public.workspace_members for each row execute function public.clear_domains_with_role();

create function public.set_member_domains(p_workspace uuid, p_user uuid, p_domains text[]) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_role public.workspace_role;
  v_domains text[] := case when coalesce(cardinality(p_domains), 0) = 0 then null else p_domains end;
begin
  if not public.is_owner(p_workspace) then
    raise exception 'Only an owner can limit a member to domains.' using errcode = '42501';
  end if;
  select m.role into v_role from public.workspace_members m where m.workspace_id = p_workspace and m.user_id = p_user;
  if v_role is null then
    raise exception 'That person is not a member of this workspace.' using errcode = 'P0001';
  end if;
  if v_domains is not null then
    if v_role <> 'editor' then
      raise exception 'Only an editor can be limited to domains. Owners change everything; viewers and commenters change nothing.' using errcode = 'P0001';
    end if;
    if cardinality(v_domains) > 50 or exists (
      select 1 from unnest(v_domains) as d(id)
      where not exists (select 1 from public.objects o where o.workspace_id = p_workspace and o.id = d.id and o.type_id = 'domain' and not o.deleted)
    ) then
      raise exception 'Choose domains that exist in this workspace.' using errcode = 'P0001';
    end if;
  end if;
  update public.workspace_members m set domains = v_domains where m.workspace_id = p_workspace and m.user_id = p_user;
end
$$;

-- The members list now says who is limited to what.
drop function public.workspace_people(uuid);
create function public.workspace_people(p_workspace uuid)
returns table (user_id uuid, email text, display_name text, role public.workspace_role, domains text[])
language sql stable security definer set search_path = ''
as $$
  select m.user_id, coalesce(p.email, ''), coalesce(p.display_name, ''), m.role, m.domains
  from public.workspace_members m
  left join public.profiles p on p.id = m.user_id
  where m.workspace_id = p_workspace and public.can_read(p_workspace)
  order by m.created_at
$$;

-- The audit log records a change of limit, with the domains by name.
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
  end if;
  return null;
end
$$;

revoke all on function
  public.my_domains(uuid), public.inside_domains(uuid, text, text[]), public.guard_domain_scope(), public.clear_domains_with_role(),
  public.set_member_domains(uuid, uuid, text[]), public.workspace_people(uuid), public.audit_member()
  from public, anon, authenticated;
grant execute on function public.set_member_domains(uuid, uuid, text[]), public.workspace_people(uuid) to authenticated;
