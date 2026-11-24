-- ============================================================
-- PROPOSED — rollback of the migration-history repair. NOT RUN.
-- ============================================================
-- Restores EXACTLY the two original one-line comments captured by the
-- read-only preflight on 24 Nov 2026, and proves the whole table is then
-- byte-identical to before (full fingerprint). One transaction; refuses
-- unless the two rows hold exactly the repaired file text.
do $rollback$
declare
  v_full text; v_untouched text; n int;
begin
  lock table supabase_migrations.schema_migrations in share row exclusive mode;
  -- Fingerprints use exactly the same expression as 00_preflight_readonly.sql.
  select encode(extensions.digest(convert_to(string_agg(
           quote_nullable(version) || '|' || quote_nullable(name) || '|' || quote_nullable(statements::text) || '|' ||
           quote_nullable(created_by) || '|' || quote_nullable(idempotency_key) || '|' || quote_nullable(rollback::text),
           E'\n' order by version), 'UTF8'), 'sha256'), 'hex')
    into v_full from supabase_migrations.schema_migrations;
  select encode(extensions.digest(convert_to(string_agg(
           quote_nullable(version) || '|' || quote_nullable(name) || '|' ||
           case when version in ('20261119090000', '20261119110000') then '<target statements>' else quote_nullable(statements::text) end || '|' ||
           quote_nullable(created_by) || '|' || quote_nullable(idempotency_key) || '|' || quote_nullable(rollback::text),
           E'\n' order by version), 'UTF8'), 'sha256'), 'hex')
    into v_untouched from supabase_migrations.schema_migrations;
  if v_untouched <> '4582babebe0a3223de1b2da1204066fe17d16948a00793fba590f75c5f7b0da1' then
    raise exception 'REFUSED: other history rows changed since the repair (%)', v_untouched;
  end if;
  if (select encode(extensions.digest(convert_to(statements[1], 'UTF8'), 'sha256'), 'hex') || ':' || array_length(statements, 1)
        from supabase_migrations.schema_migrations where version = '20261119090000') <> 'e0a8191e0a809c5251482920ab133e6697f41c378f1ba0fcbbc6ed3aa4f9302d:1'
     or (select encode(extensions.digest(convert_to(statements[1], 'UTF8'), 'sha256'), 'hex') || ':' || array_length(statements, 1)
        from supabase_migrations.schema_migrations where version = '20261119110000') <> 'c78489b9b4765dcd968b0e32a528bec3bb696205b6831d24b5e6b08c7270d519:1' then
    raise exception 'REFUSED: target rows are not in the repaired state';
  end if;

  update supabase_migrations.schema_migrations set statements = array[$c$-- applied from commit 77f739b: supabase/migrations/20261119090000_flag_issue_selections.sql (sha256 e0a8191e0a809c5251482920ab133e6697f41c378f1ba0fcbbc6ed3aa4f9302d)$c$]::text[]
   where version = '20261119090000' and name = 'flag_issue_selections';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'REFUSED: 20261119090000 matched % rows', n; end if;
  update supabase_migrations.schema_migrations set statements = array[$c$-- applied from commit 73edb46: supabase/migrations/20261119110000_asana_one_destination_per_flag.sql (sha256 c78489b9b4765dcd968b0e32a528bec3bb696205b6831d24b5e6b08c7270d519)$c$]::text[]
   where version = '20261119110000' and name = 'asana_one_destination_per_flag';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'REFUSED: 20261119110000 matched % rows', n; end if;

  -- Fingerprints use exactly the same expression as 00_preflight_readonly.sql.
  select encode(extensions.digest(convert_to(string_agg(
           quote_nullable(version) || '|' || quote_nullable(name) || '|' || quote_nullable(statements::text) || '|' ||
           quote_nullable(created_by) || '|' || quote_nullable(idempotency_key) || '|' || quote_nullable(rollback::text),
           E'\n' order by version), 'UTF8'), 'sha256'), 'hex')
    into v_full from supabase_migrations.schema_migrations;
  select encode(extensions.digest(convert_to(string_agg(
           quote_nullable(version) || '|' || quote_nullable(name) || '|' ||
           case when version in ('20261119090000', '20261119110000') then '<target statements>' else quote_nullable(statements::text) end || '|' ||
           quote_nullable(created_by) || '|' || quote_nullable(idempotency_key) || '|' || quote_nullable(rollback::text),
           E'\n' order by version), 'UTF8'), 'sha256'), 'hex')
    into v_untouched from supabase_migrations.schema_migrations;
  if v_full <> 'e40293ef91f4cfa4d564d6e8e1369c00b7e719dcbecc1cf4af9dae21c1e64cf2' then
    raise exception 'ABORTED: table is not byte-identical to the pre-repair state (%)', v_full;
  end if;
  raise notice 'ROLLED BACK: history table is byte-identical to the 24 Nov preflight';
end
$rollback$;
