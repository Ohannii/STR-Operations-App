-- ============================================================
-- Migration 0006 — Auth wiring + minimal RLS for dashboard
-- ============================================================
-- Goal of this migration:
--   1. Mirror auth.users → public.profiles on signup (trigger).
--   2. Provide a safe bootstrap path for the first user/company,
--      avoiding the membership deadlock (you can't insert a
--      company_membership before the company exists, but the
--      company INSERT policy would otherwise require an existing
--      membership).
--   3. Add the smallest set of RLS policies needed for a logged-in
--      user to see their company, profile, memberships, and
--      properties. Everything else stays deny-by-default.
--
-- Out of scope for this migration (deliberately deferred):
--   - INSERT/UPDATE policies for stays, inspections, flags,
--     issues, maintenance_jobs, etc. (added when those screens
--     are built).
--   - Per-company seeding of the four inspection templates
--     (added in a follow-up migration once we wire the
--     template-driven inspection flow).
--   - Per-property scoping (property_assignments + role-based
--     read narrowing). v1.0 dashboard treats "member of company"
--     as the read boundary; the assignment-based narrowing
--     arrives in v1.2 with the full role matrix.
--
-- All functions are SECURITY DEFINER with `set search_path = public`
-- to prevent search_path injection. They run with the owner role
-- (postgres) and bypass RLS internally, which is required for the
-- bootstrap and for the is_company_member helper used by policies.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. handle_new_user — auth.users → public.profiles trigger
-- ----------------------------------------------------------------
-- Supabase's auth.users is the source of truth for identity.
-- When a row is inserted there (signup, magic link, OAuth, etc.),
-- this trigger mirrors a profile row keyed by the same uuid.
--
-- We pull full_name from raw_user_meta_data when the client passes
-- it on signup; fall back to email so the profile always has
-- something to display.
--
-- ON CONFLICT (id) DO NOTHING keeps this idempotent in case the
-- profile was somehow created out-of-band already.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, phone, full_name)
  values (
    NEW.id,
    NEW.email,
    NEW.phone,
    coalesce(
      nullif(NEW.raw_user_meta_data ->> 'full_name', ''),
      NEW.email
    )
  )
  on conflict (id) do nothing;
  return NEW;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ----------------------------------------------------------------
-- 2. is_company_member — RLS helper
-- ----------------------------------------------------------------
-- A SECURITY DEFINER helper that answers "is the calling user an
-- active member of this company?" Used by every company-scoped
-- read policy below.
--
-- Why a helper? Without it, an RLS policy on `companies` that
-- references `company_memberships` triggers RLS evaluation on
-- `company_memberships`, which would itself need to read its own
-- table — a recursion hazard. Wrapping the check in a SECURITY
-- DEFINER function bypasses RLS for that single lookup, which is
-- safe because the function only ever returns a boolean.
--
-- `stable` (not `immutable`) because auth.uid() can change between
-- statements in a transaction.

create or replace function public.is_company_member(p_company_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.company_memberships
    where company_id = p_company_id
      and user_id = auth.uid()
      and is_active
      and deleted_at is null
  );
$$;

grant execute on function public.is_company_member(uuid) to authenticated;


-- ----------------------------------------------------------------
-- 3. create_company_with_admin — bootstrap function
-- ----------------------------------------------------------------
-- Solves the "first company" deadlock:
--   * companies table has NO insert policy (only this function
--     and service_role can create one).
--   * company_memberships has NO insert policy either.
--   * approval_policies has NO insert policy.
--
-- This function inserts all three atomically as the function owner
-- (postgres, which bypasses RLS), but only after verifying the
-- caller is authenticated. Returns the new company id.
--
-- Subsequent team members are invited via the `invitations` table
-- (separate flow, not in this migration).
--
-- Default approval policy uses the Dropinn-style ZA defaults from
-- docs/APPROVAL_LIMITS_AND_CONTRACT_RULES.md and docs/SEED_DATA_PLAN.md.

