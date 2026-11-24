-- ############################################################################
-- ##  HAZARDOUS EMERGENCY ONLY. NOT A ROLLBACK. NEVER RUN ROUTINELY.          ##
-- ##  Needs EXPLICIT APPROVAL from Anni at the time, naming this file.       ##
-- ##  Issues recorded while this is in effect are PERMANENTLY mis-recorded:  ##
-- ##  they stay "normal" and "not expected in Asana" after it is reversed.   ##
-- ############################################################################
-- (NOT a migration.)
--
-- Use ONLY if the classification trigger itself is broken and is stopping
-- staff from reporting real issues. For every other problem use the app
-- rollback and 02_safe_recovery.sql, which keep all guards on.
--
-- WHAT IT BREAKS while it is in effect:
--   * new issues on Test 1 / Test 2 and in test mode are recorded as NORMAL
--     issues and CAN reach the live Asana Incidents project;
--   * new issues are not marked "expected in Asana", so a failed Asana
--     enqueue is NOT retried and NOT reported to managers;
--   * the classification of existing issues is no longer locked.
-- IRREVERSIBLE DATA EFFECT: every issue created during the emergency keeps
-- is_test = false and asana_handoff_expected = false for good — re-enabling
-- locks those values again, so they cannot be corrected afterwards, and the
-- managers' Asana warning will never cover them. Write down the start and
-- end time of the emergency so those issues can be checked by hand.
-- WHAT STAYS ON: the live-job veto for issues ALREADY classified as tests,
-- existing classifications, test apartments, sessions and all audit rows.
--
-- REQUIRED BEFORE RUNNING (all of them):
--   1. Explicit approval from Anni for this file, at the time.
--   2. Stop all testing: nobody raises issues on Test 1 / Test 2 or uses
--      test mode until this is reversed.
--   3. Switch EVERY live Asana routing path off in Vercel Production and
--      redeploy, so every new issue goes to the BETA project:
--        ASANA_LIVE_INCIDENTS_ENABLED  -> anything other than "true"
--        ASANA_LIVE_INCIDENTS_TEST     -> anything other than "true"
--   4. Set the acknowledgement in the SAME session/transaction:
--        set local test_isolation.hazard_acknowledged = 'test issues may reach live Asana';
-- Reverse with the RE-ENABLE section as soon as the trigger is fixed, then
-- switch live routing back on, then check the issues raised in between.

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
