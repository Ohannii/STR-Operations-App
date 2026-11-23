-- ============================================================
-- Test activity isolation: test issues never create live Asana work
-- (rev 2, 23 Nov 2026, after lead review)
-- ============================================================
-- DO NOT APPLY without explicit approval (project rule).
--
-- Problem (23 Nov 2026): the staff-wide live Asana switch sends every issue
-- of the company to Incidents & Damages, including issues raised on the
-- Test 1 / Test 2 apartments and test runs on real apartments (Unit 13).
-- Staff then triage that test work as if it were real.
--
-- Design: an issue's test/live classification is DATA, decided by the
-- database when the issue is created, never by the client:
--
--   1. properties.is_test  — a test apartment. Every issue raised on it is
--      a test issue, for everyone. Changed only through
--      set_property_test_status() by an operations manager; audited.
--   2. test_sessions        — "test mode" for ONE manager on ONE apartment
--      for a limited time (max 4 hours). Only issues THAT manager raises on
--      THAT apartment are test issues; their issues elsewhere stay live.
--      Started/ended only through start_test_session()/end_test_session();
--      audited. Inspectors never see a step.
--   3. flags.is_test / flags.test_reason — stamped by a BEFORE INSERT
--      trigger from (1) and (2), overriding anything a client sends, and
--      immutable afterwards.
--   4. Backstop: a live-destination Asana job can never exist for a test
--      issue (insert, or update of any column that could re-point a job).
--   5. No silent Asana loss: flags.asana_handoff_expected is stamped TRUE at
--      creation when the company has Asana switched on. A flag that is
--      expected but has no Asana job is found by
--      asana_flags_awaiting_handoff() and the worker enqueues it through
--      enqueue_asana_handoff() (destination decided from the stored
--      classification). Idempotent: the existing unique indexes and the
--      one-destination trigger refuse a second job.
--   6. Early warning: asana_handoff_health() gives operations managers a
--      count of real issues that did not reach Asana (missing / stopped /
--      stuck) and when the reconciliation worker last ran successfully.
--
-- Nothing is hard-coded per company or apartment. Existing issues, jobs,
-- audit rows and live Asana tasks are NOT touched: new columns default to
-- false and nothing is backfilled or deleted.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------
alter table public.properties
  add column if not exists is_test boolean not null default false;

alter table public.flags
  add column if not exists is_test boolean not null default false,
  add column if not exists test_reason text
    check (test_reason is null or test_reason in ('test_property', 'test_session')),
  add column if not exists asana_handoff_expected boolean not null default false;

alter table public.flags
  add constraint flags_test_reason_consistent
  check ((is_test and test_reason is not null) or (not is_test and test_reason is null));

-- Reconciliation lookup: only flags still expected to reach Asana.
create index if not exists ix_flags_asana_handoff_expected
  on public.flags (created_at) where asana_handoff_expected and deleted_at is null;

-- properties.is_test changes ONLY through set_property_test_status():
--   * UPDATE grants on properties are column-scoped (migration
--     20261120120935) and is_test is deliberately not added to them;
--   * a new property is forced to is_test = false (no unaudited
--     "born as test" apartments; on the shared database the INSERT grant
--     is also column-scoped since 20261122174325).
create or replace function public.properties_force_not_test_on_insert()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.is_test := false;
  return new;
end;
$$;
revoke all on function public.properties_force_not_test_on_insert() from public, anon, authenticated, service_role;
drop trigger if exists trg_properties_force_not_test_on_insert on public.properties;
create trigger trg_properties_force_not_test_on_insert
  before insert on public.properties
  for each row execute function public.properties_force_not_test_on_insert();

-- ------------------------------------------------------------
-- 2. Test sessions (one manager, one apartment, time-limited)
-- ------------------------------------------------------------
create table public.test_sessions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  started_at  timestamptz not null default now(),
  ends_at     timestamptz not null,
  ended_at    timestamptz,
  reason      text not null check (length(btrim(reason)) between 3 and 200),
  check (ends_at > started_at and ends_at <= started_at + interval '4 hours')
);
-- At most one open session per person per company (one apartment at a time).
create unique index uq_test_sessions_open
  on public.test_sessions (company_id, user_id) where ended_at is null;
