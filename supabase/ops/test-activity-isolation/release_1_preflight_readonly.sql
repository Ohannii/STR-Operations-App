-- ============================================================
-- PR #78 production release — STEP 1: PREFLIGHT (READ-ONLY)
-- ============================================================
-- SELECT only. Run immediately before release_2. Every "expect" must hold;
-- otherwise STOP and report. Values recorded on 24 Nov 2026 are in
-- docs/releases/PR78_RELEASE_RUNBOOK.md.
with hist as (
  select version, name, statements, created_by, idempotency_key, rollback
    from supabase_migrations.schema_migrations
)
select
  (select count(*) from hist) as history_rows,                                            -- expect 34
  (select max(version) from hist) as history_latest,                                      -- expect 20261122191844
  (select count(*) from hist where version = '20261123120000') as pr78_history_rows,      -- expect 0
  (select count(*) from hist where statements[1] like '-- applied from commit%') as placeholder_rows, -- expect 0 (repaired 24 Nov)
  (select encode(extensions.digest(convert_to(string_agg(
       quote_nullable(version) || '|' || quote_nullable(name) || '|' || quote_nullable(statements::text) || '|' ||
       quote_nullable(created_by) || '|' || quote_nullable(idempotency_key) || '|' || quote_nullable(rollback::text),
       E'\n' order by version), 'UTF8'), 'sha256'), 'hex') from hist) as history_fingerprint, -- expect the runbook value
  to_regclass('public.test_sessions') is null as pr78_objects_absent,                     -- expect true
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'flags' and column_name in ('is_test', 'asana_handoff_expected')) as pr78_columns_absent, -- expect true
  (select count(*) from public.properties
    where company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7' and deleted_at is null
      and name in ('Test 1', 'Test 2')) as active_test_apartments,                         -- expect 2
  exists (select 1 from public.integration_settings
           where company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7' and provider = 'asana'
             and is_enabled and deleted_at is null) as asana_enabled,                      -- expect true
  (select count(*) from public.integration_outbox
    where provider = 'asana' and deleted_at is null and status in ('pending', 'processing')) as asana_jobs_in_flight, -- record; ideally 0
  (select count(*) from public.integration_outbox o
     join public.flags f on f.id = o.entity_id
     join public.properties p on p.id = f.property_id
    where o.provider = 'asana' and o.deleted_at is null and o.status in ('pending', 'processing')
      and o.event_type like 'asana.live.%'
      and p.company_id = '1669c464-8d26-40fc-9956-9f8955fd27c7' and p.name in ('Test 1', 'Test 2')) as live_jobs_in_flight_for_test_apartments; -- expect 0 (else decide before cutover)