create or replace function public.create_company_with_admin(p_company_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_user_id    uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_company_name is null or length(trim(p_company_name)) = 0 then
    raise exception 'company name required' using errcode = '22023';
  end if;

  -- Defensive: ensure a profile row exists for the calling user.
  -- handle_new_user() should have created one already, but if a
  -- user signed up before this trigger existed, bootstrap it now.
  insert into public.profiles (id)
  values (v_user_id)
  on conflict (id) do nothing;

  -- 1. Create the company.
  insert into public.companies (name)
  values (trim(p_company_name))
  returning id into v_company_id;

  -- 2. Make the calling user the company_admin.
  insert into public.company_memberships (company_id, user_id, role_key)
  values (v_company_id, v_user_id, 'company_admin');

  -- 3. Seed the default approval policy (Dropinn ZA defaults).
  insert into public.approval_policies (
    company_id,
    scope_type,
    single_inventory_item_cap,
    single_maintenance_item_cap,
    single_owner_chargeable_cap,
    monthly_owner_total_cap,
    annual_owner_total_cap,
    internal_approvable_below,
    internal_ceiling,
    absolute_block_above,
    notes,
    created_by
  ) values (
    v_company_id,
    'company',
    1000.00,
    2000.00,
    2000.00,
    2000.00,
    60000.00,
    0,
    2000.00,
    10000.00,
    'Default policy seeded on company creation. Edit before approving any charges.',
    v_user_id
  );

  -- 4. Mark seeding complete so a future seeding pass (e.g. the
  --    template seeding migration) can detect it.
  update public.companies
     set seed_policy_applied = true
   where id = v_company_id;

  return v_company_id;
end;
$$;

grant execute on function public.create_company_with_admin(text) to authenticated;


-- ============================================================
-- RLS POLICIES
-- ============================================================
-- Pattern recap:
--   - Tables already have RLS enabled (migration 0005).
--   - No policies = deny-by-default.
--   - We add ONLY the policies needed for v1.0 dashboard reads
--     plus the property-management writes.
--   - SELECT first; INSERT/UPDATE only where the dashboard needs them.
-- ============================================================


-- ----------------------------------------------------------------
-- 4. roles — public SELECT (system-wide reference data)
-- ----------------------------------------------------------------
-- Every user needs to be able to read the role catalogue (for
-- UI labels, role pickers, etc.). No tenant scope applies.

create policy "anyone reads roles"
  on public.roles
  for select
  to anon, authenticated
  using (true);


-- ----------------------------------------------------------------
-- 5. flag_categories — system reads + per-company reads
-- ----------------------------------------------------------------
-- The 11 system rows (company_id IS NULL) are public reference data
-- — every user, in any company, needs them to render flag pickers.
-- Future per-company custom categories (company_id IS NOT NULL,
-- v1.5+) are scoped to members of that company only.

create policy "anyone reads system flag_categories"
  on public.flag_categories
  for select
  to anon, authenticated
  using (company_id is null);

create policy "members read company flag_categories"
  on public.flag_categories
  for select
  to authenticated
  using (
    company_id is not null
    and public.is_company_member(company_id)
  );


-- ----------------------------------------------------------------
-- 6. companies — members read their own
-- ----------------------------------------------------------------
-- No INSERT policy: companies are only ever created via
-- create_company_with_admin() above.
-- No UPDATE policy in v1.0: editing company name/slug arrives
-- with the settings page.

create policy "members read own companies"
  on public.companies
  for select
  to authenticated
  using (public.is_company_member(id));


-- ----------------------------------------------------------------
-- 7. profiles — own profile read + self-update
-- ----------------------------------------------------------------
-- v1.0 dashboard only needs the user to see their own profile.
-- Reading co-members' profiles lands when the team management UI
-- ships (so a manager can see "Inspector: John Smith"). Left out
-- here to keep this migration tight.

create policy "users read own profile"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

create policy "users update own profile"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());


-- ----------------------------------------------------------------
-- 8. company_memberships — read your own + your company's
-- ----------------------------------------------------------------
-- A user sees:
--   * their own membership rows (so the app knows which company
--     they belong to), AND
--   * all memberships in companies they belong to (foundation for
--     the team list later).
-- No INSERT policy: created via create_company_with_admin() or
-- via the invitation acceptance flow (separate migration).

create policy "users read own memberships"
  on public.company_memberships
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "members read company memberships"
  on public.company_memberships
  for select
  to authenticated
  using (public.is_company_member(company_id));


-- ----------------------------------------------------------------
-- 9. properties — members read + members write
-- ----------------------------------------------------------------
-- For v1.0 dashboard we need read + create + edit for any member
-- of the company. Per-role narrowing (only Admin/GM/OpsMgr can
-- create properties per USER_ROLES_AND_PERMISSIONS.md) arrives in
-- v1.2 alongside the role-aware permission helpers. For v1.0 the
-- first user is always company_admin (per bootstrap) so this is
-- safe in practice.

create policy "members read company properties"
  on public.properties
  for select
  to authenticated
  using (public.is_company_member(company_id));

create policy "members insert company properties"
  on public.properties
  for insert
  to authenticated
  with check (public.is_company_member(company_id));

create policy "members update company properties"
  on public.properties
  for update
  to authenticated
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));


-- ----------------------------------------------------------------
-- 10. property_assignments and property_owner_links — read only
-- ----------------------------------------------------------------
-- The dashboard may display "assigned to" badges and owner names.
-- Writes (assigning a user, linking an owner) belong to the
-- settings page, deferred to a later migration.

create policy "members read property assignments"
  on public.property_assignments
  for select
  to authenticated
  using (public.is_company_member(company_id));

create policy "members read property owner links"
  on public.property_owner_links
  for select
  to authenticated
  using (public.is_company_member(company_id));
