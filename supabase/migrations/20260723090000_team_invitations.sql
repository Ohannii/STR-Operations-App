-- ============================================================
-- PR-A (rev 2, security review applied): team management + invitations
-- ============================================================
-- DO NOT APPLY without explicit approval (project rule).
--
-- STATE MACHINE (the review's core corrections):
--
--   begin_team_invitation           finalize_team_invitation        claim_pending_invitation
--   (admin; DB record FIRST) ---->  (admin; after Auth Admin) ----> (the invited user, authenticated)
--        |                               |                                |
--   pending row,                    attaches trusted auth_user_id;   creates/reactivates the ONE
--   NO membership,                  confirmed no-company user =>     membership with the INVITATION
--   NO auth call yet                direct add (membership+accept);  role; stamps accepted_at ONLY
--                                   new/unconfirmed => stays         after membership convergence
--                                   pending (NO membership)
--
-- INVARIANTS: the DB invitation exists BEFORE any Auth send/generate; one
-- live invitation per (company, canonical email); one accepted lifecycle per
-- (company, user); one active membership per user ACROSS companies (checked
-- at every write); membership role comes from the INVITATION on claim (an
-- old, more powerful role is never revived); accepted_at means authenticated
-- acceptance (or a confirmed direct add), never "admin pressed Invite";
-- pending invited admins hold NO membership, so they can never satisfy the
-- last-admin guard; conflicts make ZERO surviving live writes.
--
-- Authority: company_admin only, enforced inside every SECURITY DEFINER
-- function; invitations/memberships keep NO write policies (verified: none
-- exist today — writes happen only through these functions).

-- ----------------------------------------------------------------
-- 1. Helpers
-- ----------------------------------------------------------------
create or replace function public.has_company_role(p_company_id uuid, p_roles text[])
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.company_memberships
    where company_id = p_company_id and user_id = auth.uid()
      and role_key = any (p_roles) and is_active and deleted_at is null
  );
$$;
revoke all on function public.has_company_role(uuid, text[]) from public;
grant execute on function public.has_company_role(uuid, text[]) to authenticated;

-- Explicit allow-list of COMPANY roles (platform super_admin excluded, and
-- unknown role-table keys are rejected even if seeded later).
create or replace function public.is_company_grantable_role(p_role_key text)
returns boolean
language sql immutable
as $$
  select p_role_key = any (array[
    'company_admin','gm','ops_manager','maintenance_coordinator','inspector',
    'maintenance_tech','inventory_manager','finance','auditor',
    'property_owner_viewer'
  ]);
$$;

create or replace function public.shares_company_with(p_profile_id uuid)
returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1
    from public.company_memberships mine
    join public.company_memberships theirs on theirs.company_id = mine.company_id
    where mine.user_id = auth.uid() and mine.is_active and mine.deleted_at is null
      and theirs.user_id = p_profile_id and theirs.deleted_at is null
  );
$$;
revoke all on function public.shares_company_with(uuid) from public;
grant execute on function public.shares_company_with(uuid) to authenticated;

create policy "members read teammate profiles"
  on public.profiles for select to authenticated
  using (public.shares_company_with(id));

-- Active membership in a DIFFERENT company (the single-company invariant:
-- the app resolves the oldest active membership and has no switcher).
create or replace function public.active_membership_elsewhere(
  p_user_id uuid, p_company_id uuid
)
returns text -- conflicting company name, or null
language sql security definer stable set search_path = public
as $$
  select c.name
  from public.company_memberships cm
  join public.companies c on c.id = cm.company_id
  where cm.user_id = p_user_id and cm.company_id <> p_company_id
    and cm.is_active and cm.deleted_at is null
  limit 1;
$$;
revoke all on function public.active_membership_elsewhere(uuid, uuid) from public;

