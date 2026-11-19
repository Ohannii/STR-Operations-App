-- ============================================================
-- flag_issue_selections: least-privilege table grants
-- ============================================================
-- Follow-up to 20261119090000 (unchanged). Supabase's default privileges
-- gave `authenticated` and `service_role` TRUNCATE, REFERENCES and TRIGGER
-- on the new table. TRUNCATE is not subject to row security and would
-- empty the table; none of the three is needed.
--
-- After this migration:
--   authenticated : SELECT, INSERT   (row security still applies)
--   service_role  : SELECT           (the Asana worker reads selections)
--   anon / public : nothing          (already revoked in 20261119090000)
--
-- Permissions only: no data, schema, policy or function change.
-- ============================================================

revoke all privileges on table public.flag_issue_selections
  from authenticated, service_role;

grant select, insert on table public.flag_issue_selections
  to authenticated;

grant select on table public.flag_issue_selections
  to service_role;
