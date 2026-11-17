-- ArchONE Diagrams, phase 4: fair use of the AI.
--
--  * ai_policies: one row per workspace, id 'workspace', set by owners and read by every
--    member: AI on or off, who may use it, which features, limits per person (requests an
--    hour, requests a day, tokens a day), limits for the whole workspace (requests and tokens a
--    day), and exceptions per person (another daily limit, or paused).
--  * ai_usage: one row per AI request, written only through ai_begin and ai_finish. A person
--    reads their own rows; owners read the rows of their workspace.
--  * The AI server calls ai_begin with the caller's own sign-in before it asks the model and
--    ai_finish after, with the tokens the model used. A request refused by a limit never reaches
--    the model. Windows are rolling: the last hour and the last 24 hours.
--  * A scenario follows the limits of the workspace it was made from, and its use counts
--    towards that workspace. A person's own limits count their use in every workspace, so
--    moving to another workspace or a scenario does not start them afresh.

create table public.ai_policies (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  id text not null check (id = 'workspace'),
  data jsonb not null check (jsonb_typeof(data) = 'object' and data ->> 'id' = id and pg_column_size(data) <= 20000),
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key (workspace_id, id)
);

create trigger stamp_change before insert or update on public.ai_policies for each row execute function public.stamp_change();

revoke all on public.ai_policies from anon, authenticated;
grant select, insert, update on public.ai_policies to authenticated;
alter table public.ai_policies enable row level security;
create policy "members read the AI limits" on public.ai_policies for select to authenticated using (public.can_read(workspace_id));
create policy "owners set the AI limits" on public.ai_policies for insert to authenticated with check (public.is_owner(workspace_id));
create policy "owners change the AI limits" on public.ai_policies for update to authenticated using (public.is_owner(workspace_id)) with check (public.is_owner(workspace_id));

alter publication supabase_realtime add table public.ai_policies;

create function public.audit_ai_policy() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or (new.data - 'updatedAt') is distinct from (old.data - 'updatedAt') then
    perform public.audit_write(new.workspace_id, 'workspace', new.workspace_id::text, 'AI limits', 'AI limits changed',
      jsonb_build_object('enabled', new.data -> 'enabled', 'who', new.data -> 'who', 'perUser', new.data -> 'perUser', 'workspace', new.data -> 'workspace'));
  end if;
  return null;
end
$$;
create trigger audit after insert or update on public.ai_policies for each row execute function public.audit_ai_policy();

create table public.ai_usage (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('text', 'image', 'ask')),
  status text not null default 'started' check (status in ('started', 'ok', 'failed')),
  tokens integer not null default 0 check (tokens between 0 and 2000000),
  -- Known only to whoever called ai_begin (the AI server), so nobody else can close the request.
  finish_key uuid not null default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index ai_usage_by_person on public.ai_usage (user_id, started_at desc);
create index ai_usage_by_workspace on public.ai_usage (workspace_id, started_at desc);
create index ai_usage_by_time on public.ai_usage (started_at desc);

revoke all on public.ai_usage from anon, authenticated;
grant select (id, workspace_id, user_id, kind, status, tokens, started_at, finished_at) on public.ai_usage to authenticated;
alter table public.ai_usage enable row level security;
create policy "people read their own AI use, owners their workspace's" on public.ai_usage for select to authenticated
  using (user_id = (select auth.uid()) or public.is_owner(workspace_id));

/* ---------- helpers ---------- */

-- The workspace whose limits apply: a scenario follows the one it was made from.
create function public.ai_root(p_workspace uuid) returns uuid
language sql stable security definer set search_path = ''
as $$
  select coalesce(w.scenario_of, w.id) from public.workspaces w where w.id = p_workspace
$$;

create function public.ai_num(v jsonb, d integer) returns integer
language sql immutable set search_path = ''
as $$
  select case when jsonb_typeof(v) = 'number' then greatest(0, least(v::text::numeric, 100000000))::integer else d end
$$;

create function public.ai_bool(v jsonb, d boolean) returns boolean
language sql immutable set search_path = ''
as $$
  select case when jsonb_typeof(v) = 'boolean' then v::text::boolean else d end
$$;

