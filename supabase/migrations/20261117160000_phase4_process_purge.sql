-- Emptying the bin also removes deleted processes, which can be large (a BPMN file each).
create or replace function public.purge_deleted(p_workspace uuid, p_older_than interval default interval '30 days') returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_total integer := 0;
  v_count integer;
begin
  if not public.is_owner(p_workspace) then
    raise exception 'Only an owner can do this.' using errcode = '42501';
  end if;
  delete from public.diagram_nodes t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.relationships t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.diagrams t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.objects t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.proposals t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.decision_records t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.custom_rules t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.diagram_templates t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  delete from public.process_models t where t.workspace_id = p_workspace and t.deleted and t.changed_at < now() - p_older_than;
  get diagnostics v_count = row_count; v_total := v_total + v_count;
  return v_total;
end
$$;
