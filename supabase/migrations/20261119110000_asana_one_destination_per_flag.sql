-- ============================================================
-- Asana outbox: ONE destination per flag, enforced by the database
-- ============================================================
-- DO NOT APPLY without explicit approval (project rule).
--
-- Controlled live test (Nov 2026). A flag's Asana jobs are pinned to a
-- destination by their event type:
--   BETA : asana.create_task_for_flag      / asana.attach_flag_evidence
--   live : asana.live.create_task_for_flag / asana.live.attach_flag_evidence
--
-- The existing unique index (uq_integration_outbox_event_entity_active) is
-- per event type, so on its own it would allow a flag to hold a BETA create
-- job AND a live create job — two jobs, two tasks. An application pre-read
-- cannot close that (replays after the switch changes, concurrent requests,
-- and the older production code, which knows nothing about destinations).
--
-- This migration closes it at the write boundary, for EVERY writer:
--
--   1. Two partial unique indexes: at most ONE active create-task job and at
--      most ONE active attach-evidence job per company + flag, whichever
--      destination.
--
--   2. A trigger that ties the two job KINDS together: every active Asana
--      job of a flag must have the SAME destination. One index per kind
--      cannot express that — e.g. a live create job followed by an older
--      caller's BETA attach insert (no attach job exists yet, so the attach
--      index allows it) would leave "live create + BETA attach": the
--      attachment in the wrong worker's queue. The trigger refuses it.
--
-- A refused write — from any code, old or new, either destination, insert
-- or update — fails with a unique violation (23505), which every existing
-- enqueue path already treats as "a job already exists" (no error to the
-- user).
--
-- ATOMIC UNDER CONCURRENCY: the trigger takes a transaction-scoped advisory
-- lock keyed on company + flag before it looks, so two transactions writing
-- jobs for the SAME flag are serialised (the second one waits, then sees
-- the first one's committed row and is refused if it disagrees). Writes for
-- different flags never wait on each other.
--
-- Additive only: no data change, no column change, no existing index,
-- policy or grant is altered. Soft-deleted rows are excluded, exactly as in
-- the existing index. Other event types, providers and entity types are
-- not touched by the trigger.
--
-- Pre-check (read-only, 19 Nov 2026): 198 outbox rows, no flag with more
-- than one active create job or more than one active attach job, and no
-- live-destination rows — so both indexes build without conflict and every
-- existing flag is already single-destination (BETA).
-- ============================================================

create unique index if not exists uq_integration_outbox_one_create_per_flag
  on public.integration_outbox (company_id, provider, entity_type, entity_id)
  where deleted_at is null
    and event_type in ('asana.create_task_for_flag', 'asana.live.create_task_for_flag');

create unique index if not exists uq_integration_outbox_one_attach_per_flag
  on public.integration_outbox (company_id, provider, entity_type, entity_id)
  where deleted_at is null
    and event_type in ('asana.attach_flag_evidence', 'asana.live.attach_flag_evidence');

-- ------------------------------------------------------------
-- One destination across BOTH job kinds
-- ------------------------------------------------------------

-- The destination an Asana flag job is pinned to, from its event type.
-- NULL = not one of the four destination-pinned job types.
create or replace function public.asana_outbox_destination(p_event_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_event_type
    when 'asana.create_task_for_flag'      then 'beta'
    when 'asana.attach_flag_evidence'      then 'beta'
    when 'asana.live.create_task_for_flag' then 'live_incidents'
    when 'asana.live.attach_flag_evidence' then 'live_incidents'
  end
$$;

-- BEFORE INSERT OR UPDATE: an ACTIVE Asana flag job may not be written if
-- the same company + flag already has an active job pinned to the OTHER
-- destination (create or attach). SECURITY DEFINER so the check sees every
-- job of the flag regardless of the writer's row-level-security view; it
-- reads only company_id / entity_id / event_type and returns no data.
create or replace function public.enforce_asana_outbox_single_destination()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dest text;
begin
  if new.deleted_at is not null
     or new.provider <> 'asana'
     or new.entity_type <> 'flag' then
    return new;
  end if;
  v_dest := public.asana_outbox_destination(new.event_type);
  if v_dest is null then
    return new;
  end if;

  -- Serialise writers of THIS flag's jobs for the rest of the transaction.
  perform pg_advisory_xact_lock(
    hashtextextended('asana_outbox_destination:' || new.company_id::text || ':' || new.entity_id::text, 0)
  );

  if exists (
    select 1
      from public.integration_outbox o
     where o.company_id = new.company_id
       and o.provider = 'asana'
       and o.entity_type = 'flag'
       and o.entity_id = new.entity_id
       and o.deleted_at is null
       and o.id is distinct from new.id
       and public.asana_outbox_destination(o.event_type) is not null
       and public.asana_outbox_destination(o.event_type) <> v_dest
  ) then
    raise exception 'flag % already has an Asana job pinned to another destination', new.entity_id
      using errcode = '23505';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_asana_outbox_single_destination() from public, anon, authenticated;
revoke all on function public.asana_outbox_destination(text) from public, anon;
grant execute on function public.asana_outbox_destination(text) to authenticated, service_role;

drop trigger if exists trg_integration_outbox_single_destination on public.integration_outbox;
create trigger trg_integration_outbox_single_destination
  before insert or update of event_type, deleted_at, company_id, entity_id, provider, entity_type
  on public.integration_outbox
  for each row execute function public.enforce_asana_outbox_single_destination();
