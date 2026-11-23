-- ============================================================
-- NON-DESTRUCTIVE ROLLBACK for 20261123120000_test_activity_isolation
-- ============================================================
-- NOT a migration. Prepared only; needs explicit approval to run.
-- Run the PAUSE section as one unit; RESUME later, separately.
--
-- Use only if the DATABASE behaviour itself must be paused. For an app
-- problem, redeploy the previous build instead: the previous code works
-- with this migration in place (verified: main's app code needs none of
-- the new objects; the database still protects test issues).
--
-- Pausing keeps EVERYTHING: columns, flags.is_test history, test_sessions,
-- properties.is_test, audit events, outbox rows. Nothing is dropped,
-- deleted or rewritten. It only switches the behaviour off, and the
-- RESUME section switches it back on.
--
-- Effect while paused:
--   * new issues are stamped normal (is_test = false) and not expected in
--     Asana (no reconciliation) — exactly the pre-migration behaviour;
--   * existing classifications and audit stay as they were;
--   * the worker's reconciliation functions refuse to run (no grant);
--   * the live-job backstop is OFF, so pause only together with marking no
--     new test work (testers informed).

-- ---------- PAUSE ----------
begin;
alter table public.flags disable trigger trg_flags_stamp_test_classification;
alter table public.integration_outbox disable trigger trg_outbox_refuse_live_for_test_flags;
revoke execute on function public.asana_flags_awaiting_handoff(integer, integer) from service_role;
revoke execute on function public.enqueue_asana_handoff(uuid, jsonb) from service_role;
revoke execute on function public.start_test_session(uuid, uuid, integer, text) from authenticated;
-- end any running test mode (recorded, not deleted)
with ended as (
  update public.test_sessions set ended_at = least(now(), ends_at)
   where ended_at is null returning id, company_id, user_id, property_id
)
insert into public.audit_events(company_id, actor_id, event_kind, entity_type, entity_id, metadata)
select company_id, null, 'test_session_ended', 'test_session', id,
       jsonb_build_object('property_id', property_id, 'source', 'rollback pause')
  from ended;
commit;

-- ---------- RESUME (separate approval) ----------
-- begin;
-- alter table public.flags enable trigger trg_flags_stamp_test_classification;
-- alter table public.integration_outbox enable trigger trg_outbox_refuse_live_for_test_flags;
-- grant execute on function public.asana_flags_awaiting_handoff(integer, integer) to service_role;
-- grant execute on function public.enqueue_asana_handoff(uuid, jsonb) to service_role;
-- grant execute on function public.start_test_session(uuid, uuid, integer, text) to authenticated;
-- commit;
