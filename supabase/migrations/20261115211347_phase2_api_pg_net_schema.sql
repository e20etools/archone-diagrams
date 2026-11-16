-- The previous migration switched pg_net on without naming a schema, which registers the
-- extension under "public". Supabase keeps extensions out of the schema its API exposes, so
-- it is registered under "extensions" instead. Its functions stay in the "net" schema either
-- way, and nothing has been queued yet, so nothing is lost by re-creating it.
do $$
begin
  if exists (
    select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_net' and n.nspname = 'public'
  ) and exists (select 1 from pg_namespace where nspname = 'extensions') then
    drop extension pg_net;
    create extension pg_net with schema extensions;
  end if;
end
$$;
