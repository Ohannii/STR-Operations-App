-- ============================================================
-- Pre-arrival photo intents — MIGRATION REHEARSAL (guaranteed ROLLBACK)
-- ============================================================
-- Applies the migration AND runs the full verification inside ONE transaction,
-- then ROLLS BACK. Nothing is persisted — the database is left exactly as it
-- was. This is the safe way to prove the migration works on real staging data
-- BEFORE committing to it.
--
-- PowerShell:
--   psql "$env:STAGING_URL" -v ON_ERROR_STOP=1 -f supabase\tests\prearrival_rehearsal.sql
-- bash:
--   psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f supabase/tests/prearrival_rehearsal.sql
--
-- ON_ERROR_STOP=1 makes psql abort on the FIRST SQL error; because everything
-- is inside the transaction, an abort still leaves the database untouched.
-- Postgres DDL is transactional, so the CREATE TABLE / FUNCTION / TRIGGER and
-- the REVOKE/GRANT statements all roll back too.
--
-- NOTE: this file does NOT persist anything. To actually apply the migration
-- you use the normal migration tooling — never this script.
-- ============================================================

\set ON_ERROR_STOP on
\timing on

begin;

\echo '=== applying migration inside the rehearsal transaction ==='
\ir ../migrations/20260718120000_prearrival_photo_intents.sql

\echo ''
\echo '=== running verification against the migrated schema ==='
\ir prearrival_intents_verification_body.sql

\echo ''
\echo '=== rolling back — the database is unchanged ==='
rollback;

\echo 'REHEARSAL COMPLETE. Review every line above: any "FAIL --->" means do NOT apply.'
