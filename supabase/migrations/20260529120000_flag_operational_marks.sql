-- ============================================================
-- Migration 0011 — flag_operational_marks (Session 6: chips)
-- ============================================================
-- Adds the lightweight operational-state layer ("chips") that
-- sits on every flag. Each row represents one toggle of one
-- mark kind (Asana logged, Guest notified, Maintenance assigned,
-- etc.). The full vocabulary + semantics live in
-- docs/CHIP_VOCABULARY.md.
--
-- Chips are deliberately separate from:
--   * flags.status              (the lifecycle state machine)
--   * flags.chargeable_party_decision  (responsibility)
--   * guest_recovery_tasks      (rare formal escalation only)
--
-- Pattern is append-only history: toggling a chip "off" sets
-- cleared_at = now(); the row stays for audit. A new toggle "on"
-- inserts a fresh row. The partial unique index below enforces
-- "at most one active mark per (flag, kind)".
--
-- DELIBERATELY OUT OF SCOPE
--   * No DELETE policy / grant (append-only).
--   * No role narrowing beyond "is company member".
--   * No automatic predecessor-clearing at the DB level —
--     application code in toggle action does that
--     (e.g., setting `maintenance_done` clears `maintenance_pending`
--      and `maintenance_assigned`).
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------
create table public.flag_operational_marks (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  flag_id      uuid not null references public.flags(id) on delete cascade,
  kind         text not null,
  marked_at    timestamptz not null default now(),
  marked_by    uuid not null references public.profiles(id),
  notes        text,
  metadata     jsonb,
  cleared_at   timestamptz,
  cleared_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger trg_flag_operational_marks_set_updated_at
  before update on public.flag_operational_marks
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------
-- 2. Indexes
-- ----------------------------------------------------------------
-- Lookup by company (tenant scope), by flag (most common read).
create index idx_flag_operational_marks_company_id
  on public.flag_operational_marks(company_id);

create index idx_flag_operational_marks_flag_id
  on public.flag_operational_marks(flag_id);

-- Critical: partial unique index for "at most one active mark per
-- (flag, kind)". A regular UNIQUE (flag_id, kind, cleared_at) would
-- NOT work because PostgreSQL treats NULL as distinct in unique
-- constraints -- two rows with cleared_at IS NULL would both be
-- allowed. The partial-index pattern says exactly what we mean:
-- the constraint only applies to active (uncleared) rows.
-- Historical / cleared rows are unconstrained and accumulate.
create unique index flag_operational_marks_one_active_per_kind
  on public.flag_operational_marks (flag_id, kind)
  where cleared_at is null;


-- ----------------------------------------------------------------
-- 3. RLS
-- ----------------------------------------------------------------
alter table public.flag_operational_marks enable row level security;

-- SELECT: members can read marks scoped to their company.
create policy "members read company operational marks"
  on public.flag_operational_marks
  for select
  to authenticated
  using (public.is_company_member(company_id));

-- INSERT: members can write marks scoped to their company. The
-- standard `marked_by = auth.uid()` anti-forgery guard.
create policy "members insert company operational marks"
  on public.flag_operational_marks
  for insert
  to authenticated
  with check (
    public.is_company_member(company_id)
    and marked_by = auth.uid()
  );

-- UPDATE: members can update marks (used to set cleared_at when
-- toggling a chip off). Company scope only; no cross-tenant writes.
create policy "members update company operational marks"
  on public.flag_operational_marks
  for update
  to authenticated
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

-- NOTE: No DELETE policy. We never hard-delete operational marks;
-- the cleared_at column carries the "off" state and preserves the
-- audit history.


-- ----------------------------------------------------------------
-- 4. Grants
-- ----------------------------------------------------------------
grant select, insert, update on public.flag_operational_marks to authenticated;


-- ----------------------------------------------------------------
-- 5. Cross-tenant integrity trigger
-- ----------------------------------------------------------------
-- Belt-and-braces guard: flag_operational_marks.company_id MUST match
-- the parent flag's company_id. The RLS INSERT policy already requires
-- the caller to be a member of company_id, but it does NOT verify that
-- flag_id belongs to the same company. Without this trigger, a buggy
-- client could supply company_id = (user's own company) plus flag_id
-- pointing at a flag in a different company, and the INSERT would
-- succeed.
--
-- The trigger runs on every INSERT and UPDATE regardless of role,
-- so even service_role cannot bypass it without disabling the trigger
-- itself.
create or replace function public.flag_operational_marks_check_company()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_flag_company_id uuid;
begin
  select company_id into v_flag_company_id
  from public.flags
  where id = NEW.flag_id;

  if v_flag_company_id is null then
    raise exception 'flag_operational_marks: parent flag % not found',
      NEW.flag_id;
  end if;

  if NEW.company_id is distinct from v_flag_company_id then
    raise exception
      'flag_operational_marks: company_id (%) must match parent flag company_id (%)',
      NEW.company_id, v_flag_company_id;
  end if;

  return NEW;
end;
$$;

create trigger trg_flag_operational_marks_check_company
  before insert or update on public.flag_operational_marks
  for each row execute function public.flag_operational_marks_check_company();


-- ----------------------------------------------------------------
-- 6. Note on the `kind` column — deliberate app-level vocabulary
-- ----------------------------------------------------------------
-- The `kind` column has NO database-level CHECK constraint. This is
-- by design:
--
--   * The vocabulary lives in docs/CHIP_VOCABULARY.md and is mirrored
--     in src/lib/ui/chip-vocabulary.ts. Both are committed to git so
--     they evolve together with the rest of the app.
--
--   * Adding a new chip kind requires only updating the doc + the UI
--     code -- NO database migration. This lets the vocabulary evolve
--     additively without schema churn.
--
--   * Unknown `kind` values inserted by code that's out of sync with
--     the vocabulary are NOT catastrophic: the UI's getChipDisplay()
--     returns undefined for unknown kinds and the chip simply doesn't
--     render. RLS still enforces company scope on inserts, so a stray
--     kind is bounded to the inserter's company. Blast radius is "a
--     row sits in the DB invisible in the UI" -- not a security issue.
--
-- If the vocabulary stabilises and we want stricter validation, the
-- migration that adds it should look like:
--
--   alter table public.flag_operational_marks
--     add constraint flag_operational_marks_kind_check
--     check (kind in (
--       'asana_pending', 'asana_logged',
--       'guest_notify_pending', 'guest_notified',
--       'owner_notify_pending', 'owner_notified',
--       'maintenance_pending', 'maintenance_assigned', 'maintenance_done',
--       'replacement_needed', 'replaced',
--       'awaiting_owner_approval', 'owner_approved',
--       'needs_reclean'
--     ));
--
-- That migration must also include data backfill / cleanup for any
-- non-conforming rows that exist by the time it ships.
