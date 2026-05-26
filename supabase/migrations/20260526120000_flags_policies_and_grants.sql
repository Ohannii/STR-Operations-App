-- ============================================================
-- Migration 0008 — Apartment Action Centre flag policies + grants
-- ============================================================
-- Adds the MINIMUM RLS + grants for the Session 3 Apartment Action
-- Centre. That session ships the ability to raise a flag from the
-- per-property page and list open flags. It does NOT ship a triage
-- / classify / close UI yet, so this migration deliberately omits
-- UPDATE policies and UPDATE grants on flags.
--
-- The two-gate principle stays: every read/write must pass the
-- Postgres-level GRANT first, then the row-level RLS policy.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. RLS policies on public.flags
-- ----------------------------------------------------------------
-- SELECT: company members can read flags scoped to their company.
create policy "members read company flags"
  on public.flags
  for select
  to authenticated
  using (public.is_company_member(company_id));

-- INSERT: company members can raise flags in their company.
-- The `raised_by = auth.uid()` check is a defensive guard so a
-- client can't fabricate "this was raised by another user" rows.
-- It mirrors the docs/FLAG_AND_ACTION_MODEL.md rule that the
-- raiser is always the calling user.
create policy "members insert flags in own company"
  on public.flags
  for insert
  to authenticated
  with check (
    public.is_company_member(company_id)
    and raised_by = auth.uid()
  );

-- NOTE: No UPDATE policy yet. The triage / classify / close flow is
-- not built in Session 3, so the UPDATE path stays closed at the
-- policy level. When that flow ships, add a separate policy here
-- (probably gated to Coordinator+ via a role-check helper) and the
-- matching grant below.


-- ----------------------------------------------------------------
-- 2. Postgres-level table grants
-- ----------------------------------------------------------------
-- Without the grant the RLS policies above can never even be
-- consulted ("permission denied for table flags" wins first).
-- Pattern matches migration 0007 (table_grants).
grant select, insert on public.flags to authenticated;

-- NOTE: No UPDATE grant. No DELETE grant. We soft-delete via
-- deleted_at when that lifecycle ships.
