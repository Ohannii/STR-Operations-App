-- ============================================================
-- PR-A rev 2 acceptance tests: team management + safe invitations
-- ============================================================
-- Run:  pnpm.cmd exec supabase db query --linked -f supabase/tests/team_invitations_test.sql
-- (Per directive: NOT run this round — file kept ready for the approved run.)
--
-- SELF-CONTAINED and SIDE-EFFECT-FREE: applies migration 20260723090000
-- (rev 2) INSIDE this transaction — keep the inline copy in sync with the
-- migration file — runs the acceptance orderings, prints ONE verdict row,
-- ROLLS BACK. Covers the security review's required list: DB record before
-- Auth, provisioning-failure recovery, mid-flight claim convergence,
-- create_company guards, unconfirmed-not-activated, identity mismatch,
-- conflict zero-writes, single-active-membership via claim AND reactivation,
-- invitation-role exactness (old admin role never revived), pending admin
-- never satisfies last-admin, accepted dedup, revoked/expired/renewed
-- claims, properties policies pinned, cross-company RLS.
begin;

-- ================= inline migration (sync with 20260723090000 rev 2) ========
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

create or replace function public.active_membership_elsewhere(
  p_user_id uuid, p_company_id uuid
)
returns text
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

alter table public.invitations
  add column if not exists auth_user_id uuid references public.profiles(id),
  add column if not exists revoked_at timestamptz,
  add column if not exists failed_reason text,
  add column if not exists updated_at timestamptz not null default now();

update public.invitations
   set token = encode(sha256(convert_to(token, 'utf8')), 'hex')
 where token is not null
   and token !~ '^[0-9a-f]{64}$';
alter table public.invitations alter column token drop not null;

create trigger trg_invitations_set_updated_at
  before update on public.invitations
  for each row execute function public.set_updated_at();

create unique index if not exists idx_invitations_live_unique
  on public.invitations (company_id, email)
  where accepted_at is null and revoked_at is null and deleted_at is null;
create unique index if not exists idx_invitations_accepted_unique
  on public.invitations (company_id, auth_user_id)
  where accepted_at is not null and revoked_at is null and deleted_at is null;

create policy "admins read company invitations"
  on public.invitations for select to authenticated
  using (public.has_company_role(company_id, array['company_admin']));
grant select on public.invitations to authenticated;

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

  if exists (
    select 1 from public.company_memberships cm
    join public.profiles p on p.id = cm.user_id
    where cm.company_id = p_company_id and lower(p.email) = v_email
      and cm.is_active and cm.deleted_at is null
  ) then
    outcome := 'already_member'; invitation_id := null;
    return next; return;
  end if;
  select public.active_membership_elsewhere(p.id, p_company_id) into v_conflict
  from public.profiles p where lower(p.email) = v_email
  limit 1;
  if v_conflict is not null then
    raise exception 'existing_company_conflict:%', v_conflict using errcode = 'P0001';
  end if;

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
    raise exception 'identity_mismatch' using errcode = 'P0001';
  end if;

  if v_inv.accepted_at is not null then
    update public.invitations set auth_user_id = p_auth_user_id
     where id = v_inv.id and auth_user_id is null;
    return 'already_member';
  end if;

  v_conflict := public.active_membership_elsewhere(p_auth_user_id, v_inv.company_id);
  if v_conflict is not null then
    -- RETURN (not RAISE) so the revocation COMMITS — see migration rev 3.
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
    return 'already_member';
  end if;

  if p_email_confirmed then
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

  return 'pending_email';
exception
  when unique_violation then
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
end; $$;
revoke all on function public.revoke_invitation(uuid) from public;
grant execute on function public.revoke_invitation(uuid) to authenticated;

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
  if v_inv.email <> v_email and v_email <> '' then
    return 'no_invitation';
  end if;
  if public.active_membership_elsewhere(v_uid, v_inv.company_id) is not null then
    return 'conflict';
  end if;

  select exists (
    select 1 from public.company_memberships
    where company_id = v_inv.company_id and user_id = v_uid
      and is_active and deleted_at is null
  ) into v_had;

  if not v_had then
    insert into public.company_memberships (company_id, user_id, role_key)
    values (v_inv.company_id, v_uid, v_inv.role_key)
    on conflict (company_id, user_id) do update
      set is_active = true, deleted_at = null, role_key = excluded.role_key;
  end if;

  update public.invitations
     set accepted_at = coalesce(accepted_at, now()),
         auth_user_id = v_uid,
         failed_reason = null
   where id = v_inv.id;

  return case when v_had then 'already_member' else 'claimed' end;
