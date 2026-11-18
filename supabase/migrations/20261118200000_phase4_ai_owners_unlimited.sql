-- Phase 4: owners have no AI limits unless the owners choose otherwise.
--
-- The workspace's AI policy gets "ownersUnlimited" (on when it was never set). With it on, an
-- owner's requests are not stopped by the limits per person or by the workspace's limits. They
-- are still counted, an owner can still be paused by another owner, AI switched off or a feature
-- switched off still applies, and so does the server's daily cap that keeps a shared key inside
-- its provider's plan. The report says which limits do not apply, so the screens show "No limit".
-- Grants are kept: these replace the bodies of functions that exist.

create or replace function public.ai_policy_of(p_workspace uuid) returns jsonb
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
    'ownersUnlimited', public.ai_bool(p.data -> 'ownersUnlimited', true),
    'overrides', case when jsonb_typeof(p.data -> 'overrides') = 'object' then p.data -> 'overrides' else '{}'::jsonb end)
  from (select 1) one
  left join public.ai_policies p on p.workspace_id = public.ai_root(p_workspace) and p.id = 'workspace' and not p.deleted
$$;

create or replace function public.ai_begin(p_workspace uuid, p_kind text, p_global_day integer default 0) returns jsonb
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
  v_free boolean;
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

  -- Owners have no limits of their own or of the workspace unless the owners chose otherwise.
  -- Their requests are still counted, and the server's daily cap for a shared key still holds.
  v_free := v_role = 'owner' and (v_policy ->> 'ownersUnlimited')::boolean;

  -- One request of a person at a time is counted, so two at once cannot both slip under a limit.
  perform pg_advisory_xact_lock(hashtextextended('ai:' || v_uid::text, 0));

  select count(*) filter (where u.started_at > now() - interval '1 hour'), count(*), coalesce(sum(u.tokens), 0)
    into u_hour, u_day, u_tokens
    from public.ai_usage u
    where u.user_id = v_uid and u.started_at > now() - interval '24 hours' and u.status <> 'failed';

  if not v_free and u_hour >= (v_limits ->> 'hour')::integer then
    select min(u.started_at) + interval '1 hour' into v_retry from public.ai_usage u
      where u.user_id = v_uid and u.started_at > now() - interval '1 hour' and u.status <> 'failed';
    return jsonb_build_object('allowed', false, 'reason', 'hour', 'retryAt', v_retry, 'message',
      format('You have used your %s AI requests for this hour.', v_limits ->> 'hour'));
  end if;
  if not v_free and u_day >= (v_limits ->> 'day')::integer then
    select min(u.started_at) + interval '24 hours' into v_retry from public.ai_usage u
      where u.user_id = v_uid and u.started_at > now() - interval '24 hours' and u.status <> 'failed';
    return jsonb_build_object('allowed', false, 'reason', 'day', 'retryAt', v_retry, 'message',
      format('You have used your %s AI requests for the last 24 hours.', v_limits ->> 'day'));
  end if;
  if not v_free and u_tokens >= (v_limits ->> 'tokensDay')::bigint then
    select min(u.started_at) + interval '24 hours' into v_retry from public.ai_usage u
      where u.user_id = v_uid and u.started_at > now() - interval '24 hours' and u.status <> 'failed';
    return jsonb_build_object('allowed', false, 'reason', 'tokens', 'retryAt', v_retry, 'message',
      format('You have used your %s AI tokens for the last 24 hours.', v_limits ->> 'tokensDay'));
  end if;

  select count(*), coalesce(sum(u.tokens), 0) into w_day, w_tokens
    from public.ai_usage u join public.workspaces w on w.id = u.workspace_id
    where coalesce(w.scenario_of, w.id) = v_root and u.started_at > now() - interval '24 hours' and u.status <> 'failed';
  if not v_free and (w_day >= (v_policy -> 'workspace' ->> 'day')::integer or w_tokens >= (v_policy -> 'workspace' ->> 'tokensDay')::bigint) then
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
  if v_free then
    return jsonb_build_object('allowed', true, 'usage', v_id, 'key', v_key, 'unlimited', true);
  end if;
  return jsonb_build_object('allowed', true, 'usage', v_id, 'key', v_key, 'remaining', jsonb_build_object(
    'hour', (v_limits ->> 'hour')::integer - u_hour - 1,
    'day', (v_limits ->> 'day')::integer - u_day - 1,
    'tokens', greatest((v_limits ->> 'tokensDay')::bigint - u_tokens, 0)));
end
$$;

create or replace function public.ai_usage_report(p_workspace uuid) returns jsonb
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
  v_limits := public.ai_limits_for(v_policy, v_uid) || jsonb_build_object('unlimited', v_role = 'owner' and (v_policy ->> 'ownersUnlimited')::boolean);
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
             public.ai_limits_for(v_policy, m.user_id) || jsonb_build_object('unlimited', m.role = 'owner' and (v_policy ->> 'ownersUnlimited')::boolean) as limits
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
