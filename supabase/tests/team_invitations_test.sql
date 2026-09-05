-- ============================================================================
-- team_invitations_test.sql - isolated pgTAP test (PR #59 correction round)
-- ============================================================================
-- Runs under `supabase test db` against a FRESHLY RESET local database.
--
-- Self-contained and order-independent: it creates its own uniquely-identified
-- company/user/membership fixtures with fixed test UUIDs, asserts against the
-- ALREADY-MIGRATED schema (it never recreates a table, function, trigger, grant
-- or policy the migrations own), and rolls everything back.
--
-- Covers the correction-round guarantees:
--   * the single-active-company partial unique index exists and rejects a raw
--     second active membership (item 2); an inactive membership elsewhere is OK;
--   * finalize_team_invitation returns a typed conflict AND commits the
--     revocation, granting no membership (item 1);
--   * the last-admin guard blocks demoting the sole admin on the locked path
--     (item 3);
--   * the migration's teammate/invitation read policies are present.
--
-- The broader end-to-end lifecycle walkthrough lives (as a manual staging
-- script) in supabase/manual-verification/team_invitations_manual_verification.sql
-- ============================================================================

begin;
select plan(11);

-- ---- fixtures (fixed UUIDs; rolled back at the end) -------------------------
insert into auth.users (id, email) values
  ('a1a1a1a1-0000-4000-8000-000000000011', 'admina@pgtap.local'),
  ('a2a2a2a2-0000-4000-8000-000000000012', 'userx@pgtap.local'),
  ('a3a3a3a3-0000-4000-8000-000000000013', 'mconf@pgtap.local'),
  ('a4a4a4a4-0000-4000-8000-000000000014', 'adminc@pgtap.local')
on conflict (id) do nothing;

insert into public.profiles (id, email) values
  ('a1a1a1a1-0000-4000-8000-000000000011', 'admina@pgtap.local'),
  ('a2a2a2a2-0000-4000-8000-000000000012', 'userx@pgtap.local'),
  ('a3a3a3a3-0000-4000-8000-000000000013', 'mconf@pgtap.local'),
  ('a4a4a4a4-0000-4000-8000-000000000014', 'adminc@pgtap.local')
on conflict (id) do update set email = excluded.email;

insert into public.companies (id, name) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'PGTAP-CO-A'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'PGTAP-CO-B'),
  ('cccccccc-0000-4000-8000-000000000003', 'PGTAP-CO-C')
on conflict (id) do nothing;

insert into public.company_memberships (company_id, user_id, role_key) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000011', 'company_admin'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a2a2a2a2-0000-4000-8000-000000000012', 'inspector'),
  ('cccccccc-0000-4000-8000-000000000003', 'a4a4a4a4-0000-4000-8000-000000000014', 'company_admin');

-- ---- migration presence (proves we test, not recreate) ---------------------
select ok(
  (select count(*) from pg_indexes
    where schemaname = 'public'
      and indexname = 'idx_memberships_one_active_company') = 1,
  'single-active-company partial unique index exists');

select ok(
  exists (select 1 from pg_policies
           where tablename = 'profiles'
             and policyname = 'members read teammate profiles'),
  'policy "members read teammate profiles" exists (migration-owned, not recreated)');

select ok(
  exists (select 1 from pg_policies
           where tablename = 'invitations'
             and policyname = 'admins read company invitations'),
  'policy "admins read company invitations" exists (migration-owned, not recreated)');

-- ---- profiles.full_name column grant (invite name capture) ------------------
select ok(
  has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE'),
  'authenticated may UPDATE profiles.full_name (invite name capture works)');
select ok(
  NOT has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE'),
  'authenticated may NOT UPDATE profiles.email (grant is column-scoped, not table-wide)');

-- ---- item 2: one active company per user, enforced at the database ----------
select throws_ok(
  $$ insert into public.company_memberships (company_id, user_id, role_key)
     values ('bbbbbbbb-0000-4000-8000-000000000002',
             'a2a2a2a2-0000-4000-8000-000000000012', 'inspector') $$,
  '23505', NULL,
  'a raw SECOND active membership for one user is rejected (unique_violation)');

select lives_ok(
  $$ insert into public.company_memberships (company_id, user_id, role_key, is_active)
     values ('bbbbbbbb-0000-4000-8000-000000000002',
             'a2a2a2a2-0000-4000-8000-000000000012', 'inspector', false) $$,
  'an INACTIVE membership in another company is allowed');

-- ---- item 1: finalize conflict RETURNS (not raises) and COMMITS revocation --
do $$
begin
  -- act as company A's admin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'a1a1a1a1-0000-4000-8000-000000000011',
                      'email', 'admina@pgtap.local', 'role', 'authenticated')::text, true);
  -- begin an invitation for mconf (not active anywhere yet)
  perform public.begin_team_invitation(
    'aaaaaaaa-0000-4000-8000-000000000001', 'mconf@pgtap.local', 'inspector');
  -- mconf then becomes active in company B (the between-begin-and-finalize race)
  insert into public.company_memberships (company_id, user_id, role_key)
  values ('bbbbbbbb-0000-4000-8000-000000000002',
          'a3a3a3a3-0000-4000-8000-000000000013', 'inspector');
end $$;

select ok(
  (select public.finalize_team_invitation(
      (select id from public.invitations
        where company_id = 'aaaaaaaa-0000-4000-8000-000000000001'
          and email = 'mconf@pgtap.local'),
      'a3a3a3a3-0000-4000-8000-000000000013', 'mconf@pgtap.local', true))
    like 'existing_company_conflict%',
  'finalize conflict RETURNS a typed outcome (no raise)');

select ok(
  exists (select 1 from public.invitations
           where email = 'mconf@pgtap.local'
             and revoked_at is not null
             and failed_reason = 'existing_company_conflict'),
  'finalize conflict COMMITTED the revocation (invitation not live)');

select ok(
  not exists (select 1 from public.company_memberships
               where company_id = 'aaaaaaaa-0000-4000-8000-000000000001'
                 and user_id = 'a3a3a3a3-0000-4000-8000-000000000013'),
  'finalize conflict granted NO membership in the invited company');

-- ---- item 3: last-admin guard on the row-locked path ------------------------
do $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'a4a4a4a4-0000-4000-8000-000000000014',
                      'email', 'adminc@pgtap.local', 'role', 'authenticated')::text, true);
end $$;

select throws_ok(
  $$ select public.set_member_role('cccccccc-0000-4000-8000-000000000003',
       'a4a4a4a4-0000-4000-8000-000000000014', 'inspector') $$,
  'P0001', NULL,
  'the sole remaining admin cannot be demoted (last_admin)');

select * from finish();
rollback;
