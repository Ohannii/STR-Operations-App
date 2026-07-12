-- ============================================================
-- flags.issue_title
-- ============================================================
-- Optional short inspector-entered title (e.g. "Broken pot"). Drives
-- the Asana task name; falls back to the description summary when null.
--
-- Additive, nullable. No new grants needed — existing table grants on
-- public.flags cover the new column (authenticated insert/update and
-- service_role select were already granted).

alter table public.flags
  add column if not exists issue_title text;

comment on column public.flags.issue_title is
  'Optional short inspector title (e.g. "Broken pot"). Drives the Asana task name; falls back to the description summary when null.';