-- The limits in force, with the built-in defaults where the owners set nothing.
create function public.ai_policy_of(p_workspace uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'enabled', public.ai_bool(p.data -> 'enabled', true),
    'who', case when p.data ->> 'who' in ('members', 'editors', 'owners') then p.data ->> 'who' else 'members' end,
    'features', jsonb_build_object(
      'text', public.ai_bool(p.data -> 'features' -> 'text', true),
      'image', public.ai_bool(p.data -> 'features' -> 'image', true),
      'ask', public.ai_bool(p.data -> 'features' -> 'ask', true)),
    'perUser', jsonb_build_object(
      'hour', public.ai_num(p.data -> 'perUser' -> 'hour', 10),
      'day', public.ai_num(p.data -> 'perUser' -> 'day', 40),
      'tokensDay', public.ai_num(p.data -> 'perUser' -> 'tokensDay', 40000)),
    'workspace', jsonb_build_object(
      'day', public.ai_num(p.data -> 'workspace' -> 'day', 300),
      'tokensDay', public.ai_num(p.data -> 'workspace' -> 'tokensDay', 150000)),
    'overrides', case when jsonb_typeof(p.data -> 'overrides') = 'object' then p.data -> 'overrides' else '{}'::jsonb end)
  from (select 1) one
  left join public.ai_policies p on p.workspace_id = public.ai_root(p_workspace) and p.id = 'workspace' and not p.deleted
$$;

-- One person's limits: the workspace's, or the exception an owner set for them.
create function public.ai_limits_for(p_policy jsonb, p_user uuid) returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'hour', public.ai_num(p_policy -> 'overrides' -> p_user::text -> 'hour', (p_policy -> 'perUser' ->> 'hour')::integer),
    'day', public.ai_num(p_policy -> 'overrides' -> p_user::text -> 'day', (p_policy -> 'perUser' ->> 'day')::integer),
    'tokensDay', public.ai_num(p_policy -> 'overrides' -> p_user::text -> 'tokensDay', (p_policy -> 'perUser' ->> 'tokensDay')::integer),
    'paused', public.ai_bool(p_policy -> 'overrides' -> p_user::text -> 'blocked', false))
$$;

/* ---------- asking, and closing ---------- */

