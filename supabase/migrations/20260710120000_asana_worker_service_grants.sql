-- ============================================================
-- Asana worker service-role grants
-- ============================================================
-- The deployed Asana worker connects as `service_role`. That role
-- bypasses RLS, but Postgres still requires table-level GRANTs. These
-- were applied manually during the dry-run; this migration makes them
-- reproducible (not dashboard-only state).
--
-- Additive, grants-only. No data change, no schema change. Scoped to
-- exactly what the worker needs — nothing broader.

grant usage on schema public to service_role;

-- Reads: claim/inspect the queue, re-read authoritative flag data, and
-- check for an existing link (idempotency).
grant select on
  public.integration_outbox,
  public.external_task_links,
  public.flags,
  public.properties,
  public.flag_categories,
  public.profiles
  to service_role;

-- Writes: record the link, stamp the flag, and advance the queue.
grant insert on public.external_task_links to service_role;
grant update on public.integration_outbox, public.flags to service_role;
