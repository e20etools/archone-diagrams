-- ArchONE Diagrams, phase 4: a log that shows tampering, and dependencies confirmed by the other side.
--
--  * Every audit entry carries a hash of itself and of the entry before it. Changing or
--    removing an entry breaks the chain from there on, and verify_audit_log() finds where.
--    The newest hash can be kept outside the system; checking against it later also shows
--    whether the end of the log was cut off.
--  * A relationship can be confirmed by the owner of the object that is depended on. The
--    confirmation is for the relationship as it was: changing the relationship clears it.

-- ---------------------------------------------------------------------------
-- The chain
-- ---------------------------------------------------------------------------

alter table public.audit_log add column prev_hash text, add column hash text;

create function public.audit_entry_hash(
  p_prev text, p_id bigint, p_workspace uuid, p_at timestamptz, p_actor uuid, p_actor_name text, p_via text,
  p_entity text, p_entity_id text, p_entity_name text, p_action text, p_changes jsonb
) returns text
language sql stable set search_path = ''
as $$
  select public.sha256_hex(jsonb_build_array(
    coalesce(p_prev, ''), p_id, p_workspace, to_char(p_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_actor, p_actor_name, p_via, p_entity, p_entity_id, p_entity_name, p_action, p_changes)::text)
$$;
revoke all on function public.audit_entry_hash(text, bigint, uuid, timestamptz, uuid, text, text, text, text, text, text, jsonb) from public, anon, authenticated;

-- Entries of one workspace are chained one at a time. The number is taken again under the
-- lock, so that the order of the numbers is the order of the chain whoever writes the entry.
create function public.audit_log_chain() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('archone.audit:' || new.workspace_id::text, 0));
  new.id := nextval(pg_get_serial_sequence('public.audit_log', 'id'));
  select a.hash into new.prev_hash from public.audit_log a where a.workspace_id = new.workspace_id order by a.id desc limit 1;
  new.hash := public.audit_entry_hash(new.prev_hash, new.id, new.workspace_id, new.at, new.actor_id, new.actor_name, new.via, new.entity, new.entity_id, new.entity_name, new.action, new.changes);
  return new;
end
$$;
create trigger chain before insert on public.audit_log for each row execute function public.audit_log_chain();
revoke all on function public.audit_log_chain() from public, anon, authenticated;

-- The entries written before the chain existed are chained in the order they were written.
alter table public.audit_log disable trigger append_only;
do $$
declare
  r public.audit_log;
  v_prev text;
  v_ws uuid;
begin
  for r in select * from public.audit_log order by workspace_id, id loop
    if v_ws is distinct from r.workspace_id then
      v_prev := null;
      v_ws := r.workspace_id;
    end if;
    update public.audit_log a
      set prev_hash = v_prev,
          hash = public.audit_entry_hash(v_prev, r.id, r.workspace_id, r.at, r.actor_id, r.actor_name, r.via, r.entity, r.entity_id, r.entity_name, r.action, r.changes)
      where a.id = r.id
      returning a.hash into v_prev;
  end loop;
end
$$;
alter table public.audit_log enable trigger append_only;
alter table public.audit_log alter column hash set not null;

-- Walks the chain of a workspace and says whether it holds. With a saved number and hash, it
-- also says whether that entry is still there and unchanged.
create function public.verify_audit_log(p_workspace uuid, p_anchor_id bigint default null, p_anchor_hash text default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  r public.audit_log;
  v_prev text;
  v_checked bigint := 0;
  v_broken bigint;
  v_head public.audit_log;
  v_anchor text;
  v_found text;
begin
  if not public.is_owner(p_workspace) then
    raise exception 'Only an owner can check the audit log.' using errcode = '42501';
  end if;
  for r in select * from public.audit_log a where a.workspace_id = p_workspace order by a.id loop
    if r.prev_hash is distinct from v_prev
       or r.hash is distinct from public.audit_entry_hash(r.prev_hash, r.id, r.workspace_id, r.at, r.actor_id, r.actor_name, r.via, r.entity, r.entity_id, r.entity_name, r.action, r.changes) then
      v_broken := r.id;
      exit;
    end if;
    v_prev := r.hash;
    v_checked := v_checked + 1;
    v_head := r;
  end loop;
  if p_anchor_id is not null then
    select a.hash into v_found from public.audit_log a where a.workspace_id = p_workspace and a.id = p_anchor_id;
    v_anchor := case when v_found is null then 'missing' when v_found = lower(btrim(coalesce(p_anchor_hash, ''))) then 'match' else 'mismatch' end;
  end if;
  return jsonb_build_object(
    'ok', v_broken is null and coalesce(v_anchor, 'match') = 'match',
    'entries', v_checked,
    'brokenAt', v_broken,
    'head', case when v_head.id is null or v_broken is not null then null else jsonb_build_object('id', v_head.id, 'hash', v_head.hash, 'at', v_head.at) end,
    'anchor', v_anchor
  );
end
$$;
revoke all on function public.verify_audit_log(uuid, bigint, text) from public, anon;
grant execute on function public.verify_audit_log(uuid, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The handshake
-- ---------------------------------------------------------------------------

-- { "by": name, "at": time } once the owner of the target has confirmed the dependency.
alter table public.relationships add column acknowledged jsonb
  check (acknowledged is null or (jsonb_typeof(acknowledged) = 'object' and acknowledged ? 'by' and acknowledged ? 'at' and pg_column_size(acknowledged) <= 1000));

-- A confirmation is for the relationship as it was. This holds for changes through the API too.
create function public.clear_stale_acknowledgement() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.acknowledged is not null and new.acknowledged is not distinct from old.acknowledged
     and (new.source_id, new.target_id, new.kind, new.label, new.protocol, new.port, new.description)
         is distinct from (old.source_id, old.target_id, old.kind, old.label, old.protocol, old.port, old.description) then
    new.acknowledged := null;
  end if;
  return new;
end
$$;
create trigger clear_stale_acknowledgement before update on public.relationships for each row execute function public.clear_stale_acknowledgement();
