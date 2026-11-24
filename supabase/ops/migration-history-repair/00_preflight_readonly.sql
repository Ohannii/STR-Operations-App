-- READ-ONLY preflight for the migration-history repair (PR #78 incident).
-- SELECT only. Changes nothing.
with rows as (
  select version, name, statements, created_by, idempotency_key, rollback
    from supabase_migrations.schema_migrations
), fp_all as (
  select encode(extensions.digest(convert_to(string_agg(
           quote_nullable(version) || '|' || quote_nullable(name) || '|' || quote_nullable(statements::text) || '|' ||
           quote_nullable(created_by) || '|' || quote_nullable(idempotency_key) || '|' || quote_nullable(rollback::text),
           E'\n' order by version), 'UTF8'), 'sha256'), 'hex') as v
    from rows
), fp_except_target_statements as (
  -- everything in the table EXCEPT the statements of the two target rows
  select encode(extensions.digest(convert_to(string_agg(
           quote_nullable(version) || '|' || quote_nullable(name) || '|' ||
           case when version in ('20261119090000', '20261119110000') then '<target statements>' else quote_nullable(statements::text) end || '|' ||
           quote_nullable(created_by) || '|' || quote_nullable(idempotency_key) || '|' || quote_nullable(rollback::text),
           E'\n' order by version), 'UTF8'), 'sha256'), 'hex') as v
    from rows
)
select
  (select count(*) from rows) as row_count,                                   -- expect 34
  (select max(version) from rows) as latest_version,                           -- expect 20261122191844
  (select count(*) from rows where version = '20261123120000') as pr78_rows,   -- expect 0
  (select v from fp_all) as full_table_fingerprint,
  (select v from fp_except_target_statements) as untouched_part_fingerprint,
  (select jsonb_agg(jsonb_build_object(
      'version', version, 'name', name,
      'n_statements', coalesce(array_length(statements, 1), 0),
      'statements_sha256', encode(extensions.digest(convert_to(array_to_string(statements, E'\u0001'), 'UTF8'), 'sha256'), 'hex'),
      'statement_1', statements[1],
      'created_by', created_by, 'idempotency_key', idempotency_key, 'rollback', rollback) order by version)
     from rows where version in ('20261119090000', '20261119110000')) as target_rows,
  -- live objects those two migrations created (must exist; nothing is re-run)
  to_regclass('public.flag_issue_selections') is not null as has_flag_issue_selections,
  exists (select 1 from pg_trigger where tgname = 'trg_integration_outbox_single_destination' and tgenabled = 'O') as has_single_destination_trigger,
  to_regprocedure('public.asana_outbox_destination(text)') is not null as has_destination_fn;
