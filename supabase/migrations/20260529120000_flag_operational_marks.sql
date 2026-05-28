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
