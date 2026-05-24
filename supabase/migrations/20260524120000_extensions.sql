-- ============================================================
-- Migration 0001 — Extensions
-- ============================================================
-- Enables the Postgres extensions the v1.0 schema relies on.
--
-- pgcrypto provides gen_random_uuid() for default UUID PKs.
-- Supabase projects typically ship with this enabled already,
-- but `if not exists` makes the migration idempotent.
-- ============================================================

create extension if not exists "pgcrypto";
