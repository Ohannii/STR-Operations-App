-- ============================================================
-- Migration 0009 — Flag triage policies + activity log grants
-- ============================================================
-- Adds the minimum RLS + grants for Session 4: editing flags
-- (status, severity, chargeable_party_decision, no_action_reason)
-- and writing operational notes / state-change events to the
-- audit_events log used for the activity timeline.
--
-- The two-gate principle remains: every read/write passes the
-- Postgres-level GRANT first, then the row-level RLS policy.
--
-- DELIBERATELY OUT OF SCOPE
--   - No DELETE on either table (audit_events is append-only by
--     design; flags use soft-delete via deleted_at).
--   - No role narrowing beyond "is company member". Per-role
--     gating (e.g., only Coordinator+ can re-classify) lands with
--     the role-helper migration in v1.2.
--   - No INSERT policy on flags here (already added in 0008).
-- ============================================================


-- ----------------------------------------------------------------
-- 1. UPDATE policy on public.flags
-- ----------------------------------------------------------------
-- Members can update flags scoped to their company. The
-- chargeable_party_decision, status, severity, no_action_reason,
-- classified_*, actioned_at, closed_at fields are the targets;
-- raised_at + raised_by stay immutable in practice because the
-- server action never sends them. RLS doesn't lock individual
-- columns; the application-side action does.
create policy "members update company flags"
  on public.flags
  for update
  to authenticated
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));


-- ----------------------------------------------------------------
-- 2. RLS policies on public.audit_events
-- ----------------------------------------------------------------
-- SELECT: members read events scoped to their company.
create policy "members read company audit events"
  on public.audit_events
  for select
  to authenticated
  using (
    company_id is not null
    and public.is_company_member(company_id)
  );

-- INSERT: members write events scoped to their company. The
-- defensive `actor_id = auth.uid()` check mirrors the same guard
-- on the flags INSERT policy -- prevents a client from forging
-- "this was logged by someone else" rows.
create policy "members insert company audit events"
  on public.audit_events
  for insert
  to authenticated
  with check (
    company_id is not null
    and public.is_company_member(company_id)
    and actor_id = auth.uid()
  );


-- ----------------------------------------------------------------
-- 3. Postgres-level grants
-- ----------------------------------------------------------------
-- flags: add UPDATE on top of the SELECT + INSERT granted in 0008.
grant update on public.flags to authenticated;

-- audit_events: SELECT + INSERT only. No UPDATE / DELETE -- the
-- table is append-only by design; mistakes get a new row.
grant select, insert on public.audit_events to authenticated;
