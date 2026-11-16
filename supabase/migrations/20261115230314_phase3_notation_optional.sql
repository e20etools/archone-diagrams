-- The API builds a diagram row field by field and knows nothing of notations, so a row may
-- arrive without one. Missing means plain boxes and lines.
alter table public.diagrams alter column notation drop not null;
