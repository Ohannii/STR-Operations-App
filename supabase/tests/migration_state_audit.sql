-- ============================================================
-- READ-ONLY migration state audit — nine "pending" migrations
-- ============================================================
-- Run:  pnpm.cmd exec supabase db query --linked -f supabase/tests/migration_state_audit.sql
--
-- STRICTLY READ-ONLY: one SELECT against system catalogs, storage.buckets and
-- the CLI's migration-history table. No DDL, no DML, no temp objects.
--
-- WHY THESE SHOW AS PENDING: `supabase db push` decides from
-- supabase_migrations.schema_migrations (the remote history table), not from
-- the schema itself. Objects applied via the SQL editor or `db query -f`
-- exist in the schema but write NO history row, so the CLI still counts the
-- file as pending. This audit proves which effects actually exist so the
-- history can be reconciled deliberately — NOT with a blind push.
--
-- VERDICTS per migration:
--   FULLY PRESENT — every material-effect check passes
--   PARTIAL       — some pass, some fail (list shown in missing_checks)
--   ABSENT        — no check passes
--   20260721090000 has two legitimate states and reports either
--   'FULLY PRESENT (applied)' (3-arg fn deployed, 2-arg removed, history
--   recorded) or 'NOT APPLIED YET (pending)'; a mix is 'PARTIAL —
--   investigate'. An applied successor never makes 20260718120000 PARTIAL:
--   its discard check accepts the 2-arg original OR the 3-arg supersession.
--
-- If this query errors with `relation "supabase_migrations.schema_migrations"
-- does not exist`, that is itself the answer to why everything is pending:
-- the remote has no history records at all.

