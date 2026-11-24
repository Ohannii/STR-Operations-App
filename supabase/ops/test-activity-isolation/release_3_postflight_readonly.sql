-- ============================================================
-- PR #78 production release — STEP 3: POSTFLIGHT (READ-ONLY)
-- ============================================================
-- SELECT only. Run right after release_2. Compare with the runbook.
-- "Release moment" = the timestamp of the release transaction, taken from
-- the two Test 1 / Test 2 marking audit rows it wrote (same transaction as
-- the migration). Issues created BEFORE it must keep is_test = false and
-- asana_handoff_expected = false (no backfill); issues created AFTER it
-- are stamped normally and are reported separately, never as a failure.
with release as (
  select min(created_at) as at from public.audit_events
   where event_kind = 'property_test_status_changed'
     and metadata->>'source' = 'release step 01_mark_test_apartments'
), hist as (
  select version, name, statements, created_by, idempotency_key, rollback
    from supabase_migrations.schema_migrations
)
select
  (select count(*) from hist) as history_rows,                                            -- expect 35
  (select max(version) from hist) as history_latest,                                      -- expect 20261123120000
  (select array_length(statements, 1) || ':' || encode(extensions.digest(convert_to(statements[1], 'UTF8'), 'sha256'), 'hex')
     from hist where version = '20261123120000') as pr78_history_statement,               -- expect 1:422bc93d9dede32ceb9f5944173c770083f27c5cdb79ede7621b0c99e7c7381a
  (select encode(extensions.digest(convert_to(string_agg(
       quote_nullable(version) || '|' || quote_nullable(name) || '|' || quote_nullable(statements::text) || '|' ||
       quote_nullable(created_by) || '|' || quote_nullable(idempotency_key) || '|' || quote_nullable(rollback::text),
       E'\n' order by version), 'UTF8'), 'sha256'), 'hex') from hist where version <> '20261123120000') as earlier_history_fingerprint, -- expect = preflight history_fingerprint
  (select string_agg(name || '=' || is_test, ', ' order by name) from public.properties
    where company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7' and deleted_at is null and name in ('Test 1', 'Test 2')) as test_apartments, -- expect Test 1=true, Test 2=true
  (select count(*) from public.properties where is_test) as all_test_apartments,          -- expect 2
  (select at from release) as release_at,                                                 -- expect the release time (not null)
  (select count(*) from public.flags, release
    where flags.created_at < release.at and (flags.is_test or flags.asana_handoff_expected)) as reclassified_preexisting_flags, -- expect 0
  (select string_agg(flags.id::text, ', ') from (select f.id from public.flags f, release
     where f.created_at < release.at and (f.is_test or f.asana_handoff_expected) limit 5) flags) as reclassified_preexisting_examples, -- expect null
  (select count(*) from public.flags, release where flags.created_at >= release.at) as flags_created_since_release,   -- informational
  (select count(*) from public.flags, release where flags.created_at >= release.at and flags.is_test) as test_flags_since_release, -- informational (expect 0 while testing is frozen)
  (select count(*) from public.test_sessions) as test_sessions,                           -- expect 0
  (select last_run_at is null and monitoring_since is not null from public.integration_worker_heartbeats where worker = 'asana_reconcile') as heartbeat_waiting_for_first_run, -- expect true until the new app's cron runs
  (select count(*) from public.integration_outbox
    where provider = 'asana' and deleted_at is null and status in ('pending', 'processing')) as asana_jobs_in_flight; -- compare with preflight
