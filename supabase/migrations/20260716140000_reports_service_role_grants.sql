-- ============================================================
-- reports: service-role SELECT grant for the pack PDF generator
-- ============================================================
-- Slice 11C1. loadPackReportData() reads public.evidence_packs under
-- service_role (only AFTER the prepare route has authorized the user via
-- their RLS session). service_role bypasses RLS but still needs a
-- table-level GRANT — and evidence_packs was never granted to it (the
-- Asana worker grants covered flags/properties/flag_categories/profiles,
-- and photos was granted in 20260716120000). Without this the pack report
-- read fails with permission denied.
--
-- Additive, grants-only. SELECT only. No anon grant, no change to
-- `authenticated`, RLS, Storage policies, or any other table.

grant select on table public.evidence_packs to service_role;