with checks (migration, chk, pass) as (

  -- ---------- 20260710120000 asana_worker_service_grants ----------
  select '20260710120000', 'schema public USAGE -> service_role',
         has_schema_privilege('service_role', 'public', 'USAGE')
  union all
  select '20260710120000', 'SELECT integration_outbox -> service_role',
         has_table_privilege('service_role', 'public.integration_outbox', 'SELECT')
  union all
  select '20260710120000', 'SELECT external_task_links -> service_role',
         has_table_privilege('service_role', 'public.external_task_links', 'SELECT')
  union all
  select '20260710120000', 'SELECT flags -> service_role',
         has_table_privilege('service_role', 'public.flags', 'SELECT')
  union all
  select '20260710120000', 'SELECT properties -> service_role',
         has_table_privilege('service_role', 'public.properties', 'SELECT')
  union all
  select '20260710120000', 'SELECT flag_categories -> service_role',
         has_table_privilege('service_role', 'public.flag_categories', 'SELECT')
  union all
  select '20260710120000', 'SELECT profiles -> service_role',
         has_table_privilege('service_role', 'public.profiles', 'SELECT')
  union all
  select '20260710120000', 'INSERT external_task_links -> service_role',
         has_table_privilege('service_role', 'public.external_task_links', 'INSERT')
  union all
  select '20260710120000', 'UPDATE integration_outbox -> service_role',
         has_table_privilege('service_role', 'public.integration_outbox', 'UPDATE')
  union all
  select '20260710120000', 'UPDATE flags -> service_role',
         has_table_privilege('service_role', 'public.flags', 'UPDATE')

  -- ---------- 20260711120000 flags_issue_title ----------
  union all
  select '20260711120000', 'column flags.issue_title exists',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'flags'
                   and column_name = 'issue_title')
  union all
  select '20260711120000', 'comment on flags.issue_title present',
         coalesce((select col_description(c.oid, a.attnum) is not null
                   from pg_class c
                   join pg_namespace n on n.oid = c.relnamespace
                   join pg_attribute a on a.attrelid = c.oid
                   where n.nspname = 'public' and c.relname = 'flags'
                     and a.attname = 'issue_title'), false)

  -- ---------- 20260712120000 finalize_flag_with_photos ----------
  union all
  select '20260712120000', 'fn derive_photo_retention_class(text,text) exists',
         to_regprocedure('public.derive_photo_retention_class(text,text)') is not null
  union all
  select '20260712120000', 'fn finalize_flag_with_photos(8 args) exists',
         to_regprocedure(
           'public.finalize_flag_with_photos(uuid,uuid,uuid,text,text,text,text,jsonb)'
         ) is not null
  union all
  select '20260712120000', 'EXECUTE derive_photo_retention_class -> authenticated',
         to_regprocedure('public.derive_photo_retention_class(text,text)') is not null
         and has_function_privilege('authenticated',
             'public.derive_photo_retention_class(text,text)', 'EXECUTE')
  union all
  select '20260712120000', 'EXECUTE finalize_flag_with_photos -> authenticated',
         to_regprocedure(
           'public.finalize_flag_with_photos(uuid,uuid,uuid,text,text,text,text,jsonb)'
         ) is not null
         and has_function_privilege('authenticated',
             'public.finalize_flag_with_photos(uuid,uuid,uuid,text,text,text,text,jsonb)',
             'EXECUTE')

  -- ---------- 20260716120000 photos_service_role_select ----------
  union all
  select '20260716120000', 'SELECT photos -> service_role',
         has_table_privilege('service_role', 'public.photos', 'SELECT')

  -- ---------- 20260716130000 report_artifacts_bucket ----------
  union all
  select '20260716130000', 'bucket report-artifacts exists',
         exists (select 1 from storage.buckets where id = 'report-artifacts')
  union all
  select '20260716130000', 'bucket is private, 25MB, pdf-only',
         exists (select 1 from storage.buckets
                 where id = 'report-artifacts'
                   and public = false
                   and file_size_limit = 26214400
                   and allowed_mime_types = array['application/pdf'])

  -- ---------- 20260716140000 reports_service_role_grants ----------
  union all
  select '20260716140000', 'SELECT evidence_packs -> service_role',
         has_table_privilege('service_role', 'public.evidence_packs', 'SELECT')

  -- ---------- 20260717120000 companies_service_role_select ----------
  union all
  select '20260717120000', 'SELECT companies -> service_role',
         has_table_privilege('service_role', 'public.companies', 'SELECT')

  -- ---------- 20260718120000 prearrival_photo_intents ----------
  union all
  select '20260718120000', 'table photo_upload_intents exists',
         to_regclass('public.photo_upload_intents') is not null
  union all
  select '20260718120000', 'audit columns (state/discarded_at/by/reason) exist',
         (select count(*) = 4 from information_schema.columns
          where table_schema = 'public' and table_name = 'photo_upload_intents'
            and column_name in ('state', 'discarded_at', 'discarded_by', 'discard_reason'))
  union all
  select '20260718120000', 'state CHECK constraint present',
         exists (select 1 from pg_constraint
                 where conname = 'photo_upload_intents_state_chk'
                   and conrelid = to_regclass('public.photo_upload_intents'))
  union all
  select '20260718120000', 'audit CHECK constraint present',
         exists (select 1 from pg_constraint
                 where conname = 'photo_upload_intents_state_audit_chk'
                   and conrelid = to_regclass('public.photo_upload_intents'))
  union all
  select '20260718120000', 'unique index on master_path present',
         exists (select 1 from pg_indexes
                 where schemaname = 'public'
                   and indexname = 'idx_photo_upload_intents_master_path')
  union all
  select '20260718120000', 'updated_at trigger present',
         exists (select 1 from pg_trigger
                 where tgrelid = to_regclass('public.photo_upload_intents')
                   and tgname = 'trg_photo_upload_intents_set_updated_at'
                   and not tgisinternal)
  union all
  select '20260718120000', 'RLS enabled on photo_upload_intents',
         coalesce((select relrowsecurity from pg_class
                   where oid = to_regclass('public.photo_upload_intents')), false)
  union all
  select '20260718120000', 'at least one policy on photo_upload_intents',
         exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'photo_upload_intents')
  union all
  select '20260718120000', 'fn assert_draft_prearrival_pack(uuid) exists',
         to_regprocedure('public.assert_draft_prearrival_pack(uuid)') is not null
  union all
  select '20260718120000', 'fn create_prearrival_photo_intent(uuid,uuid) exists',
         to_regprocedure('public.create_prearrival_photo_intent(uuid,uuid)') is not null
  union all
  select '20260718120000', 'fn attach_prearrival_photo(6 args) exists',
         to_regprocedure(
           'public.attach_prearrival_photo(uuid,int,int,int,timestamptz,text)'
         ) is not null
  union all
  -- The 2-arg shape is this migration's ORIGINAL function, but migration
  -- 20260721090000 intentionally supersedes it with the 3-arg shape. Either
  -- shape therefore satisfies 20260718120000 — an applied successor must not
  -- make its predecessor look PARTIAL.
  select '20260718120000', 'fn discard_prearrival_photo_intent present (2-arg original OR 3-arg superseded)',
         to_regprocedure('public.discard_prearrival_photo_intent(uuid,text)') is not null
         or to_regprocedure('public.discard_prearrival_photo_intent(uuid,text,uuid)') is not null
  union all
  select '20260718120000', 'fn recover_prearrival_photo_intent(uuid) exists',
         to_regprocedure('public.recover_prearrival_photo_intent(uuid)') is not null
  union all
  select '20260718120000', 'fn finalize_prearrival_pack exists (any signature)',
         exists (select 1 from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'finalize_prearrival_pack')
  union all
  select '20260718120000', 'guard fn photos_prearrival_pack_guard exists',
         exists (select 1 from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'photos_prearrival_pack_guard')
  union all
  select '20260718120000', 'immutability fn evidence_packs_submitted_immutable exists',
         exists (select 1 from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'evidence_packs_submitted_immutable')
  union all
  select '20260718120000', 'table-wide UPDATE evidence_packs REVOKED from authenticated',
         not has_table_privilege('authenticated', 'public.evidence_packs', 'UPDATE')
  union all
  select '20260718120000', 'column UPDATE evidence_packs.title kept for authenticated',
         has_column_privilege('authenticated', 'public.evidence_packs', 'title', 'UPDATE')
  union all
  select '20260718120000', 'column UPDATE evidence_packs.status DENIED to authenticated',
         not has_column_privilege('authenticated', 'public.evidence_packs', 'status', 'UPDATE')
  union all
  select '20260718120000', 'column INSERT evidence_packs.status DENIED to authenticated',
         not has_column_privilege('authenticated', 'public.evidence_packs', 'status', 'INSERT')
  union all
  select '20260718120000', 'table-wide INSERT photos REVOKED from authenticated',
         not has_table_privilege('authenticated', 'public.photos', 'INSERT')
  union all
  select '20260718120000', 'column UPDATE photos.notes kept for authenticated',
         has_column_privilege('authenticated', 'public.photos', 'notes', 'UPDATE')

  -- ---------- 20260721090000 prearrival_photo_cancellation ----------
  -- Two legitimate states: NOT APPLIED YET (3-arg absent, 2-arg still there,
  -- no history row) or FULLY PRESENT (3-arg deployed, 2-arg dropped, history
  -- recorded). Anything in between is PARTIAL and needs investigation.
  union all
  select '20260721090000', 'fn discard_prearrival_photo_intent(uuid,text,uuid) [3-ARG] deployed',
         to_regprocedure('public.discard_prearrival_photo_intent(uuid,text,uuid)') is not null
  union all
  select '20260721090000', 'superseded 2-arg discard fn removed',
         to_regprocedure('public.discard_prearrival_photo_intent(uuid,text)') is null
  union all
  select '20260721090000', 'recorded in remote migration history',
         exists (select 1 from supabase_migrations.schema_migrations
                 where version = '20260721090000')
),
agg as (
  select migration,
         count(*)                      as total,
         count(*) filter (where pass)  as passed,
         string_agg(chk, ' | ') filter (where not pass) as missing_checks
  from checks
  group by migration
)
select migration,
       case
         when migration = '20260721090000' then
           case when passed = total then 'FULLY PRESENT (applied)'
                when passed = 0     then 'NOT APPLIED YET (pending)'
                else 'PARTIAL — investigate' end
         when passed = total then 'FULLY PRESENT'
         when passed = 0     then 'ABSENT'
         else 'PARTIAL'
       end                                   as verdict,
       passed || '/' || total                as checks_passed,
       coalesce(missing_checks, '')          as missing_checks,
       exists (select 1 from supabase_migrations.schema_migrations sm
               where sm.version = agg.migration) as in_remote_history
from agg
order by migration;
