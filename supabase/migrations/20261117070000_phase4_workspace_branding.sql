-- ArchONE Diagrams, phase 4: a workspace's branding.
--
--  * One row, id 'workspace': the name shown in the menu, a small logo, an accent colour, and the
--    theme and font members start with. Each person can still pick their own theme.
--  * Owners set it; every member reads it.
--  * A scenario starts with the branding of the workspace it was made from.

create table public.workspace_branding (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (id = 'workspace'),
  data jsonb not null check (
    jsonb_typeof(data) = 'object' and data ->> 'id' = id
    and char_length(coalesce(data ->> 'appName', '')) <= 40
    and coalesce(data ->> 'accent', '') ~ '^(#[0-9a-fA-F]{6})?$'
    and char_length(coalesce(data ->> 'logo', '')) <= 300000
    and (coalesce(data ->> 'logo', '') = '' or data ->> 'logo' ~ '^data:image/(png|jpeg|webp|svg\+xml|gif);base64,')
  ),
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create trigger stamp_change before insert or update on public.workspace_branding for each row execute function public.stamp_change();

revoke all on public.workspace_branding from anon, authenticated;
grant select, insert, update on public.workspace_branding to authenticated;
alter table public.workspace_branding enable row level security;
create policy "members read branding" on public.workspace_branding for select to authenticated using (public.can_read(workspace_id));
create policy "owners add branding" on public.workspace_branding for insert to authenticated with check (public.is_owner(workspace_id));
create policy "owners change branding" on public.workspace_branding for update to authenticated using (public.is_owner(workspace_id)) with check (public.is_owner(workspace_id));

alter publication supabase_realtime add table public.workspace_branding;

create function public.audit_workspace_branding() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or (new.data - 'updatedAt') is distinct from (old.data - 'updatedAt') then
    perform public.audit_write(new.workspace_id, 'workspace', new.workspace_id::text, coalesce(nullif(new.data ->> 'appName', ''), 'branding'), 'branding changed',
      jsonb_build_object('theme', new.data -> 'theme', 'accent', new.data -> 'accent', 'logo', (coalesce(new.data ->> 'logo', '') <> '')));
  end if;
  return null;
end
$$;
create trigger audit after insert or update on public.workspace_branding for each row execute function public.audit_workspace_branding();

create function public.copy_workspace_branding() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.scenario_of is not null then
    insert into public.workspace_branding (workspace_id, id, data)
      select new.id, b.id, b.data from public.workspace_branding b where b.workspace_id = new.scenario_of and not b.deleted;
  end if;
  return null;
end
$$;
create trigger copy_workspace_branding after insert on public.workspaces for each row execute function public.copy_workspace_branding();

revoke all on function public.audit_workspace_branding(), public.copy_workspace_branding() from public, anon, authenticated;
