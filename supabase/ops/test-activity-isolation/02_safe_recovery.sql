-- ============================================================
-- Test activity isolation — SAFE RECOVERY (NOT a migration)
-- ============================================================
-- Prepared only; each section needs explicit approval to run.
--
-- THE NORMAL ROLLBACK IS AN APP ROLLBACK, NOT A DATABASE CHANGE:
--   Redeploy the previous production build in Vercel ("Instant Rollback"
--   to the deployment before this PR). Leave migration 20261123120000 in
--   place. The previous app works with it, and every protection stays on:
--     * new issues on Test 1 / Test 2 are still stamped as test issues;
--     * classifications and asana_handoff_expected stay immutable;
--     * the database still refuses any live Asana job for a test issue
--       (the old app's live attempt for a test issue is refused; the issue
--       is kept and is sent to BETA once the new app is back).
--   What is lost while rolled back: the Testing page, test mode and the
--   2-minute reconciliation (the old worker does not run it).
--
-- OPTIONAL SAFE LEVERS (below). Use only if the problem is in the new
-- automation itself, e.g. reconciliation misbehaving. They NEVER disable a
-- trigger, drop, delete or rewrite anything, and they keep every guard on:
--   A. stop automatic re-sending (reconciliation functions refuse to run;
--      managers then see "the Asana sync check is failing");
--   B. stop new test mode and end any running test mode (audited).
-- Test apartments stay test apartments; history and audit are untouched.
--
-- If the database classification trigger itself must be switched off,
-- that is NOT a safe rollback: see 03_emergency_disable_classification.sql.

-- ===== SAFE LEVERS (begin) =====
revoke execute on function public.asana_flags_awaiting_handoff(integer, integer) from service_role;
revoke execute on function public.enqueue_asana_handoff(uuid, jsonb) from service_role;
revoke execute on function public.start_test_session(uuid, uuid, integer, text) from authenticated;
with ended as (
  update public.test_sessions set ended_at = least(now(), ends_at)
   where ended_at is null
  returning id, company_id, property_id
)
insert into public.audit_events(company_id, actor_id, event_kind, entity_type, entity_id, metadata)
select company_id, null, 'test_session_ended', 'test_session', id,
       jsonb_build_object('property_id', property_id, 'source', 'safe recovery lever B')
  from ended;
-- ===== SAFE LEVERS (end) =====

-- ===== RESTORE (begin) =====
-- grant execute on function public.asana_flags_awaiting_handoff(integer, integer) to service_role;
-- grant execute on function public.enqueue_asana_handoff(uuid, jsonb) to service_role;
-- grant execute on function public.start_test_session(uuid, uuid, integer, text) to authenticated;
-- ===== RESTORE (end) =====
