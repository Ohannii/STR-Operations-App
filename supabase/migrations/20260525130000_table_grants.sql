-- ============================================================
-- Migration 0007 — Table grants for the authenticated role
-- ============================================================
-- Supabase does NOT automatically grant table privileges to the
-- `anon` and `authenticated` roles for tables created in `public`.
-- Without explicit grants, any SELECT/INSERT/UPDATE issued by a
-- logged-in user hits "permission denied for table X" BEFORE RLS
-- gets a chance to evaluate. That was the cause of the "stuck on
-- /onboard" loop in Session 2 testing after the maybeSingle()
-- duplicate-row bug was fixed.
--
-- This migration adds the MINIMUM privileges the v1.0 first-screens
-- UI needs. Every table is still RLS-enabled (migration 0005) with
-- row-level policies (migration 0006); these grants are the
-- Postgres-level "may you touch this table at all" gate that RLS
-- sits on top of.
--
-- Pattern is intentionally narrow:
--   - SELECT only on tables the UI reads.
--   - INSERT only where the current UI writes (just properties).
--   - No UPDATE anywhere yet (profile + property editing comes
--     in a later screen; grant then).
--   - No DELETE anywhere (we soft-delete via deleted_at).
--   - Grants to `anon` only for genuine public reference data
--     (roles, system flag_categories).
--   - service_role is intentionally unchanged.
--
-- When future sessions add screens that touch new tables, add
-- grants in their own migrations. Do not GRANT ALL on schema-wide.
-- ============================================================


-- ----------------------------------------------------------------
-- Schema USAGE (defensive; usually already granted by Supabase)
-- ----------------------------------------------------------------
-- USAGE on a schema lets a role see the schema exists and resolve
-- table names. It's a no-op if already granted.
grant usage on schema public to anon, authenticated;


-- ----------------------------------------------------------------
-- Public reference tables: anon + authenticated may SELECT
-- ----------------------------------------------------------------
-- Match the public-read RLS policies from migration 0006:
--   "anyone reads roles"
--   "anyone reads system flag_categories"
grant select on public.roles            to anon, authenticated;
grant select on public.flag_categories  to anon, authenticated;


-- ----------------------------------------------------------------
-- Tenant tables: authenticated only; RLS scopes the rows
-- ----------------------------------------------------------------
-- companies: SELECT for members (RLS: "members read own companies").
-- No INSERT grant -- only create_company_with_admin() RPC creates
-- rows, and it runs as SECURITY DEFINER (postgres role).
grant select on public.companies to authenticated;

-- profiles: SELECT own profile (RLS: "users read own profile").
-- No UPDATE grant yet -- profile-edit UI isn't built. The trigger
-- handle_new_user() runs as SECURITY DEFINER and does its own insert.
grant select on public.profiles to authenticated;

-- company_memberships: SELECT own + company's (per RLS).
-- No INSERT grant -- only create_company_with_admin() inserts here.
grant select on public.company_memberships to authenticated;

-- properties: SELECT + INSERT for company members.
-- No UPDATE grant yet -- property-edit UI isn't built; add it then.
grant select, insert on public.properties to authenticated;

-- property_assignments + property_owner_links: SELECT only for now.
-- INSERT comes with the team management / owner setup screens.
grant select on public.property_assignments to authenticated;
grant select on public.property_owner_links to authenticated;


-- ============================================================
-- Notes for future grant additions (DO NOT add now; track here)
-- ============================================================
-- When profile-edit ships:   grant update on public.profiles to authenticated;
-- When property-edit ships:  grant update on public.properties to authenticated;
-- When team invites ship:    grant select, insert on public.invitations to authenticated;
-- When stays UI ships:       grant select, insert, update on public.stays to authenticated;
-- ...and so on per table, never schema-wide.