create function public.ai_begin(p_workspace uuid, p_kind text, p_global_day integer default 0) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_root uuid;
  v_policy jsonb;
  v_limits jsonb;
  v_who text;
  u_hour integer;
  u_day integer;
  u_tokens bigint;
  w_day integer;
  w_tokens bigint;
  g_day integer;
  v_retry timestamptz;
  v_id bigint;
  v_key uuid;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'sign_in', 'message', 'Sign in to use AI.');
  end if;
  if p_kind is null or p_kind not in ('text', 'image', 'ask') then
    return jsonb_build_object('allowed', false, 'reason', 'bad_request', 'message', 'Unknown kind of AI request.');
  end if;
  v_role := public.member_role(p_workspace)::text;
  if v_role is null then
    return jsonb_build_object('allowed', false, 'reason', 'not_member', 'message', 'You are not a member of this workspace.');
  end if;
  v_root := public.ai_root(p_workspace);
  v_policy := public.ai_policy_of(p_workspace);
  if not (v_policy ->> 'enabled')::boolean then
    return jsonb_build_object('allowed', false, 'reason', 'off', 'message', 'An owner has switched AI off for this workspace.');
  end if;
  if not (v_policy -> 'features' ->> p_kind)::boolean then
    return jsonb_build_object('allowed', false, 'reason', 'feature_off', 'message',
      case p_kind when 'image' then 'An owner has switched off drafting from pictures in this workspace.'
                  when 'ask' then 'An owner has switched off AI answers on the Ask page in this workspace.'
                  else 'An owner has switched off AI drafts from text and voice in this workspace.' end);
  end if;
  v_who := v_policy ->> 'who';
  if (v_who = 'owners' and v_role <> 'owner') or (v_who = 'editors' and v_role not in ('owner', 'editor')) then
    return jsonb_build_object('allowed', false, 'reason', 'role', 'message',
      case v_who when 'owners' then 'In this workspace AI is open to owners only.' else 'In this workspace AI is open to owners and editors only.' end);
  end if;
  v_limits := public.ai_limits_for(v_policy, v_uid);
  if (v_limits ->> 'paused')::boolean then
    return jsonb_build_object('allowed', false, 'reason', 'paused', 'message', 'An owner has paused AI for you in this workspace.');
  end if;

  -- One request of a person at a time is counted, so two at once cannot both slip under a limit.
  perform pg_advisory_xact_lock(hashtextextended('ai:' || v_uid::text, 0));

  select count(*) filter (where u.started_at > now() - interval '1 hour'), count(*), coalesce(sum(u.tokens), 0)
    into u_hour, u_day, u_tokens
    from public.ai_usage u
    where u.user_id = v_uid and u.started_at > now() - interval '24 hours' and u.status <> 'failed';

  if u_hour >= (v_limits ->> 'hour')::integer then
    select min(u.started_at) + interval '1 hour' into v_retry from public.ai_usage u
      where u.user_id = v_uid and u.started_at > now() - interval '1 hour' and u.status <> 'failed';
    return jsonb_build_object('allowed', false, 'reason', 'hour', 'retryAt', v_retry, 'message',
      format('You have used your %s AI requests for this hour.', v_limits ->> 'hour'));
  end if;
  if u_day >= (v_limits ->> 'day')::integer then
    select min(u.started_at) + interval '24 hours' into v_retry from public.ai_usage u
      where u.user_id = v_uid and u.started_at > now() - interval '24 hours' and u.status <> 'failed';
    return jsonb_build_object('allowed', false, 'reason', 'day', 'retryAt', v_retry, 'message',
      format('You have used your %s AI requests for the last 24 hours.', v_limits ->> 'day'));
  end if;
  if u_tokens >= (v_limits ->> 'tokensDay')::bigint then
    select min(u.started_at) + interval '24 hours' into v_retry from public.ai_usage u
      where u.user_id = v_uid and u.started_at > now() - interval '24 hours' and u.status <> 'failed';
    return jsonb_build_object('allowed', false, 'reason', 'tokens', 'retryAt', v_retry, 'message',
      format('You have used your %s AI tokens for the last 24 hours.', v_limits ->> 'tokensDay'));
  end if;

  select count(*), coalesce(sum(u.tokens), 0) into w_day, w_tokens
    from public.ai_usage u join public.workspaces w on w.id = u.workspace_id
    where coalesce(w.scenario_of, w.id) = v_root and u.started_at > now() - interval '24 hours' and u.status <> 'failed';
  if w_day >= (v_policy -> 'workspace' ->> 'day')::integer or w_tokens >= (v_policy -> 'workspace' ->> 'tokensDay')::bigint then
    return jsonb_build_object('allowed', false, 'reason', 'workspace', 'message',
      'This workspace has used its AI allowance for the last 24 hours. An owner can raise it in Settings.');
  end if;

  if coalesce(p_global_day, 0) > 0 then
    select count(*) into g_day from public.ai_usage u where u.started_at > now() - interval '24 hours' and u.status <> 'failed';
    if g_day >= p_global_day then
      return jsonb_build_object('allowed', false, 'reason', 'global', 'message',
        'The AI service has reached its daily allowance for everyone. It frees up over the next hours.');
    end if;
  end if;

  insert into public.ai_usage (workspace_id, user_id, kind) values (p_workspace, v_uid, p_kind) returning id, finish_key into v_id, v_key;
  return jsonb_build_object('allowed', true, 'usage', v_id, 'key', v_key, 'remaining', jsonb_build_object(
    'hour', (v_limits ->> 'hour')::integer - u_hour - 1,
    'day', (v_limits ->> 'day')::integer - u_day - 1,
    'tokens', greatest((v_limits ->> 'tokensDay')::bigint - u_tokens, 0)));
end
$$;

-- Closes a request with the tokens the model used. Tokens only ever go up, and only the holder of the key can close it.
create function public.ai_finish(p_usage bigint, p_key uuid, p_tokens integer, p_ok boolean) returns void
language sql security definer set search_path = ''
as $$
  update public.ai_usage
     set tokens = greatest(tokens, least(greatest(coalesce(p_tokens, 0), 0), 2000000)),
         status = case when status = 'started' then case when p_ok then 'ok' else 'failed' end else status end,
         finished_at = coalesce(finished_at, now())
   where id = p_usage and finish_key = p_key and user_id = (select auth.uid())
