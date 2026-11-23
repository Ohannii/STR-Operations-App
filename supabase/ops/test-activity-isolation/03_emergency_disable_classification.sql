-- ============================================================
-- HAZARDOUS EMERGENCY ONLY — NOT A ROLLBACK (NOT a migration)
-- ============================================================
-- Use ONLY if the classification trigger itself is broken and is stopping
-- staff from reporting real issues. Needs explicit approval at the time.
--
-- WHAT IT BREAKS while it is in effect:
--   * new issues on Test 1 / Test 2 and in test mode are recorded as NORMAL
--     issues and CAN reach the live Asana Incidents project;
--   * new issues are not marked "expected in Asana", so a failed Asana
--     enqueue is NOT retried and NOT reported to managers;
--   * the classification of existing issues is no longer locked.
-- WHAT STAYS ON: the live-job veto for issues ALREADY classified as tests,
-- existing classifications, test apartments, sessions and all audit rows.
--
-- REQUIRED BEFORE RUNNING (all three):
--   1. Stop all testing: nobody raises issues on Test 1 / Test 2 or uses
--      test mode until this is reversed.
--   2. Switch live routing off: set ASANA_LIVE_INCIDENTS_ENABLED to anything
--      other than "true" in Vercel Production and redeploy, so every new
--      issue goes to the BETA project while classification is off.
--   3. Set the acknowledgement in the SAME session/transaction:
--        set local test_isolation.hazard_acknowledged = 'test issues may reach live Asana';
-- Reverse with the RE-ENABLE section as soon as the trigger is fixed, then
-- switch live routing back on.

do $$
begin
  if current_setting('test_isolation.hazard_acknowledged', true) is distinct from 'test issues may reach live Asana' then
    raise exception 'Refusing: read the hazards in this file and set the acknowledgement first';
  end if;
end $$;

alter table public.flags disable trigger trg_flags_stamp_test_classification;
-- The live-job veto (trg_outbox_refuse_live_for_test_flags) is deliberately left ON.

-- ===== RE-ENABLE =====
-- alter table public.flags enable trigger trg_flags_stamp_test_classification;
