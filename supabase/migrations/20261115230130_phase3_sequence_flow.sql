-- ArchONE Diagrams, phase 3: "then", the relationship between two steps of a process
-- (a BPMN sequence flow). It is not a dependency: impact analysis does not follow it.

alter table public.relationships drop constraint relationships_kind_check;
alter table public.relationships add constraint relationships_kind_check
  check (kind in ('calls', 'depends_on', 'reads_writes', 'hosted_on', 'routes_to', 'replicates_to', 'flows_to'));