create index ix_test_sessions_lookup on public.test_sessions (company_id, user_id, property_id, ends_at);

alter table public.test_sessions enable row level security;
revoke all on public.test_sessions from public, anon, authenticated, service_role;
grant select on public.test_sessions to authenticated, service_role;
create policy "members read company test sessions" on public.test_sessions
  for select to authenticated using (public.is_company_member(company_id));

-- Is this person testing THIS apartment in this company right now? The
-- person must STILL hold an operations-manager role there: removing or
-- demoting a manager ends the effect of their session immediately.
-- Not callable by clients (used only inside the flags trigger).
create or replace function public.in_test_session(p_company_id uuid, p_user_id uuid, p_property_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and p_property_id is not null and exists (
    select 1 from public.test_sessions s
     where s.company_id = p_company_id and s.user_id = p_user_id and s.property_id = p_property_id
       and s.ended_at is null and s.started_at <= now() and s.ends_at > now()
  ) and exists (
    select 1 from public.company_memberships m
     where m.company_id = p_company_id and m.user_id = p_user_id
       and m.role_key in ('company_admin', 'gm', 'ops_manager')
       and m.is_active and m.deleted_at is null
  )
$$;
revoke all on function public.in_test_session(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Stamp flags at creation; keep the stamps immutable
-- ------------------------------------------------------------
create or replace function public.flags_stamp_test_classification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_property_test boolean;
begin
  if tg_op = 'INSERT' then
    select p.is_test into v_property_test
      from public.properties p where p.id = new.property_id;
    if coalesce(v_property_test, false) then
      new.is_test := true;  new.test_reason := 'test_property';
    elsif public.in_test_session(new.company_id, auth.uid(), new.property_id) then
      new.is_test := true;  new.test_reason := 'test_session';
    else
      new.is_test := false; new.test_reason := null;   -- client values ignored
    end if;
    -- Should this issue reach Asana? Decided once, from the company's
    -- setting at creation (client values ignored).
    new.asana_handoff_expected := exists (
      select 1 from public.integration_settings s
       where s.company_id = new.company_id and s.provider = 'asana'
         and s.is_enabled and s.deleted_at is null
    );
    return new;
  end if;
  -- UPDATE: these are historical facts.
  if new.is_test is distinct from old.is_test
     or new.test_reason is distinct from old.test_reason
     or new.asana_handoff_expected is distinct from old.asana_handoff_expected then
    raise exception 'flag test classification is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.flags_stamp_test_classification() from public, anon, authenticated, service_role;

drop trigger if exists trg_flags_stamp_test_classification on public.flags;
create trigger trg_flags_stamp_test_classification
  before insert or update of is_test, test_reason, asana_handoff_expected on public.flags
  for each row execute function public.flags_stamp_test_classification();

-- ------------------------------------------------------------
-- 4. Backstop: no live Asana job for a test issue
-- ------------------------------------------------------------
-- The rule depends ONLY on the job's event type, its deletion state and the
-- flag it points at. provider / entity_type are deliberately NOT part of the
-- condition, so changing them can never take a job out of the rule; they
-- are still listed in UPDATE OF so every re-pointing change is re-checked.
create or replace function public.outbox_refuse_live_for_test_flags()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is null
     and lower(new.event_type) like 'asana.live.%'
     and exists (select 1 from public.flags f where f.id = new.entity_id and f.is_test) then
    raise exception 'test issue cannot be sent to the live Asana project' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.outbox_refuse_live_for_test_flags() from public, anon, authenticated, service_role;

drop trigger if exists trg_outbox_refuse_live_for_test_flags on public.integration_outbox;
create trigger trg_outbox_refuse_live_for_test_flags
  before insert or update of provider, entity_type, event_type, entity_id, deleted_at, company_id
  on public.integration_outbox
  for each row execute function public.outbox_refuse_live_for_test_flags();

-- ------------------------------------------------------------
-- 5. Reconciliation: issues expected in Asana that have no Asana job
-- ------------------------------------------------------------
-- Worker only (service role). Returns, oldest first, flags that:
--   * were expected to reach Asana at creation (asana_handoff_expected);
--   * are not deleted, are at least p_min_age_seconds old (so the app's own
--     enqueue is never raced) and at most 14 days old (bounded; older ones
--     show "needs attention" in the app instead of "sending");
--   * belong to a company that still has Asana switched on;
--   * have NO Asana job at all (any event type, including soft-deleted
--     ones: a deliberately removed job is never recreated);
--   * have NO Asana task already: no saved task link on the flag and no
--     task-link record (active or not), so an issue that reached Asana by
--     any route is never sent again.
-- Issues that existed before this migration can NEVER be returned: their
-- asana_handoff_expected is false (column default, no backfill) and the
-- marker cannot be changed afterwards.
-- The caller decides the destination from is_test with the same rule the
-- app uses; the existing unique indexes make a repeat a no-op.
create or replace function public.asana_flags_awaiting_handoff(p_limit integer default 10, p_min_age_seconds integer default 120)
returns table (flag_id uuid, company_id uuid, property_id uuid, raised_by uuid, is_test boolean,
               category_key text, is_pack_photo_issue boolean, has_photos boolean)
language sql stable security definer set search_path = '' as $$
  select f.id, f.company_id, f.property_id, f.raised_by, f.is_test, c.key,
         exists (select 1 from public.flag_issue_selections s where s.flag_id = f.id),
         exists (select 1 from public.photos p where p.flag_id = f.id and p.deleted_at is null)
    from public.flags f
    join public.flag_categories c on c.id = f.flag_category_id
   where f.asana_handoff_expected
     and f.deleted_at is null
     and f.created_at <= now() - make_interval(secs => greatest(coalesce(p_min_age_seconds, 120), 0))
     and f.created_at > now() - interval '14 days'
     and exists (select 1 from public.integration_settings st
                  where st.company_id = f.company_id and st.provider = 'asana'
                    and st.is_enabled and st.deleted_at is null)
     and f.asana_task_url is null
     and not exists (select 1 from public.integration_outbox o
                      where o.company_id = f.company_id and o.entity_type = 'flag'
                        and o.entity_id = f.id and o.provider = 'asana')
     and not exists (select 1 from public.external_task_links l
                      where l.company_id = f.company_id and l.provider = 'asana'
                        and l.internal_entity_type = 'flag' and l.internal_entity_id = f.id)
   order by f.created_at
   limit least(greatest(coalesce(p_limit, 10), 1), 50)
$$;
revoke all on function public.asana_flags_awaiting_handoff(integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.asana_flags_awaiting_handoff(integer, integer) to service_role;

-- Worker only (service role). Enqueue the Asana job(s) for ONE flag found
-- by asana_flags_awaiting_handoff(). Keeps the worker's table grants narrow
-- (no INSERT on integration_outbox for service_role): the rows are built by
-- the app's own builders and VALIDATED here before insert:
--   * 1 or 2 jobs (create, optionally attach), for exactly this flag and its
--     company, provider 'asana', entity_type 'flag', one known event type
--     each, all pinned to ONE destination;
--   * the flag must still be expected, not deleted, with Asana switched on,
--     and still have no Asana job at all;
--   * created_by is always the flag's reporter (never taken from input);
--   * a live destination for a test flag is refused (23514; the outbox
--     trigger enforces the same).
-- Returns 'enqueued', 'already_has_job' (a job, task link or task-link
-- record already exists: a no-op), or 'not_expected'. A unique violation from a concurrent writer is
-- reported as 'already_has_job', never as a second task.
create or replace function public.enqueue_asana_handoff(p_flag_id uuid, p_jobs jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  f record; j jsonb; v_kinds text[] := '{}'; v_live int := 0; v_beta int := 0; v_ev text;
begin
  if p_flag_id is null or jsonb_typeof(p_jobs) <> 'array'
     or jsonb_array_length(p_jobs) not between 1 and 2 then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select id, company_id, raised_by, is_test, asana_handoff_expected, deleted_at, asana_task_url
    into f from public.flags where id = p_flag_id for share;
  if not found or not f.asana_handoff_expected or f.deleted_at is not null
     or not exists (select 1 from public.integration_settings st
                     where st.company_id = f.company_id and st.provider = 'asana'
                       and st.is_enabled and st.deleted_at is null) then
    return 'not_expected';
  end if;
  -- Input validation. Note: the entity_id / company_id checks below are
  -- defence in depth only — the INSERT further down never reads them from
  -- the input (it always writes this function's own flag id and the flag's
  -- company), so a wrong value there can never reach the outbox.
  for j in select * from jsonb_array_elements(p_jobs) loop
    v_ev := j->>'event_type';
    if j->>'provider' is distinct from 'asana' or j->>'entity_type' is distinct from 'flag'
       or j->>'entity_id' is distinct from p_flag_id::text
       or j->>'company_id' is distinct from f.company_id::text
       or jsonb_typeof(j->'payload') is distinct from 'object'
       or j->'payload'->>'flag_id' is distinct from p_flag_id::text
       or v_ev not in ('asana.create_task_for_flag', 'asana.attach_flag_evidence',
                       'asana.live.create_task_for_flag', 'asana.live.attach_flag_evidence') then
      raise exception 'invalid job' using errcode = '22023';
    end if;
    if v_ev like 'asana.live.%' then v_live := v_live + 1; else v_beta := v_beta + 1; end if;
    v_kinds := v_kinds || (case when v_ev like '%create_task_for_flag' then 'create' else 'attach' end);
  end loop;
  if (v_live > 0 and v_beta > 0) or not ('create' = any (v_kinds))
     or (select count(distinct k) from unnest(v_kinds) k) <> array_length(v_kinds, 1) then
    raise exception 'invalid job set' using errcode = '22023';
  end if;
  if v_live > 0 and f.is_test then
    raise exception 'test issue cannot be sent to the live Asana project' using errcode = '23514';
  end if;
  -- Already reached (or on its way to) Asana by any route: never again.
  if f.asana_task_url is not null
     or exists (select 1 from public.external_task_links l
                 where l.company_id = f.company_id and l.provider = 'asana'
                   and l.internal_entity_type = 'flag' and l.internal_entity_id = f.id)
     or exists (select 1 from public.integration_outbox o
                 where o.company_id = f.company_id and o.entity_type = 'flag'
                   and o.entity_id = f.id and o.provider = 'asana') then
    return 'already_has_job';
  end if;
  begin
    -- create job first, so an attach job never exists without it
    for j in select * from jsonb_array_elements(p_jobs) order by (value->>'event_type') like '%create_task_for_flag' desc loop
      insert into public.integration_outbox(company_id, provider, event_type, entity_type, entity_id, payload, created_by)
        values (f.company_id, 'asana', j->>'event_type', 'flag', f.id, j->'payload', f.raised_by);
    end loop;
  exception when unique_violation then
    return 'already_has_job';
  end;
  return 'enqueued';
end;
$$;
revoke all on function public.enqueue_asana_handoff(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_asana_handoff(uuid, jsonb) to service_role;

-- ------------------------------------------------------------
-- 5b. Asana handoff health (manager-visible early warning)
-- ------------------------------------------------------------
-- Worker heartbeat: when the reconciliation pass last ran, and last ran
-- successfully. Global, timestamps only (no tenant data). Written only by
-- the worker through record_worker_heartbeat(); not readable by clients
-- directly (managers see it through asana_handoff_health()).
create table public.integration_worker_heartbeats (
  worker      text primary key check (worker in ('asana_reconcile')),
  last_run_at timestamptz not null,
  last_ok_at  timestamptz,
  last_ok     boolean not null
);
alter table public.integration_worker_heartbeats enable row level security;
revoke all on public.integration_worker_heartbeats from public, anon, authenticated, service_role;

create or replace function public.record_worker_heartbeat(p_worker text, p_ok boolean)
returns void language sql security definer set search_path = '' as $$
  insert into public.integration_worker_heartbeats as h (worker, last_run_at, last_ok_at, last_ok)
  values (p_worker, now(), case when p_ok then now() end, coalesce(p_ok, false))
  on conflict (worker) do update
    set last_run_at = excluded.last_run_at,
        last_ok_at  = coalesce(excluded.last_ok_at, h.last_ok_at),
        last_ok     = excluded.last_ok
$$;
revoke all on function public.record_worker_heartbeat(text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.record_worker_heartbeat(text, boolean) to service_role;

-- For ONE company, operations managers only. Counts real (non-test, not
-- deleted) issues that were expected in Asana and are not there:
--   missing  no Asana job at all for more than 10 minutes (5 worker runs —
--            ordinary 2-minute latency is never reported). Includes issues
--            older than 14 days that are no longer retried automatically
--            ("missing_beyond_retry");
--   stopped  the create job ended without a task (dead / manual review /
--            done without a link) — never retried by reconciliation;
--   stuck    the create job has been waiting or running for over 30 minutes.
-- Plus the worker heartbeat, so "nothing wrong" (recent successful check)
-- is distinguishable from "the checker is not running". Up to 10 example
-- issues: id, apartment, time and problem only — no descriptions, no
-- reporter, no guest data. Issues with a soft-deleted job only were removed
-- on purpose and are not reported.
create or replace function public.asana_handoff_health(p_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_enabled boolean; hb record;
begin
  if auth.uid() is null or not public.has_company_role(p_company_id,
      array['company_admin', 'gm', 'ops_manager']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_enabled := exists (select 1 from public.integration_settings st
                        where st.company_id = p_company_id and st.provider = 'asana'
                          and st.is_enabled and st.deleted_at is null);
  select last_run_at, last_ok_at, last_ok into hb
    from public.integration_worker_heartbeats where worker = 'asana_reconcile';
  with base as (
    select f.id, f.property_id, f.created_at
      from public.flags f
     where f.company_id = p_company_id and f.asana_handoff_expected
       and not f.is_test and f.deleted_at is null and f.asana_task_url is null
       and not exists (select 1 from public.external_task_links l
                        where l.company_id = f.company_id and l.provider = 'asana'
                          and l.internal_entity_type = 'flag' and l.internal_entity_id = f.id
                          and l.deleted_at is null)
  ), classified as (
    select b.id, b.property_id, b.created_at,
           case
             when not exists (select 1 from public.integration_outbox o
                               where o.company_id = p_company_id and o.provider = 'asana'
                                 and o.entity_type = 'flag' and o.entity_id = b.id)
               then case when b.created_at < now() - interval '10 minutes' then 'missing' end
             else (select case
                            when o.status in ('pending', 'processing')
                              then case when o.created_at < now() - interval '30 minutes' then 'stuck' end
                            else 'stopped'
                          end
                     from public.integration_outbox o
                    where o.company_id = p_company_id and o.provider = 'asana'
                      and o.entity_type = 'flag' and o.entity_id = b.id and o.deleted_at is null
                      and o.event_type in ('asana.create_task_for_flag', 'asana.live.create_task_for_flag')
                    order by o.created_at desc limit 1)
           end as problem
      from base b
  ), problems as (
    select * from classified where problem is not null
  )
  select jsonb_build_object(
    'asana_enabled', v_enabled,
    'missing', count(*) filter (where problem = 'missing'),
    'missing_beyond_retry', count(*) filter (where problem = 'missing' and created_at <= now() - interval '14 days'),
    'stopped', count(*) filter (where problem = 'stopped'),
    'stuck', count(*) filter (where problem = 'stuck'),
    'oldest_problem_at', min(created_at),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('flag_id', x.id, 'property_id', x.property_id,
               'property_name', pr.name, 'raised_at', x.created_at, 'problem', x.problem) order by x.created_at)
        from (select * from problems order by created_at limit 10) x
        join public.properties pr on pr.id = x.property_id), '[]'::jsonb),
    'last_check_at', hb.last_run_at,
    'last_check_ok_at', hb.last_ok_at,
    'last_check_ok', hb.last_ok,
    'checked_at', now()
  ) into v from problems;
  return v;
end;
$$;
revoke all on function public.asana_handoff_health(uuid) from public, anon, authenticated, service_role;
grant execute on function public.asana_handoff_health(uuid) to authenticated;

-- ------------------------------------------------------------
-- 6. Audited management functions (operations managers only)
-- ------------------------------------------------------------
create or replace function public.set_property_test_status(
  p_company_id uuid, p_property_id uuid, p_is_test boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old boolean;
begin
  if auth.uid() is null or not public.has_company_role(p_company_id,
      array['company_admin', 'gm', 'ops_manager']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_is_test is null or p_reason is null or length(btrim(p_reason)) not between 3 and 200 then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select is_test into v_old from public.properties
   where id = p_property_id and company_id = p_company_id and deleted_at is null
   for no key update;
  if not found then raise exception 'property unavailable' using errcode = '42501'; end if;
  if v_old = p_is_test then return; end if;
  update public.properties set is_test = p_is_test where id = p_property_id;
  insert into public.audit_events(company_id, actor_id, event_kind, entity_type, entity_id, before, after, metadata)
    values (p_company_id, auth.uid(), 'property_test_status_changed', 'property', p_property_id,
      jsonb_build_object('is_test', v_old), jsonb_build_object('is_test', p_is_test),
      jsonb_build_object('reason', btrim(p_reason)));
end;
$$;

-- Start test mode on ONE apartment. A repeat for the same apartment returns
-- the running session (double tap / retry). A different apartment while one
-- is running is refused (55000): end the current one first.
create or replace function public.start_test_session(
  p_company_id uuid, p_property_id uuid, p_minutes integer, p_reason text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_ends timestamptz; v_id uuid; v_property uuid;
begin
  if auth.uid() is null or not public.has_company_role(p_company_id,
      array['company_admin', 'gm', 'ops_manager']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_property_id is null or p_minutes is null or p_minutes not between 5 and 240
     or p_reason is null or length(btrim(p_reason)) not between 3 and 200 then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  perform 1 from public.properties
   where id = p_property_id and company_id = p_company_id and deleted_at is null;
  if not found then raise exception 'property unavailable' using errcode = '42501'; end if;
  -- Close any expired-but-open session first, then reuse an active one.
  update public.test_sessions set ended_at = ends_at
   where company_id = p_company_id and user_id = auth.uid() and ended_at is null and ends_at <= now();
  select ends_at, property_id into v_ends, v_property from public.test_sessions
   where company_id = p_company_id and user_id = auth.uid() and ended_at is null;
  if found then
    if v_property <> p_property_id then
      raise exception 'test mode is already on for another apartment' using errcode = '55000';
    end if;
    return v_ends;
  end if;
  insert into public.test_sessions(company_id, user_id, property_id, ends_at, reason)
    values (p_company_id, auth.uid(), p_property_id, now() + make_interval(mins => p_minutes), btrim(p_reason))
    returning id, ends_at into v_id, v_ends;
  insert into public.audit_events(company_id, actor_id, event_kind, entity_type, entity_id, metadata)
    values (p_company_id, auth.uid(), 'test_session_started', 'test_session', v_id,
      jsonb_build_object('property_id', p_property_id, 'ends_at', v_ends, 'reason', btrim(p_reason)));
  return v_ends;
end;
$$;

create or replace function public.end_test_session(p_company_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_property uuid;
begin
  if auth.uid() is null or not public.is_company_member(p_company_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.test_sessions set ended_at = least(now(), ends_at)
   where company_id = p_company_id and user_id = auth.uid() and ended_at is null
   returning id, property_id into v_id, v_property;
  if v_id is not null then
    insert into public.audit_events(company_id, actor_id, event_kind, entity_type, entity_id, metadata)
      values (p_company_id, auth.uid(), 'test_session_ended', 'test_session', v_id,
        jsonb_build_object('property_id', v_property));
  end if;
end;
$$;

revoke all on function public.set_property_test_status(uuid, uuid, boolean, text),
  public.start_test_session(uuid, uuid, integer, text), public.end_test_session(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_property_test_status(uuid, uuid, boolean, text),
  public.start_test_session(uuid, uuid, integer, text), public.end_test_session(uuid)
  to authenticated;

-- Clients cannot forge these audit events.
create policy "test isolation audit is RPC only" on public.audit_events as restrictive
  for insert to authenticated
  with check (event_kind not in ('property_test_status_changed', 'test_session_started', 'test_session_ended'));
