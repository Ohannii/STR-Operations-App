-- ============================================================
-- companies: service-role SELECT grant for the Asana attach worker
-- ============================================================
-- Slice 11C2. The attach-evidence worker renders the flag report PDF under
-- service_role (only for allowlisted companies, after the create-task event
-- has produced the task link). Rendering the PDF header needs the company
-- name, so service_role must be able to SELECT public.companies — it was
-- never granted (flags/properties/flag_categories/profiles/photos/
-- evidence_packs were granted in earlier migrations). service_role bypasses
-- RLS but still needs a table-level GRANT.
--
-- Additive, grants-only. SELECT only. No anon grant, no change to
-- `authenticated`, RLS, Storage policies, or any other table.

grant select on table public.companies to service_role;
