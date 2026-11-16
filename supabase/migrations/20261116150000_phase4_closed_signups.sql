-- ArchONE Diagrams, phase 4: a site that does not take new accounts.
--
-- Supabase has its own switch for this (Authentication > Sign In / Providers > Allow new
-- users to sign up). This is the same thing kept with the rest of the database rules, with
-- a list of addresses that may still join, for people an owner wants to invite.
--
--   update public.signup_settings set open = false;                       -- close
--   insert into public.allowed_signups (email) values ('new@example.com');  -- let one in
--
-- Both tables are for whoever administers the database: nobody reaches them through the app.

create table public.signup_settings (
  id boolean primary key default true check (id),
  open boolean not null default true
);
insert into public.signup_settings default values;

create table public.allowed_signups (
  email text primary key check (email = lower(btrim(email)) and char_length(email) between 3 and 320),
  note text not null default '',
  added_at timestamptz not null default now()
);

alter table public.signup_settings enable row level security;
alter table public.allowed_signups enable row level security;
revoke all on public.signup_settings, public.allowed_signups from anon, authenticated;

create function public.guard_signup() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce((select s.open from public.signup_settings s), true)
     or exists (select 1 from public.allowed_signups a where a.email = lower(btrim(coalesce(new.email, '')))) then
    return new;
  end if;
  raise exception 'This site is not taking new accounts. Ask its owner to add your email address.' using errcode = 'P0001';
end
$$;
revoke all on function public.guard_signup() from public, anon, authenticated;
create trigger guard_signup before insert on auth.users for each row execute function public.guard_signup();
