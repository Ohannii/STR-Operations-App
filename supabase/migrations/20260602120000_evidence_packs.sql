-- ============================================================
-- Migration 0013 — evidence_packs (Session 8 pre-merge follow-up)
-- ============================================================
-- Adds the smallest practical "repeatable turnover record"
-- container so pre-arrival evidence isn't permanently glued to
-- the apartment header. Schema-side this is a thin wrapper —
-- photos still own their own metadata, RLS, and storage paths;
-- a pack just groups them with a lifecycle (draft → submitted).
--
-- Why now (Session 8 pre-merge):
--   - The Action Centre currently shows "10 pre-arrival photos"
--     as a permanent count on the apartment header. With frequent
--     turnover that grows monotonically and loses the per-turnover
--     boundary we need for dispute lookups weeks later.
--   - The Pre-arrival Report renders "every pre-arrival photo on
--     this property forever" — also wrong for the same reason.
--
-- What this migration is NOT:
--   - It is NOT the full turnover-inspection checklist engine
--     (line items, sign-off rules, multi-section workflows). That
--     ships later. We deliberately keep the surface narrow.
--   - It does NOT enforce a specific submit workflow. The Action
--     Centre's server actions own the lifecycle; this migration
--     just holds the data + RLS.
--
-- Shape:
--   - One row per turnover pre-arrival pack.
--   - At most ONE draft pack per (property_id, pack_type) at a
--     time, enforced by a partial unique index.
--   - photos.evidence_pack_id (new column, nullable) is the join.
--     Flag photos don't carry a pack id (their flag_id is the
--     grouping). Pre-arrival photos do.
--
-- DELIBERATELY OUT OF SCOPE
--   * No DELETE policy (soft-delete via deleted_at).
--   * No status beyond 'draft' / 'submitted'. 'reviewed' / 'signed'
--     are checklist-engine concerns and ship later.
--   * No required photo count or template validation.
--   * No formal audit-events writes from triggers — the action
--     layer writes audit rows as it does everywhere else.
-- ============================================================


-- ----------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------
create table public.evidence_packs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  property_id   uuid not null references public.properties(id) on delete cascade,
  pack_type     text not null,                              -- 'pre_arrival' for v1
  status        text not null default 'draft',              -- 'draft' | 'submitted'
  title         text,
  notes         text,
  started_by    uuid not null references public.profiles(id),
  started_at    timestamptz not null default now(),
  submitted_by  uuid references public.profiles(id),
  submitted_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create trigger trg_evidence_packs_set_updated_at
  before update on public.evidence_packs
  for each row execute function public.set_updated_at();


-- ----------------------------------------------------------------
-- 2. Indexes
-- ----------------------------------------------------------------
create index idx_evidence_packs_company_id
  on public.evidence_packs(company_id);

create index idx_evidence_packs_property_id
  on public.evidence_packs(property_id);

-- Used by the Action Centre "current draft pack" lookup.
create index idx_evidence_packs_property_status
  on public.evidence_packs(property_id, status)
  where deleted_at is null;

-- At most ONE draft pack per (property_id, pack_type). This is the
-- DB-level guard behind the "Start pre-arrival pack" UX — we cannot
-- accidentally create a second draft with concurrent clicks because
-- the index will reject the dupe.
create unique index idx_evidence_packs_one_draft_per_property_type
  on public.evidence_packs (property_id, pack_type)
  where status = 'draft' and deleted_at is null;


-- ----------------------------------------------------------------
-- 3. RLS
-- ----------------------------------------------------------------
alter table public.evidence_packs enable row level security;

create policy "members read company evidence packs"
  on public.evidence_packs
  for select
  to authenticated
  using (public.is_company_member(company_id));

create policy "members insert company evidence packs"
  on public.evidence_packs
  for insert
  to authenticated
  with check (
    public.is_company_member(company_id)
    and started_by = auth.uid()
  );

create policy "members update company evidence packs"
  on public.evidence_packs
  for update
  to authenticated
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

-- No DELETE policy. Soft-delete via deleted_at.


-- ----------------------------------------------------------------
-- 4. Grants
-- ----------------------------------------------------------------
grant select, insert, update on public.evidence_packs to authenticated;


-- ----------------------------------------------------------------
-- 5. Cross-tenant integrity trigger
-- ----------------------------------------------------------------
-- Belt-and-braces guard: evidence_packs.company_id MUST match the
-- parent property's company_id. RLS already enforces "caller is a
-- member of company_id", but does NOT check the property/company
-- match. Without this trigger a buggy client could supply
-- company_id = (own company) plus property_id = (someone else's
-- property) and the INSERT would succeed.
create or replace function public.evidence_packs_check_company()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_property_company_id uuid;
begin
  select company_id into v_property_company_id
  from public.properties
  where id = NEW.property_id;

  if v_property_company_id is null then
    raise exception 'evidence_packs: parent property % not found',
      NEW.property_id;
  end if;

  if NEW.company_id is distinct from v_property_company_id then
    raise exception
      'evidence_packs: company_id (%) must match parent property company_id (%)',
      NEW.company_id, v_property_company_id;
  end if;

  return NEW;
