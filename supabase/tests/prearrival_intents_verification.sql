-- ============================================================
-- Pre-arrival photo intents — staging verification (NON-DESTRUCTIVE)
-- ============================================================
-- Run AFTER the migration has been applied to staging:
--   psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f supabase/tests/prearrival_intents_verification.sql
--
-- One transaction, always ends in ROLLBACK. Nothing is kept. Never runs
-- `supabase db reset`, drops nothing, deletes no bytes. Fixtures are pinned to
-- the Drop-Inn `test` company / property "Test 1" and ABORT WITH AN EXCEPTION
-- if that environment is missing (it never silently skips).
-- ============================================================

\set ON_ERROR_STOP on
begin;

\ir prearrival_intents_verification_body.sql

rollback;
-- Nothing above is persisted.