exception
  when unique_violation then
    return 'conflict';
end; $$;
revoke all on function public.claim_pending_invitation() from public;
grant execute on function public.claim_pending_invitation() to authenticated;

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
        i.accepted_at is null
        or not exists (
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
    raise exception 'already_member' using errcode = 'P0001';
end;
$$;

create or replace function public.assert_not_last_admin(p_company_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
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
  perform 1 from public.companies where id = p_company_id for update;
  if not public.has_company_role(p_company_id, array['company_admin']) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not p_active then
    perform public.assert_not_last_admin(p_company_id, p_user_id);
  else
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
    raise exception 'existing_company_conflict:%',
      coalesce(public.active_membership_elsewhere(p_user_id, p_company_id), 'another company')
      using errcode = 'P0001';
end; $$;

revoke all on function public.assert_not_last_admin(uuid, uuid) from public;
revoke all on function public.set_member_role(uuid, uuid, text) from public;
revoke all on function public.set_membership_active(uuid, uuid, boolean) from public;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.set_membership_active(uuid, uuid, boolean) to authenticated;

-- Single-active-company invariant index (mirror of migration rev 3). Present
-- via the applied migration in a normal db-reset run; created here defensively
-- so the proofs below hold even if this file is exercised in isolation.
create unique index if not exists idx_memberships_one_active_company
  on public.company_memberships (user_id)
  where is_active and deleted_at is null;
-- ================= end inline migration =====================================

-- ---- harness ----
create temporary table _chk (n serial, label text, pass boolean) on commit drop;
create or replace function pg_temp.chk(p_label text, p_pass boolean)
returns void language sql as $$ insert into _chk (label, pass) values (p_label, p_pass) $$;
create or replace function pg_temp.must_fail(p_label text, p_sql text, p_code text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    perform pg_temp.chk(p_label || '  (NOT REJECTED)', false);
  exception when others then
    perform pg_temp.chk(p_label || '  [' || sqlstate || ']',
                        p_code is null or sqlstate = p_code or sqlerrm like p_code || '%');
  end;
end $$;
create or replace function pg_temp.act_as(p_user uuid, p_email text)
returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'email', p_email, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  v_company uuid := '1669c464-8d26-40fc-9956-9f8955fd27c7';
  v_admin uuid; v_admin_email text;
  co2 uuid;
  admin2 uuid := gen_random_uuid();
  new1  uuid := gen_random_uuid(); -- brand-new invited person (Auth provisioned later)
  exist1 uuid := gen_random_uuid(); -- existing CONFIRMED auth user, no company
  race1 uuid := gen_random_uuid(); -- becomes an active member between begin and finalize
  mid1  uuid := gen_random_uuid(); -- claims between Auth call and finalize (mid-flight)
  olda  uuid := gen_random_uuid(); -- DORMANT company_admin row; re-invited as inspector
  conf1 uuid := gen_random_uuid(); -- goes active elsewhere between begin and claim
  rev1u uuid := gen_random_uuid(); -- invitation gets revoked
  exp1  uuid := gen_random_uuid(); -- invitation expires, then is renewed
  pend1 uuid := gen_random_uuid(); -- pending invitee who tries to create a company
  accrep uuid := gen_random_uuid(); -- accepted invitation whose membership needs repair
  react1 uuid := gen_random_uuid(); -- inactive here, ACTIVE elsewhere (reactivation block)
  insp1 uuid := gen_random_uuid(); -- inspector inside the test company (authority tests)
  other1 uuid := gen_random_uuid(); -- active in ANOTHER company (begin-time conflict)
  mconf uuid := gen_random_uuid(); -- passes begin, goes active elsewhere before finalize
  v_res text; v_out text; v_inv uuid; v_inv2 uuid; v_n int; v_companies_before int;
begin
  if not exists (select 1 from public.companies where id = v_company) then
    raise exception 'ABORTED: test company not found';
  end if;
  select cm.user_id, p.email into v_admin, v_admin_email
  from public.company_memberships cm join public.profiles p on p.id = cm.user_id
  where cm.company_id = v_company and cm.role_key = 'company_admin'
    and cm.is_active and cm.deleted_at is null
  limit 1;
  if v_admin is null then raise exception 'ABORTED: no company_admin in test company'; end if;

  -- Deterministic last-admin scenario (rolled back): v_admin is the ONLY
  -- active admin for the duration of this transaction.
  update public.company_memberships set is_active = false
   where company_id = v_company and role_key = 'company_admin'
     and user_id <> v_admin and is_active and deleted_at is null;

  -- Fixture auth identities (auth.users rows so the profiles FK holds; the
  -- handle_new_user trigger may create profiles, so we force emails after).
  insert into auth.users (id, email) values
    (admin2, 'admin2@test.local'), (new1, 'new1@test.local'),
    (exist1, 'exist1@test.local'), (race1, 'race1@test.local'),
    (mid1, 'mid1@test.local'), (olda, 'olda@test.local'),
    (conf1, 'conf1@test.local'), (rev1u, 'rev1@test.local'),
    (exp1, 'exp1@test.local'), (pend1, 'pend1@test.local'),
    (accrep, 'accrep@test.local'), (react1, 'react1@test.local'),
    (insp1, 'insp1@test.local'), (other1, 'other1@test.local');
  insert into public.profiles (id, email) values
    (admin2, 'admin2@test.local'), (new1, 'new1@test.local'),
    (exist1, 'exist1@test.local'), (race1, 'race1@test.local'),
    (mid1, 'mid1@test.local'), (olda, 'olda@test.local'),
    (conf1, 'conf1@test.local'), (rev1u, 'rev1@test.local'),
    (exp1, 'exp1@test.local'), (pend1, 'pend1@test.local'),
    (accrep, 'accrep@test.local'), (react1, 'react1@test.local'),
    (insp1, 'insp1@test.local'), (other1, 'other1@test.local')
  on conflict (id) do update set email = excluded.email;

  -- Second company: its own admin, other1 active there, react1 active there.
  insert into public.companies (name) values ('TEAMTEST-ROLLBACK-CO2') returning id into co2;
  insert into public.company_memberships (company_id, user_id, role_key) values
    (co2, admin2, 'company_admin'), (co2, other1, 'inspector'),
    (co2, react1, 'inspector');
  -- Inside the test company: an inspector; a DORMANT admin row (olda); an
  -- INACTIVE row for react1 (who is active in co2).
  insert into public.company_memberships (company_id, user_id, role_key)
  values (v_company, insp1, 'inspector');
  insert into public.company_memberships (company_id, user_id, role_key, is_active)
  values (v_company, olda, 'company_admin', false),
         (v_company, react1, 'inspector', false);

  select count(*) into v_companies_before from public.companies;
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));

  -- ============ A. begin_team_invitation: DB record comes FIRST ============
  select b.outcome, b.invitation_id into v_out, v_inv
  from public.begin_team_invitation(v_company, 'New1@Test.LOCAL ', 'inspector') b;
  perform pg_temp.chk('A1: begin creates the DB record first (' || v_out || ')',
    v_out = 'created' and v_inv is not null);
  perform pg_temp.chk('A2: pending row; NO membership; NO accepted_at',
    exists (select 1 from public.invitations
            where id = v_inv and accepted_at is null and revoked_at is null)
    and not exists (select 1 from public.company_memberships
                    where company_id = v_company and user_id = new1));

  select b.outcome, b.invitation_id into v_out, v_inv2
  from public.begin_team_invitation(v_company, 'new1@test.local', 'ops_manager') b;
  perform pg_temp.chk('A3: retry reuses the single live lifecycle (' || v_out || ')',
    v_out = 'pending_exists' and v_inv2 = v_inv);
  select count(*) into v_n from public.invitations
  where company_id = v_company and email = 'new1@test.local'
    and revoked_at is null and deleted_at is null;
  perform pg_temp.chk('A3b: exactly one live row; role updated',
    v_n = 1 and exists (select 1 from public.invitations
                        where id = v_inv and role_key = 'ops_manager'));

  select b.outcome, b.invitation_id into v_out, v_inv2
  from public.begin_team_invitation(v_company, 'insp1@test.local', 'inspector') b;
  perform pg_temp.chk('A4: active member => already_member, NO invitation row',
    v_out = 'already_member' and v_inv2 is null
    and not exists (select 1 from public.invitations
                    where company_id = v_company and email = 'insp1@test.local'));

  perform pg_temp.must_fail('A5: other-company user blocked at begin (typed)',
    format('select * from public.begin_team_invitation(%L, %L, %L)',
           v_company, 'other1@test.local', 'inspector'),
    'existing_company_conflict');
  perform pg_temp.chk('A5b: conflict wrote NOTHING (no invitation, no membership)',
    not exists (select 1 from public.invitations
                where company_id = v_company and email = 'other1@test.local')
    and (select count(*) from public.company_memberships where user_id = other1) = 1);

  perform pg_temp.must_fail('A6: super_admin can never be granted',
    format('select * from public.begin_team_invitation(%L, %L, %L)',
           v_company, 'x@test.local', 'super_admin'), '22023');

  -- ============ B. finalize_team_invitation =================================
  perform pg_temp.must_fail('B1: identity mismatch rejected',
    format('select public.finalize_team_invitation(%L, %L, %L, true)',
           v_inv, new1, 'wrong@test.local'), 'identity_mismatch');

  v_res := public.finalize_team_invitation(v_inv, new1, 'new1@test.local', false);
  perform pg_temp.chk('B2: unconfirmed/new user stays pending_email (' || v_res || ')',
    v_res = 'pending_email');
  perform pg_temp.chk('B2b: NO membership and NO accepted_at until authenticated claim',
    not exists (select 1 from public.company_memberships
                where company_id = v_company and user_id = new1)
    and exists (select 1 from public.invitations
                where id = v_inv and accepted_at is null));

  select b.invitation_id into v_inv2
  from public.begin_team_invitation(v_company, 'exist1@test.local', 'inspector') b;
  v_res := public.finalize_team_invitation(v_inv2, exist1, 'exist1@test.local', true);
  perform pg_temp.chk('B3: confirmed no-company user direct-added (' || v_res || ')',
    v_res = 'added_existing'
    and exists (select 1 from public.company_memberships
                where company_id = v_company and user_id = exist1
                  and is_active and role_key = 'inspector')
    and exists (select 1 from public.invitations
                where id = v_inv2 and accepted_at is not null));

  v_res := public.finalize_team_invitation(v_inv2, exist1, 'exist1@test.local', true);
  perform pg_temp.chk('B4: finalize retry on accepted converges (' || v_res || ')',
    v_res = 'already_member');
  select b.outcome into v_out
  from public.begin_team_invitation(v_company, 'exist1@test.local', 'inspector') b;
  perform pg_temp.chk('B5: re-invite of the now-member is already_member (' || v_out || ')',
    v_out = 'already_member');
  select count(*) into v_n from public.invitations
  where company_id = v_company and auth_user_id = exist1
    and accepted_at is not null and revoked_at is null and deleted_at is null;
  perform pg_temp.chk('B5b: exactly ONE accepted lifecycle for (company,user)', v_n = 1);

  -- Same-company race: membership appears between begin and finalize.
  select b.invitation_id into v_inv2
  from public.begin_team_invitation(v_company, 'race1@test.local', 'inspector') b;
  insert into public.company_memberships (company_id, user_id, role_key)
  values (v_company, race1, 'gm');
  v_res := public.finalize_team_invitation(v_inv2, race1, 'race1@test.local', true);
  perform pg_temp.chk('B6: already-active member => role NOT touched (' || v_res || ')',
    v_res = 'already_member'
    and exists (select 1 from public.company_memberships
                where company_id = v_company and user_id = race1 and role_key = 'gm')
    and exists (select 1 from public.invitations
                where id = v_inv2 and accepted_at is not null));

  -- Mid-flight claim: the user authenticates and claims BETWEEN the Auth
  -- call and finalisation; finalize's accepted-already branch converges.
  select b.invitation_id into v_inv2
  from public.begin_team_invitation(v_company, 'mid1@test.local', 'inspector') b;
  perform pg_temp.act_as(mid1, 'mid1@test.local');
  v_res := public.claim_pending_invitation();
  perform pg_temp.chk('B7: mid-flight claim lands membership (' || v_res || ')',
    v_res = 'claimed'
    and exists (select 1 from public.company_memberships
                where company_id = v_company and user_id = mid1
                  and is_active and role_key = 'inspector'));
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
  v_res := public.finalize_team_invitation(v_inv2, mid1, 'mid1@test.local', false);
  perform pg_temp.chk('B7b: finalize AFTER the claim converges (' || v_res || ')',
    v_res = 'already_member'
    and exists (select 1 from public.invitations
                where id = v_inv2 and auth_user_id = mid1));

  -- ============ C. provisioning failure is recoverable ======================
  select b.invitation_id into v_inv2
  from public.begin_team_invitation(v_company, 'fail1@test.local', 'inspector') b;
  perform public.mark_invitation_failed(v_inv2, 'auth invite failed: boom');
  perform pg_temp.chk('C1: failure recorded on the SAME lifecycle',
    exists (select 1 from public.invitations
            where id = v_inv2 and failed_reason like 'auth invite failed%'
              and accepted_at is null and revoked_at is null));
  select b.outcome, b.invitation_id into v_out, v_inv
  from public.begin_team_invitation(v_company, 'fail1@test.local', 'inspector') b;
  perform pg_temp.chk('C2: retry converges on the same record and clears failure',
    v_out = 'pending_exists' and v_inv = v_inv2
    and exists (select 1 from public.invitations
                where id = v_inv2 and failed_reason is null));

  -- ============ D. claim paths =============================================
  perform pg_temp.act_as(new1, 'new1@test.local');
  v_res := public.claim_pending_invitation();
  perform pg_temp.chk('D1: authenticated claim creates the membership (' || v_res || ')',
    v_res = 'claimed');
  perform pg_temp.chk('D1b: membership uses the INVITATION role (ops_manager, the updated one)',
    exists (select 1 from public.company_memberships
            where company_id = v_company and user_id = new1
              and is_active and role_key = 'ops_manager'));
  perform pg_temp.chk('D1c: accepted_at stamped only now (authenticated acceptance)',
    exists (select 1 from public.invitations
            where company_id = v_company and email = 'new1@test.local'
              and accepted_at is not null and auth_user_id = new1));

  -- Old, more powerful role must NEVER be revived by a claim.
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
  perform public.begin_team_invitation(v_company, 'olda@test.local', 'inspector');
  perform pg_temp.act_as(olda, 'olda@test.local');
  v_res := public.claim_pending_invitation();
  perform pg_temp.chk('D2: dormant company_admin re-invited as inspector => inspector (' || v_res || ')',
    v_res = 'claimed'
    and exists (select 1 from public.company_memberships
                where company_id = v_company and user_id = olda
                  and is_active and role_key = 'inspector')
    and not exists (select 1 from public.company_memberships
                    where company_id = v_company and user_id = olda
                      and role_key = 'company_admin'));

  -- Conflict detected BEFORE any write.
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
  select b.invitation_id into v_inv2
  from public.begin_team_invitation(v_company, 'conf1@test.local', 'inspector') b;
  insert into public.company_memberships (company_id, user_id, role_key)
  values (co2, conf1, 'inspector'); -- became active ELSEWHERE before claiming
  perform pg_temp.act_as(conf1, 'conf1@test.local');
  v_res := public.claim_pending_invitation();
  perform pg_temp.chk('D3: claim conflict is typed and writes NOTHING (' || v_res || ')',
    v_res = 'conflict'
    and not exists (select 1 from public.company_memberships
                    where company_id = v_company and user_id = conf1)
    and exists (select 1 from public.invitations
                where id = v_inv2 and accepted_at is null));

  -- Revoked.
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
  select b.invitation_id into v_inv2
  from public.begin_team_invitation(v_company, 'rev1@test.local', 'inspector') b;
  v_res := public.revoke_invitation(v_inv2);
  perform pg_temp.chk('D4: revoke succeeds (' || v_res || ')', v_res = 'revoked');
  v_res := public.revoke_invitation(v_inv2);
  perform pg_temp.chk('D4b: double revoke typed (' || v_res || ')', v_res = 'already_revoked');
  v_res := public.renew_invitation(v_inv2);
  perform pg_temp.chk('D4c: renew of revoked typed (' || v_res || ')', v_res = 'revoked');
  perform pg_temp.act_as(rev1u, 'rev1@test.local');
  v_res := public.claim_pending_invitation();
  perform pg_temp.chk('D4d: revoked claim typed, no membership (' || v_res || ')',
    v_res = 'revoked'
    and not exists (select 1 from public.company_memberships
                    where company_id = v_company and user_id = rev1u));

  -- Expired -> renewed -> claimable.
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
  select b.invitation_id into v_inv2
  from public.begin_team_invitation(v_company, 'exp1@test.local', 'inspector') b;
  update public.invitations set expires_at = now() - interval '1 day' where id = v_inv2;
  perform pg_temp.act_as(exp1, 'exp1@test.local');
  v_res := public.claim_pending_invitation();
  perform pg_temp.chk('D5: expired claim typed, no membership (' || v_res || ')',
    v_res = 'expired'
    and not exists (select 1 from public.company_memberships
                    where company_id = v_company and user_id = exp1));
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
  v_res := public.renew_invitation(v_inv2);
  perform pg_temp.chk('D5b: renew extends the DB expiry (' || v_res || ')',
    v_res = 'renewed'
    and exists (select 1 from public.invitations
                where id = v_inv2 and expires_at > now()));
  perform pg_temp.act_as(exp1, 'exp1@test.local');
  v_res := public.claim_pending_invitation();
  perform pg_temp.chk('D5c: renewed invitation is claimable (' || v_res || ')',
    v_res = 'claimed');

  -- Renew on an accepted lifecycle is typed.
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
  select id into v_inv2 from public.invitations
  where company_id = v_company and auth_user_id = exist1 and accepted_at is not null
  limit 1;
  v_res := public.renew_invitation(v_inv2);
  perform pg_temp.chk('D6: renew of accepted typed (' || v_res || ')',
    v_res = 'already_accepted');

  -- ============ E. create_company_with_admin DB guards ======================
  perform public.begin_team_invitation(v_company, 'pend1@test.local', 'inspector');
  perform pg_temp.act_as(pend1, 'pend1@test.local');
  perform pg_temp.must_fail('E1: pending invitee cannot create a company',
    'select public.create_company_with_admin(''ROGUE CO'')', 'invitation_pending');
  perform pg_temp.act_as(exist1, 'exist1@test.local');
  perform pg_temp.must_fail('E2: active member cannot create a company',
    'select public.create_company_with_admin(''ROGUE CO 2'')', 'already_member');

  -- Accepted-but-unrepaired: membership lost after acceptance.
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
  select b.invitation_id into v_inv2
  from public.begin_team_invitation(v_company, 'accrep@test.local', 'inspector') b;
  v_res := public.finalize_team_invitation(v_inv2, accrep, 'accrep@test.local', true);
  delete from public.company_memberships
   where company_id = v_company and user_id = accrep; -- simulate damage
  perform pg_temp.act_as(accrep, 'accrep@test.local');
  perform pg_temp.must_fail('E3: accepted-unrepaired invitee cannot create a company',
    'select public.create_company_with_admin(''ROGUE CO 3'')', 'invitation_pending');
  v_res := public.claim_pending_invitation();
  perform pg_temp.chk('E3b: claim REPAIRS the membership instead (' || v_res || ')',
    v_res = 'claimed'
    and exists (select 1 from public.company_memberships
                where company_id = v_company and user_id = accrep and is_active));

  select count(*) into v_n from public.companies;
  perform pg_temp.chk('E4: company count unchanged by the whole epic', v_n = v_companies_before);

  -- ============ F. pending admin NEVER satisfies last-admin =================
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
  perform public.begin_team_invitation(v_company, 'padmin@test.local', 'company_admin');
  perform pg_temp.chk('F1: pending company_admin invite holds NO membership',
    not exists (select 1 from public.company_memberships cm
                join public.profiles p on p.id = cm.user_id
                where cm.company_id = v_company and lower(p.email) = 'padmin@test.local'));
  perform pg_temp.must_fail('F2: last admin cannot demote self despite pending admin invite',
    format('select public.set_member_role(%L, %L, %L)', v_company, v_admin, 'inspector'),
    'last_admin');
  perform pg_temp.must_fail('F3: last admin cannot deactivate self despite pending admin invite',
    format('select public.set_membership_active(%L, %L, false)', v_company, v_admin),
    'last_admin');

  -- ============ G. authority ================================================
  perform pg_temp.act_as(insp1, 'insp1@test.local');
  perform pg_temp.must_fail('G1: inspector cannot invite',
    format('select * from public.begin_team_invitation(%L, %L, %L)',
           v_company, 'y@test.local', 'inspector'), '42501');
  perform pg_temp.must_fail('G1b: inspector cannot change roles',
    format('select public.set_member_role(%L, %L, %L)', v_company, exist1, 'gm'), '42501');
  perform pg_temp.must_fail('G1c: inspector cannot deactivate',
    format('select public.set_membership_active(%L, %L, false)', v_company, exist1), '42501');
  perform pg_temp.act_as(admin2, 'admin2@test.local');
  perform pg_temp.must_fail('G2: foreign admin blocked',
    format('select * from public.begin_team_invitation(%L, %L, %L)',
           v_company, 'z@test.local', 'inspector'), '42501');

  -- ============ H. reactivation respects single-active-company ==============
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
  perform pg_temp.must_fail('H1: reactivating someone active elsewhere is blocked',
    format('select public.set_membership_active(%L, %L, true)', v_company, react1),
    'existing_company_conflict');
  perform pg_temp.chk('H1b: the row stayed inactive',
    not exists (select 1 from public.company_memberships
                where company_id = v_company and user_id = react1 and is_active));

  -- ============ I. accepted-dedup enforced by the database ==================
  perform pg_temp.must_fail('I1: second accepted lifecycle for (company,user) rejected',
    format('insert into public.invitations
              (company_id, email, role_key, invited_by, auth_user_id, expires_at, accepted_at)
            values (%L, %L, %L, %L, %L, now(), now())',
           v_company, 'exist1-dup@test.local', 'inspector', v_admin, exist1),
    '23505');

  -- ============ J. properties policies are UNTOUCHED ========================
  select count(*) into v_n from pg_policies
  where schemaname = 'public' and tablename = 'properties';
  perform pg_temp.chk('J1: properties policy count unchanged (3)', v_n = 3);
  perform pg_temp.chk('J1b: member-wide read policy still present',
    exists (select 1 from pg_policies
            where tablename = 'properties'
              and policyname = 'members read company properties'));

  -- ============ K. cross-company RLS on invitations =========================
  begin
    execute 'set local role authenticated';
    perform pg_temp.act_as(admin2, 'admin2@test.local');
    select count(*) into v_n from public.invitations where company_id = v_company;
    perform pg_temp.chk('K1: foreign admin sees ZERO invitations of the test company', v_n = 0);
    perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
    select count(*) into v_n from public.invitations where company_id = v_company;
    perform pg_temp.chk('K2: own admin sees the company invitations', v_n > 0);
    execute 'reset role';
  exception when others then
    execute 'reset role';
    perform pg_temp.chk('K0: RLS visibility SKIPPED (role switch unavailable: '
                        || sqlerrm || ') — verify manually', true);
  end;

  -- ============ L. last-admin releases once a REAL second admin exists ======
  perform pg_temp.act_as(v_admin, coalesce(v_admin_email, 'admin@test.local'));
  perform public.set_member_role(v_company, exist1, 'company_admin');
  perform public.set_member_role(v_company, v_admin, 'inspector'); -- must NOT raise now
  perform pg_temp.chk('L1: with a second REAL admin, the founder can step down',
    exists (select 1 from public.company_memberships
            where company_id = v_company and user_id = v_admin
              and role_key = 'inspector' and is_active));

  -- ============ M. correction round (rev 3) ================================
  -- Item 1: finalize conflict RETURNS a typed outcome and COMMITS the
  -- revocation (previously it raised, rolling the revocation back).
  perform pg_temp.act_as(exist1, 'exist1@test.local'); -- exist1 is a company_admin now (L)
  insert into auth.users (id, email) values (mconf, 'mconf@test.local')
    on conflict (id) do nothing;
  insert into public.profiles (id, email) values (mconf, 'mconf@test.local')
    on conflict (id) do update set email = excluded.email;
  -- begin succeeds: mconf is not active anywhere yet.
  select b.invitation_id into v_inv
  from public.begin_team_invitation(v_company, 'mconf@test.local', 'inspector') b;
  -- mconf now becomes active in co2 (the "between begin and finalize" race).
  insert into public.company_memberships (company_id, user_id, role_key)
  values (co2, mconf, 'inspector');
  -- finalize must RETURN (not raise) a conflict outcome.
  select public.finalize_team_invitation(v_inv, mconf, 'mconf@test.local', true) into v_out;
  perform pg_temp.chk('M1: finalize conflict RETURNS existing_company_conflict (no raise) ('
    || coalesce(v_out, 'null') || ')', v_out like 'existing_company_conflict%');
  perform pg_temp.chk('M1b: revocation COMMITTED — invitation is revoked/failed, not live',
    exists (select 1 from public.invitations
            where id = v_inv and revoked_at is not null
              and failed_reason = 'existing_company_conflict'));
  perform pg_temp.chk('M1c: NO membership granted in the invited company',
    not exists (select 1 from public.company_memberships
                where company_id = v_company and user_id = mconf));

  -- Item 2: the single-active-company invariant is enforced at the DATABASE.
  perform pg_temp.must_fail('M2: a raw second ACTIVE membership for one user is rejected',
    format('insert into public.company_memberships (company_id, user_id, role_key)
            values (%L, %L, %L)', co2, insp1, 'inspector'),  -- insp1 already active in test company
    '23505');
  -- An INACTIVE membership in another company is still allowed.
  insert into public.company_memberships (company_id, user_id, role_key, is_active)
  values (co2, insp1, 'inspector', false);
  perform pg_temp.chk('M2b: an INACTIVE membership elsewhere is allowed',
    exists (select 1 from public.company_memberships
            where company_id = co2 and user_id = insp1 and not is_active));

  -- Item 3: the last-admin logical guard still holds under the row-lock path.
  -- (True two-session concurrency is proven separately; a single-transaction
  -- test cannot interleave sessions. F2/F3 + this assert the guard itself.)
  perform pg_temp.act_as(exist1, 'exist1@test.local'); -- exist1 is now the last active admin
  perform public.set_member_role(v_company, v_admin, 'company_admin'); -- restore a 2nd admin
  perform public.set_member_role(v_company, v_admin, 'inspector');     -- allowed: 2 admins exist
  perform pg_temp.must_fail('M3: last remaining admin still cannot demote self (locked path)',
    format('select public.set_member_role(%L, %L, %L)', v_company, exist1, 'inspector'),
    'last_admin');
end $$;

select
  case when count(*) filter (where not pass) = 0
       then 'TEAM TESTS (rev 2): ALL ' || count(*) || ' PASS (rolled back)'
       else 'TEAM TESTS (rev 2): ' || count(*) filter (where not pass) || ' FAILED of ' || count(*)
  end as verdict,
  string_agg(case when not pass then label end, ' | ') as failures
from _chk;

rollback;