-- ----------------------------------------------------------------
-- 1b. Single-active-company invariant — ENFORCED AT THE DATABASE
-- ----------------------------------------------------------------
-- active_membership_elsewhere() above is an app-level SELECT and is NOT
-- concurrency-safe on its own: two racing claims/adds can each pass the check
-- and both insert an active membership. A partial unique index makes "at most
-- one active membership per user, across ALL companies" a hard invariant, so
-- the losing transaction fails with unique_violation (mapped to a safe
-- conflict outcome by each writing RPC below).
--
-- Fail closed FIRST if legacy data already violates the rule. We NEVER delete,
-- deactivate, move, or otherwise repair rows automatically — a human resolves
-- the duplication, then re-runs the migration.
do $$
declare v_dupe record;
begin
  select cm.user_id as user_id, count(*) as n
    into v_dupe
    from public.company_memberships cm
   where cm.is_active and cm.deleted_at is null
   group by cm.user_id
  having count(*) > 1
   limit 1;
  if found then
    raise exception
      'MIGRATION BLOCKED: user % already has % active memberships. The single-'
      'active-company invariant cannot be enforced until this is resolved by '
      'hand. No data was changed by this migration.', v_dupe.user_id, v_dupe.n
      using errcode = 'P0001';
  end if;
end $$;

create unique index if not exists idx_memberships_one_active_company
  on public.company_memberships (user_id)
  where is_active and deleted_at is null;

-- ----------------------------------------------------------------
-- 2. invitations — lifecycle columns, dedupe indexes, RLS
-- ----------------------------------------------------------------
alter table public.invitations
  add column if not exists auth_user_id uuid references public.profiles(id),
  add column if not exists revoked_at timestamptz,
  add column if not exists failed_reason text,
  add column if not exists updated_at timestamptz not null default now();

-- Legacy raw-secret hygiene. The feature never shipped, so no live rows are
-- expected anywhere; defensively, hash anything that is not ALREADY a
-- sha256 hex digest (validated by format, not by length alone).
update public.invitations
   set token = encode(sha256(convert_to(token, 'utf8')), 'hex')
 where token is not null
   and token !~ '^[0-9a-f]{64}$';
alter table public.invitations alter column token drop not null;
comment on column public.invitations.token is
  'DEPRECATED: legacy raw invite secret, sha256-hashed in place by migration '
  '20260723090000 (format-validated). New rows leave this NULL — the Supabase '
  'Auth invite email carries the secret (token_hash + verifyOtp).';

create trigger trg_invitations_set_updated_at
  before update on public.invitations
  for each row execute function public.set_updated_at();

-- ONE live (pending) invitation per company + canonical email…
create unique index if not exists idx_invitations_live_unique
  on public.invitations (company_id, email)
  where accepted_at is null and revoked_at is null and deleted_at is null;
-- …and ONE accepted lifecycle per company + user (review: repeated direct
-- adds must not accumulate accepted rows — enforced at the database).
create unique index if not exists idx_invitations_accepted_unique
  on public.invitations (company_id, auth_user_id)
  where accepted_at is not null and revoked_at is null and deleted_at is null;

create policy "admins read company invitations"
  on public.invitations for select to authenticated
  using (public.has_company_role(company_id, array['company_admin']));
grant select on public.invitations to authenticated;

-- ----------------------------------------------------------------
-- 3. begin_team_invitation — the DB record comes FIRST
-- ----------------------------------------------------------------
-- Returns (outcome, invitation_id):
--   'created' | 'pending_exists' | 'already_member'
-- Raises: not_authorized | bad_role | existing_company_conflict (no writes).
create or replace function public.begin_team_invitation(
  p_company_id uuid, p_email text, p_role_key text
)
returns table (outcome text, invitation_id uuid)
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_conflict text;
  v_inv public.invitations%rowtype;
begin
  if not public.has_company_role(p_company_id, array['company_admin']) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'valid email required' using errcode = '22023';
  end if;
  if not public.is_company_grantable_role(p_role_key) then
    raise exception 'bad_role' using errcode = '22023';
  end if;

  -- Identity by canonical email at this stage (no Auth id yet; profiles
  -- are trigger-populated from auth.users, so email->profile is trusted).
  -- Already an active member here: nothing to do, and NO invitation row.
  if exists (
    select 1 from public.company_memberships cm
    join public.profiles p on p.id = cm.user_id
    where cm.company_id = p_company_id and lower(p.email) = v_email
      and cm.is_active and cm.deleted_at is null
  ) then
    outcome := 'already_member'; invitation_id := null;
    return next; return;
  end if;
  -- Active elsewhere: fail closed BEFORE anything (email or DB) happens.
  select public.active_membership_elsewhere(p.id, p_company_id) into v_conflict
  from public.profiles p where lower(p.email) = v_email
  limit 1;
  if v_conflict is not null then
    raise exception 'existing_company_conflict:%', v_conflict using errcode = 'P0001';
  end if;

  -- Reuse the single live lifecycle; a role retry updates it so invitation
  -- role and eventual membership role can never diverge.
  select * into v_inv from public.invitations
  where company_id = p_company_id and email = v_email
    and accepted_at is null and revoked_at is null and deleted_at is null
  for update;
  if found then
    update public.invitations
       set role_key = p_role_key, failed_reason = null
     where id = v_inv.id;
    outcome := 'pending_exists'; invitation_id := v_inv.id;
    return next; return;
  end if;

  insert into public.invitations (company_id, email, role_key, invited_by, expires_at)
  values (p_company_id, v_email, p_role_key, auth.uid(), now() + interval '7 days')
  on conflict (company_id, email)
    where accepted_at is null and revoked_at is null and deleted_at is null
  do update set role_key = excluded.role_key
  returning id into invitation_id;
  insert into public.audit_events
    (company_id, actor_id, event_kind, entity_type, entity_id, metadata)
  values (p_company_id, auth.uid(), 'invitation_created', 'invitation',
          invitation_id, jsonb_build_object('email', v_email, 'role_key', p_role_key));
  outcome := 'created';
  return next;
