-- ============================================================
-- Migration 0010 — Guest recovery policies + RPC
-- ============================================================
-- Adds the minimum RLS + grants for Session 5 (first child action
-- type: guest recovery) plus the SECURITY DEFINER bootstrap RPC
-- that creates the recovery task and (when needed) a minimal stay
-- atomically.
--
-- Two-gate principle: every read/write passes the Postgres-level
-- GRANT first, then the row-level RLS policy. recovery_attempts
-- has no company_id of its own so its policies scope through the
-- parent guest_recovery_tasks row.
--
-- DELIBERATELY OUT OF SCOPE
--   - No DELETE on any of these tables.
--   - No UPDATE on stays here. Editing guest contact info on an
--     existing stay lands with the stays UI in a later session.
--   - No UPDATE on recovery_attempts -- it's append-only by design;
--     corrections become a new row.
--   - No role narrowing beyond "is company member".
-- ============================================================


-- ----------------------------------------------------------------
-- 1. stays — SELECT only
-- ----------------------------------------------------------------
-- Members of the company can read stays. Direct INSERT is NOT
-- granted: the only path that creates a stay row in v1.0 is the
-- SECURITY DEFINER RPC below. When the inspection workflow ships
-- and managers need to create stays directly, add an INSERT policy
-- + grant in its own migration.
create policy "members read company stays"
  on public.stays
  for select
  to authenticated
  using (public.is_company_member(company_id));

grant select on public.stays to authenticated;


-- ----------------------------------------------------------------
-- 2. guest_recovery_tasks — SELECT, INSERT, UPDATE
-- ----------------------------------------------------------------
-- INSERT exists for the future case where the flag already has a
-- linked stay (post-inspection-workflow) and we don't need the
-- bootstrap RPC. Today the UI always goes through the RPC because
-- flag.stay_id is always null in our environment.
--
-- INSERT carries the standard `created_by = auth.uid()` anti-forgery
-- guard mirroring the flags + audit_events patterns.
create policy "members read company recovery tasks"
  on public.guest_recovery_tasks
  for select
  to authenticated
  using (public.is_company_member(company_id));

create policy "members insert company recovery tasks"
  on public.guest_recovery_tasks
  for insert
  to authenticated
  with check (
    public.is_company_member(company_id)
    and created_by = auth.uid()
  );

create policy "members update company recovery tasks"
  on public.guest_recovery_tasks
  for update
  to authenticated
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

grant select, insert, update on public.guest_recovery_tasks to authenticated;


-- ----------------------------------------------------------------
-- 3. recovery_attempts — SELECT, INSERT
-- ----------------------------------------------------------------
-- Scoped via EXISTS on the parent task row. The `recorded_by =
-- auth.uid()` check is the same anti-forgery guard used elsewhere.
create policy "members read company recovery attempts"
  on public.recovery_attempts
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.guest_recovery_tasks t
      where t.id = recovery_attempts.task_id
        and public.is_company_member(t.company_id)
    )
  );

create policy "members insert company recovery attempts"
  on public.recovery_attempts
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.guest_recovery_tasks t
      where t.id = recovery_attempts.task_id
        and public.is_company_member(t.company_id)
    )
    and recorded_by = auth.uid()
  );

grant select, insert on public.recovery_attempts to authenticated;


-- ----------------------------------------------------------------
-- 4. SECURITY DEFINER RPC: create_recovery_task_from_flag
-- ----------------------------------------------------------------
-- Atomically:
--   1. Resolves the parent flag and verifies the caller is a member
--      of its company.
--   2. Uses the flag's existing stay_id if set, otherwise creates a
--      minimal stays row capturing the guest contact info.
--   3. Inserts the guest_recovery_tasks row.
--   4. Defaults the flag's chargeable_party_decision to 'guest'
--      if it was null or 'pending_decision'.
--
-- Returns the new recovery task id.
--
-- Runs as the function owner (postgres) so it can write across
-- the deliberately-restrictive stays / approval_policies INSERT
-- gates the rest of the schema enforces.
create or replace function public.create_recovery_task_from_flag(
  p_flag_id          uuid,
  p_guest_first_name text,
  p_guest_phone      text,
  p_guest_email      text default null,
  p_estimated_amount numeric default null,
  p_description      text default null,
  p_deadline_hours   int default 48
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid := auth.uid();
  v_flag     record;
  v_stay_id  uuid;
  v_task_id  uuid;
  v_deadline timestamptz;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_guest_first_name is null or length(trim(p_guest_first_name)) = 0 then
    raise exception 'guest first name required' using errcode = '22023';
  end if;
  if p_guest_phone is null or length(trim(p_guest_phone)) = 0 then
    raise exception 'guest phone required' using errcode = '22023';
  end if;

  -- Resolve the flag.
  select id, company_id, property_id, stay_id, chargeable_party_decision
    into v_flag
  from public.flags
  where id = p_flag_id
    and deleted_at is null;

  if not found then
    raise exception 'flag not found' using errcode = 'P0002';
  end if;

  if not public.is_company_member(v_flag.company_id) then
    raise exception 'not a member of this company' using errcode = '42501';
  end if;

  -- Deadline. Defaults to now + 48h; clamp to at least 1h so an
  -- accidental zero doesn't make every task instantly overdue.
  v_deadline := now()
    + (greatest(coalesce(p_deadline_hours, 48), 1) || ' hours')::interval;

  -- Reuse existing stay if the flag already points at one; else
  -- mint a minimal one from the form. The minimal stay carries
  -- only the contact details we need for WhatsApp + audit.
  if v_flag.stay_id is not null then
    v_stay_id := v_flag.stay_id;
  else
    insert into public.stays (
      company_id,
      property_id,
      guest_first_name,
      guest_phone,
      guest_email,
      actual_checkout,
      status,
      created_by
    ) values (
      v_flag.company_id,
      v_flag.property_id,
      trim(p_guest_first_name),
      trim(p_guest_phone),
      nullif(trim(coalesce(p_guest_email, '')), ''),
      now(),
      'checked_out',
      v_user_id
    )
    returning id into v_stay_id;
  end if;

  -- Create the recovery task.
  insert into public.guest_recovery_tasks (
    company_id,
    property_id,
    stay_id,
    parent_flag_id,
    source_inspection_id,
    description,
    estimated_amount,
    status,
    deadline_at,
    created_by
  ) values (
    v_flag.company_id,
    v_flag.property_id,
    v_stay_id,
    p_flag_id,
    null,
    nullif(trim(coalesce(p_description, '')), ''),
    p_estimated_amount,
    'new',
    v_deadline,
    v_user_id
  )
  returning id into v_task_id;

  -- Default the flag's responsibility to guest if it wasn't set.
  -- We don't override a manager's prior decision.
  if v_flag.chargeable_party_decision is null
     or v_flag.chargeable_party_decision = 'pending_decision' then
    update public.flags
       set chargeable_party_decision = 'guest'
     where id = p_flag_id;
  end if;

  return v_task_id;
end;
$$;

grant execute on function public.create_recovery_task_from_flag(
  uuid, text, text, text, numeric, text, int
) to authenticated;