end;
$$;

create trigger trg_evidence_packs_check_company
  before insert or update on public.evidence_packs
  for each row execute function public.evidence_packs_check_company();


-- ----------------------------------------------------------------
-- 6. photos.evidence_pack_id — the join column
-- ----------------------------------------------------------------
alter table public.photos
  add column evidence_pack_id uuid references public.evidence_packs(id) on delete set null;

create index idx_photos_evidence_pack_id
  on public.photos(evidence_pack_id)
  where evidence_pack_id is not null;

-- Extend the existing photos_check_company trigger so the pack id
-- also has to match company_id. We REPLACE the function so the
-- trigger keeps firing on all the same INSERT/UPDATE events.
create or replace function public.photos_check_company()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_flag_company_id uuid;
  v_property_company_id uuid;
  v_pack_company_id uuid;
begin
  if NEW.flag_id is not null then
    select company_id into v_flag_company_id
    from public.flags
    where id = NEW.flag_id;
    if v_flag_company_id is null then
      raise exception 'photos: parent flag % not found', NEW.flag_id;
    end if;
    if NEW.company_id is distinct from v_flag_company_id then
      raise exception
        'photos: company_id (%) must match parent flag company_id (%)',
        NEW.company_id, v_flag_company_id;
    end if;
  end if;

  if NEW.property_id is not null then
    select company_id into v_property_company_id
    from public.properties
    where id = NEW.property_id;
    if v_property_company_id is null then
      raise exception 'photos: parent property % not found', NEW.property_id;
    end if;
    if NEW.company_id is distinct from v_property_company_id then
      raise exception
        'photos: company_id (%) must match parent property company_id (%)',
        NEW.company_id, v_property_company_id;
    end if;
  end if;

  if NEW.evidence_pack_id is not null then
    select company_id into v_pack_company_id
    from public.evidence_packs
    where id = NEW.evidence_pack_id;
    if v_pack_company_id is null then
      raise exception 'photos: parent evidence pack % not found',
        NEW.evidence_pack_id;
    end if;
    if NEW.company_id is distinct from v_pack_company_id then
      raise exception
        'photos: company_id (%) must match parent evidence pack company_id (%)',
        NEW.company_id, v_pack_company_id;
    end if;
  end if;

  return NEW;
end;
$$;

-- Trigger itself is unchanged; the create or replace above swapped
-- the function it points at.


-- ----------------------------------------------------------------
-- 7. Backfill — existing pre-arrival photos
-- ----------------------------------------------------------------
-- Photos already in the DB that look like pre-arrival evidence
-- (retention_class = 'routine_pre_arrival', no flag, no pack)
-- pre-date this migration. We don't want to abandon them.
--
-- Strategy: per property, create a single "Legacy pre-arrival
-- evidence" pack in 'submitted' state and back-fill the orphan
-- photos to it. The pack inherits the earliest captured/uploaded
-- timestamp as both started_at and submitted_at so it sorts into
-- history sensibly. started_by / submitted_by fall back to the
-- earliest photo's uploader.
--
-- Idempotent guard: skip properties that already have any pack of
-- type 'pre_arrival' so re-running the migration in dev doesn't
-- create duplicates.
do $$
declare
  r record;
  v_pack_id uuid;
  v_uploader uuid;
  v_started timestamptz;
begin
  for r in
    select p.id as property_id, p.company_id
    from public.properties p
    where exists (
      select 1
      from public.photos ph
      where ph.property_id = p.id
        and ph.retention_class = 'routine_pre_arrival'
        and ph.flag_id is null
        and ph.evidence_pack_id is null
        and ph.deleted_at is null
    )
    and not exists (
      select 1
      from public.evidence_packs ep
      where ep.property_id = p.id
        and ep.pack_type = 'pre_arrival'
        and ep.deleted_at is null
    )
  loop
    -- Earliest uploader + earliest timestamp from the orphan set.
    select uploaded_by, coalesce(captured_at, uploaded_at)
      into v_uploader, v_started
    from public.photos
    where property_id = r.property_id
      and retention_class = 'routine_pre_arrival'
      and flag_id is null
      and evidence_pack_id is null
      and deleted_at is null
    order by coalesce(captured_at, uploaded_at) asc
    limit 1;

    insert into public.evidence_packs (
      company_id, property_id, pack_type, status,
      title, started_by, started_at, submitted_by, submitted_at
    ) values (
      r.company_id, r.property_id, 'pre_arrival', 'submitted',
      'Legacy pre-arrival evidence',
      v_uploader, v_started, v_uploader, v_started
    ) returning id into v_pack_id;

    update public.photos
       set evidence_pack_id = v_pack_id
     where property_id = r.property_id
       and retention_class = 'routine_pre_arrival'
       and flag_id is null
       and evidence_pack_id is null
       and deleted_at is null;
  end loop;
end$$;