end; $$;
revoke all on function public.begin_team_invitation(uuid, text, text) from public;
grant execute on function public.begin_team_invitation(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------
-- 4. finalize_team_invitation — after (and only after) Auth Admin
-- ----------------------------------------------------------------
-- The server action passes identity FROM the Auth Admin response (trusted
-- server code); this function still re-validates: the auth email must match
-- the invitation's canonical email, and confirmed-ness decides direct-add.
-- Returns: 'added_existing' | 'pending_email' | 'already_member'
--        | 'existing_company_conflict:<name>'  (revocation committed)
create or replace function public.finalize_team_invitation(
  p_invitation_id uuid,
  p_auth_user_id  uuid,
  p_auth_email    text,
  p_email_confirmed boolean
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_inv public.invitations%rowtype;
  v_conflict text;
begin
  select * into v_inv from public.invitations
  where id = p_invitation_id for update;
  if not found then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  if not public.has_company_role(v_inv.company_id, array['company_admin']) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_inv.revoked_at is not null or v_inv.deleted_at is not null then
    raise exception 'invitation_revoked' using errcode = 'P0001';
  end if;
  if p_auth_user_id is null
     or lower(btrim(coalesce(p_auth_email, ''))) <> v_inv.email then
    -- Auth identity does not belong to this invitation's canonical email.
    raise exception 'identity_mismatch' using errcode = 'P0001';
  end if;

  -- Converged already (the user authenticated and claimed between the Auth
  -- call and this finalisation): record the id if missing and finish.
  if v_inv.accepted_at is not null then
    update public.invitations set auth_user_id = p_auth_user_id
     where id = v_inv.id and auth_user_id is null;
    return 'already_member';
  end if;

  v_conflict := public.active_membership_elsewhere(p_auth_user_id, v_inv.company_id);
  if v_conflict is not null then
    -- The LIVE invitation must not survive a conflict. RETURN a typed outcome
    -- instead of RAISE: a raise here aborts the transaction and rolls this
    -- revocation back, leaving the invitation live. Returning lets the
    -- revoked_at/failed_reason write COMMIT. The server action recognises the
    -- 'existing_company_conflict:<name>' prefix and shows the friendly message.
    update public.invitations
       set revoked_at = now(),
           failed_reason = 'existing_company_conflict'
     where id = v_inv.id;
    return 'existing_company_conflict:' || v_conflict;
  end if;

  update public.invitations
     set auth_user_id = p_auth_user_id, failed_reason = null
   where id = v_inv.id;

  if exists (
    select 1 from public.company_memberships
    where company_id = v_inv.company_id and user_id = p_auth_user_id
      and is_active and deleted_at is null
  ) then
    update public.invitations set accepted_at = now() where id = v_inv.id;
    return 'already_member'; -- and their existing role is NOT touched
  end if;

  if p_email_confirmed then
    -- Confirmed, no active company anywhere: safe direct add with the
    -- INVITATION role; this IS authenticated-equivalent acceptance.
    insert into public.company_memberships (company_id, user_id, role_key)
    values (v_inv.company_id, p_auth_user_id, v_inv.role_key)
    on conflict (company_id, user_id) do update
      set is_active = true, deleted_at = null, role_key = excluded.role_key;
    update public.invitations set accepted_at = now() where id = v_inv.id;
    insert into public.audit_events
      (company_id, actor_id, event_kind, entity_type, entity_id, metadata)
    values (v_inv.company_id, auth.uid(), 'team_member_added', 'membership',
            p_auth_user_id, jsonb_build_object('email', v_inv.email,
                                               'role_key', v_inv.role_key));
    return 'added_existing';
  end if;

  -- New or unconfirmed: NO membership until the person authenticates and
  -- claims. accepted_at stays null. This is what keeps a pending invited
  -- admin invisible to the last-admin guard.
  return 'pending_email';
exception
  when unique_violation then
    -- A concurrent path activated a membership for this user (here or
    -- elsewhere) between our check and our insert; the single-active-company
    -- index rejected the duplicate. Fail closed as a conflict — no membership
    -- is granted, and the invitation stays live for a safe retry.
    return 'existing_company_conflict:';
end; $$;
revoke all on function public.finalize_team_invitation(uuid, uuid, text, boolean) from public;
grant execute on function public.finalize_team_invitation(uuid, uuid, text, boolean) to authenticated;

create or replace function public.mark_invitation_failed(p_invitation_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_inv public.invitations%rowtype;
begin
  select * into v_inv from public.invitations where id = p_invitation_id for update;
  if not found then return; end if;
  if not public.has_company_role(v_inv.company_id, array['company_admin']) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_inv.accepted_at is null and v_inv.revoked_at is null then
    update public.invitations
       set failed_reason = left(coalesce(p_reason, 'provisioning failed'), 300)
     where id = v_inv.id;
  end if;
end; $$;
revoke all on function public.mark_invitation_failed(uuid, text) from public;
grant execute on function public.mark_invitation_failed(uuid, text) to authenticated;

-- ----------------------------------------------------------------
-- 5. renew_invitation — resend/share must renew the DB expiry first
-- ----------------------------------------------------------------
create or replace function public.renew_invitation(p_invitation_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare v_inv public.invitations%rowtype;
begin
  select * into v_inv from public.invitations where id = p_invitation_id for update;
  if not found then raise exception 'invitation not found' using errcode = 'P0002'; end if;
  if not public.has_company_role(v_inv.company_id, array['company_admin']) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_inv.revoked_at is not null then return 'revoked'; end if;
  if v_inv.accepted_at is not null then return 'already_accepted'; end if;
  update public.invitations
     set expires_at = now() + interval '7 days', failed_reason = null
   where id = v_inv.id;
  return 'renewed';
end; $$;
revoke all on function public.renew_invitation(uuid) from public;
grant execute on function public.renew_invitation(uuid) to authenticated;

create or replace function public.revoke_invitation(p_invitation_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare v_inv public.invitations%rowtype;
begin
  select * into v_inv from public.invitations where id = p_invitation_id for update;
  if not found then raise exception 'invitation not found' using errcode = 'P0002'; end if;
  if not public.has_company_role(v_inv.company_id, array['company_admin']) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_inv.accepted_at is not null then return 'already_accepted'; end if;
  if v_inv.revoked_at is not null then return 'already_revoked'; end if;
  update public.invitations set revoked_at = now() where id = v_inv.id;
  insert into public.audit_events
    (company_id, actor_id, event_kind, entity_type, entity_id, metadata)
  values (v_inv.company_id, auth.uid(), 'invitation_revoked', 'invitation',
          v_inv.id, jsonb_build_object('email', v_inv.email));
  return 'revoked';
  -- Note: pending invitations hold NO membership under this architecture,
  -- so revoking one can never affect admin counts or lock anyone out.
end; $$;
revoke all on function public.revoke_invitation(uuid) from public;
grant execute on function public.revoke_invitation(uuid) to authenticated;

-- ----------------------------------------------------------------
-- 6. claim_pending_invitation — authenticated, typed, conflict-safe
-- ----------------------------------------------------------------
-- Returns: 'claimed' | 'already_member' | 'no_invitation' | 'expired'
--        | 'revoked' | 'conflict'
-- Makes NO writes on no_invitation / expired / revoked / conflict.
create or replace function public.claim_pending_invitation()
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_inv public.invitations%rowtype;
  v_had boolean;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- The most recent lifecycle addressed to this AUTH identity (id when
  -- recorded, else trusted JWT email). Locked for race-safe one-time claim.
  select * into v_inv from public.invitations i
  where i.deleted_at is null
    and (i.auth_user_id = v_uid
         or (i.auth_user_id is null and i.email = v_email))
  order by i.created_at desc
  limit 1
  for update;

  if not found then return 'no_invitation'; end if;
  if v_inv.revoked_at is not null then return 'revoked'; end if;
  if v_inv.accepted_at is null
     and v_inv.expires_at is not null and v_inv.expires_at < now() then
    return 'expired';
  end if;
  -- Belt: even when addressed by stored id, the authenticated email must
  -- still match the invitation's canonical email.
  if v_inv.email <> v_email and v_email <> '' then
    return 'no_invitation';
  end if;
  -- Single-active-company invariant precedes ANY repair or write.
  if public.active_membership_elsewhere(v_uid, v_inv.company_id) is not null then
    return 'conflict';
  end if;

  select exists (
    select 1 from public.company_memberships
    where company_id = v_inv.company_id and user_id = v_uid
      and is_active and deleted_at is null
  ) into v_had;

  if not v_had then
    -- Create OR reactivate with the INVITATION's exact trusted role — a
    -- previous, more powerful role on a dormant row is never revived.
    insert into public.company_memberships (company_id, user_id, role_key)
    values (v_inv.company_id, v_uid, v_inv.role_key)
    on conflict (company_id, user_id) do update
      set is_active = true, deleted_at = null, role_key = excluded.role_key;
  end if;

  -- accepted_at ONLY after membership convergence.
  update public.invitations
     set accepted_at = coalesce(accepted_at, now()),
         auth_user_id = v_uid,
         failed_reason = null
   where id = v_inv.id;

  return case when v_had then 'already_member' else 'claimed' end;
exception
  when unique_violation then
    -- A concurrent claim/add activated a membership elsewhere between our
    -- check and our insert; the single-active-company index rejected this one.
    -- Fail closed with the same typed outcome as the pre-check path.
    return 'conflict';
end; $$;
revoke all on function public.claim_pending_invitation() from public;
grant execute on function public.claim_pending_invitation() to authenticated;

-- ----------------------------------------------------------------
-- 7. create_company_with_admin — DATABASE-LEVEL guard added
-- ----------------------------------------------------------------
-- Full original body preserved (company + admin membership + default
-- approval policy + seed flag); ONLY the guards at the top are new. A
-- pending/failed/unrepaired-accepted invitee or an existing member cannot
-- create a company even by calling the RPC directly.
create or replace function public.create_company_with_admin(p_company_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid;
  v_user_id    uuid := auth.uid();
  v_email      text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- PR-A GUARDS (database-level; the onboard UI is only convenience).
  if exists (
    select 1 from public.company_memberships
    where user_id = v_user_id and is_active and deleted_at is null
  ) then
    raise exception 'already_member' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.invitations i
    where i.deleted_at is null and i.revoked_at is null
      and (i.auth_user_id = v_user_id
           or (i.auth_user_id is null and i.email = v_email and v_email <> ''))
      and (
        i.accepted_at is null            -- live pending (incl. failed/expired: retry/renew, don't fork a company)
        or not exists (                  -- accepted but membership needs repair
          select 1 from public.company_memberships cm
          where cm.company_id = i.company_id and cm.user_id = v_user_id
            and cm.is_active and cm.deleted_at is null
        )
      )
  ) then
    raise exception 'invitation_pending' using errcode = 'P0001';
  end if;

  if p_company_name is null or length(trim(p_company_name)) = 0 then
    raise exception 'company name required' using errcode = '22023';
  end if;

  insert into public.profiles (id)
  values (v_user_id)
  on conflict (id) do nothing;

  insert into public.companies (name)
  values (trim(p_company_name))
  returning id into v_company_id;

  insert into public.company_memberships (company_id, user_id, role_key)
  values (v_company_id, v_user_id, 'company_admin');

  insert into public.approval_policies (
    company_id, scope_type,
    single_inventory_item_cap, single_maintenance_item_cap,
    single_owner_chargeable_cap, monthly_owner_total_cap,
    annual_owner_total_cap, internal_approvable_below,
    internal_ceiling, absolute_block_above, notes, created_by
  ) values (
    v_company_id, 'company',
    1000.00, 2000.00, 2000.00, 2000.00,
    60000.00, 0, 2000.00, 10000.00,
    'Default policy seeded on company creation. Edit before approving any charges.',
    v_user_id
  );

  update public.companies
     set seed_policy_applied = true
   where id = v_company_id;

  return v_company_id;
exception
  when unique_violation then
    -- A concurrent path created an active membership for this user between the
    -- guard check and the admin-membership insert; the single-active-company
    -- index rejected this one. The whole transaction (including the new
    -- companies row) rolls back, so no orphan company is left behind.
    raise exception 'already_member' using errcode = 'P0001';
end;
$$;

-- ----------------------------------------------------------------
-- 8. Membership management (admin-only, guarded)
-- ----------------------------------------------------------------
create or replace function public.assert_not_last_admin(p_company_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- MEMBERSHIPS only: a pending invited admin has no membership under this
  -- architecture and therefore never counts.
  if exists (
    select 1 from public.company_memberships
    where company_id = p_company_id and user_id = p_user_id
      and role_key = 'company_admin' and is_active and deleted_at is null
  ) and not exists (
    select 1 from public.company_memberships
    where company_id = p_company_id and user_id <> p_user_id
      and role_key = 'company_admin' and is_active and deleted_at is null
  ) then
    raise exception 'last_admin' using errcode = 'P0001';
  end if;
end; $$;

create or replace function public.set_member_role(
  p_company_id uuid, p_user_id uuid, p_role_key text
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- Serialise authority changes for this company (last-admin race): take the
  -- company row lock BEFORE the authorization and admin-count checks, so a
  -- concurrent caller waits and then re-evaluates against post-lock state.
  -- Two racing demotions can never both pass the last-admin guard.
  perform 1 from public.companies where id = p_company_id for update;
  if not public.has_company_role(p_company_id, array['company_admin']) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not public.is_company_grantable_role(p_role_key) then
    raise exception 'bad_role' using errcode = '22023';
  end if;
  if p_role_key <> 'company_admin' then
    perform public.assert_not_last_admin(p_company_id, p_user_id);
  end if;
  update public.company_memberships set role_key = p_role_key
   where company_id = p_company_id and user_id = p_user_id and deleted_at is null;
  if not found then raise exception 'membership not found' using errcode = 'P0002'; end if;
  insert into public.audit_events
    (company_id, actor_id, event_kind, entity_type, entity_id, metadata)
  values (p_company_id, auth.uid(), 'member_role_changed', 'membership',
          p_user_id, jsonb_build_object('role_key', p_role_key));
end; $$;

create or replace function public.set_membership_active(
  p_company_id uuid, p_user_id uuid, p_active boolean
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- Serialise authority changes for this company (last-admin race): lock the
  -- company row BEFORE authorization and admin-count checks so racing
  -- deactivations cannot both pass the last-admin guard and leave zero admins.
  perform 1 from public.companies where id = p_company_id for update;
  if not public.has_company_role(p_company_id, array['company_admin']) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not p_active then
    perform public.assert_not_last_admin(p_company_id, p_user_id);
  else
    -- Reactivation must respect the single-active-company invariant.
    if public.active_membership_elsewhere(p_user_id, p_company_id) is not null then
      raise exception 'existing_company_conflict:%',
        public.active_membership_elsewhere(p_user_id, p_company_id)
        using errcode = 'P0001';
    end if;
  end if;
  update public.company_memberships set is_active = p_active
   where company_id = p_company_id and user_id = p_user_id and deleted_at is null;
  if not found then raise exception 'membership not found' using errcode = 'P0002'; end if;
  insert into public.audit_events
    (company_id, actor_id, event_kind, entity_type, entity_id, metadata)
  values (p_company_id, auth.uid(),
          case when p_active then 'member_activated' else 'member_deactivated' end,
          'membership', p_user_id, '{}'::jsonb);
exception
  when unique_violation then
    -- Concurrent reactivation elsewhere won the race; the single-active-company
    -- index rejected this one. Fail closed as a conflict (nothing was changed).
    raise exception 'existing_company_conflict:%',
      coalesce(public.active_membership_elsewhere(p_user_id, p_company_id), 'another company')
      using errcode = 'P0001';
end; $$;

revoke all on function public.assert_not_last_admin(uuid, uuid) from public;
revoke all on function public.set_member_role(uuid, uuid, text) from public;
revoke all on function public.set_membership_active(uuid, uuid, boolean) from public;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.set_membership_active(uuid, uuid, boolean) to authenticated;