$$;

/* ---------- what has been used ---------- */

-- For everyone: their own use and limits, and the workspace's. For owners also: use by person and by day.
create function public.ai_usage_report(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := public.member_role(p_workspace)::text;
  v_root uuid := public.ai_root(p_workspace);
  v_policy jsonb;
  v_limits jsonb;
  v_me jsonb;
  v_ws jsonb;
  v_people jsonb := null;
  v_days jsonb := null;
begin
  if v_uid is null or v_role is null then
    return null;
  end if;
  v_policy := public.ai_policy_of(p_workspace);
  v_limits := public.ai_limits_for(v_policy, v_uid);
  select jsonb_build_object(
      'hour', count(*) filter (where u.started_at > now() - interval '1 hour'),
      'day', count(*),
      'tokensDay', coalesce(sum(u.tokens), 0),
      'limits', v_limits)
    into v_me
    from public.ai_usage u
    where u.user_id = v_uid and u.started_at > now() - interval '24 hours' and u.status <> 'failed';
  select jsonb_build_object('day', count(*), 'tokensDay', coalesce(sum(u.tokens), 0), 'limits', v_policy -> 'workspace')
    into v_ws
    from public.ai_usage u join public.workspaces w on w.id = u.workspace_id
    where coalesce(w.scenario_of, w.id) = v_root and u.started_at > now() - interval '24 hours' and u.status <> 'failed';

  if v_role = 'owner' then
    select coalesce(jsonb_agg(row_to_json(t) order by t."month" desc, t.name), '[]'::jsonb) into v_people
    from (
      select m.user_id as "userId", coalesce(nullif(p.display_name, ''), p.email, '') as name, m.role::text as role,
             count(u.id) filter (where u.started_at > now() - interval '24 hours') as day,
             count(u.id) filter (where u.started_at > now() - interval '7 days') as week,
             count(u.id) as "month",
             coalesce(sum(u.tokens) filter (where u.started_at > now() - interval '24 hours'), 0) as "tokensDay",
             coalesce(sum(u.tokens), 0) as "tokensMonth",
             count(u.id) filter (where u.status = 'failed') as failed,
             max(u.started_at) as "lastUsed",
             public.ai_limits_for(v_policy, m.user_id) as limits
      from public.workspace_members m
      left join public.profiles p on p.id = m.user_id
      left join (
        select u.* from public.ai_usage u join public.workspaces w on w.id = u.workspace_id
        where coalesce(w.scenario_of, w.id) = v_root and u.started_at > now() - interval '30 days'
      ) u on u.user_id = m.user_id
      where m.workspace_id = v_root
      group by m.user_id, p.display_name, p.email, m.role
    ) t;
    select coalesce(jsonb_agg(jsonb_build_object('day', d.day::date, 'requests', coalesce(x.requests, 0), 'tokens', coalesce(x.tokens, 0)) order by d.day), '[]'::jsonb)
      into v_days
      from generate_series((now() at time zone 'utc')::date - 13, (now() at time zone 'utc')::date, interval '1 day') d(day)
      left join (
        select (u.started_at at time zone 'utc')::date as day, count(*) as requests, sum(u.tokens) as tokens
        from public.ai_usage u join public.workspaces w on w.id = u.workspace_id
        where coalesce(w.scenario_of, w.id) = v_root and u.started_at > now() - interval '14 days' and u.status <> 'failed'
        group by 1
      ) x on x.day = d.day::date;
  end if;

  return jsonb_build_object('policy', v_policy, 'me', v_me, 'workspace', v_ws, 'people', v_people, 'days', v_days, 'scenario', v_root <> p_workspace);
end
$$;

revoke all on function public.audit_ai_policy(), public.ai_root(uuid), public.ai_num(jsonb, integer), public.ai_bool(jsonb, boolean),
  public.ai_policy_of(uuid), public.ai_limits_for(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.ai_begin(uuid, text, integer), public.ai_finish(bigint, uuid, integer, boolean), public.ai_usage_report(uuid) from public, anon;
grant execute on function public.ai_begin(uuid, text, integer), public.ai_finish(bigint, uuid, integer, boolean), public.ai_usage_report(uuid) to authenticated;
