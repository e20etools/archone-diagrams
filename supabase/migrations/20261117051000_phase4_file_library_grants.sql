-- The file library's helpers are for its rules, not to be called by someone signed out; the
-- trigger that records links is called by the database alone.
revoke all on function public.diagram_visible(uuid, text), public.file_visible(uuid), public.file_manageable(uuid) from public, anon;
grant execute on function public.diagram_visible(uuid, text), public.file_visible(uuid), public.file_manageable(uuid) to authenticated;
revoke all on function public.audit_file_link(), public.touch_diagram_file() from public, anon, authenticated;
