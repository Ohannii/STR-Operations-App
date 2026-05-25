-- ============================================================
-- Migration 0002 — Core schema (v1.0–v1.3 consolidated)
-- ============================================================
-- This migration creates the full STR Ops schema, faithful to
-- docs/DATABASE_SCHEMA_PLAN.md. Every business table carries
-- company_id for multi-tenant isolation via RLS (RLS itself is
-- enabled in migration 0005, with NO policies yet — deny-by-
-- default until the next session writes the policy set).
--
-- Conventions (per the schema plan):
--   - uuid PKs default gen_random_uuid()
--   - timestamps created_at / updated_at / deleted_at on every
--     business table; soft-delete via deleted_at IS NULL
--   - money columns decimal(12,2) for ZAR
--   - text fields use enum-style comments rather than CHECK
--     constraints, to keep the schema easy to extend
--   - shared trigger set_updated_at() keeps updated_at fresh
--   - audit_events and approval_decisions are append-only
--     (no updated_at, no deleted_at; enforced by RLS later)
--
-- Order of creation matches FK dependencies. Do not reorder
-- without checking references.
-- ============================================================

-- ----------------------------------------------------------------
-- Shared trigger function for updated_at maintenance
-- ----------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- ================================================================
-- TENANCY AND IDENTITY
-- ================================================================

-- roles: system-wide seed; one row per role key. Seeded in 0004.
create table public.roles (
  key           text primary key,
  display_label text not null,
  description   text
);


-- companies: the tenancy root. Every business row carries company_id.
create table public.companies (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  slug                 text unique,
  plan_tier            text not null default 'free',
  seed_policy_applied  boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create trigger trg_companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();


-- profiles: app user record. Mirrors auth.users 1:1 by id.
-- An auth user signing up triggers a profile row (handled by app
-- code or an auth hook; not in this migration).
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  email       text,
  phone       text,
  locale      text not null default 'en',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create trigger trg_profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();


-- company_memberships: which user has which role inside which company.
create table public.company_memberships (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role_key    text not null references public.roles(key),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (company_id, user_id)
);
create trigger trg_company_memberships_set_updated_at
  before update on public.company_memberships
  for each row execute function public.set_updated_at();


-- invitations: pending invitations for new users.
create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  email       text not null,
  role_key    text not null references public.roles(key),
  invited_by  uuid not null references public.profiles(id),
  token       text unique not null,
  accepted_at timestamptz,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);


-- ================================================================
-- PROPERTIES
-- ================================================================

-- properties: each apartment / unit managed by a company.
-- status values: 'idle' | 'guest_in' | 'between_stays' |
--   'pre_arrival_pending' | 'post_stay_pending' | 'needs_attention' |
--   'critical' | 'ready_for_arrival' | 'not_ready'
create table public.properties (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  name              text not null,
  address           text,
  unit_reference    text,
  bedrooms          int,
  notes             text,
  status            text not null default 'idle',
  thumbnail_path    text,
  owner_profile_id  uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create trigger trg_properties_set_updated_at
  before update on public.properties
  for each row execute function public.set_updated_at();


-- property_assignments: which staff member is assigned to which property
-- (role_at_property is a soft hint, distinct from the company-level role).
create table public.property_assignments (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  property_id       uuid not null references public.properties(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  role_at_property  text,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  unique (property_id, user_id, role_at_property)
);


-- property_owner_links: a property may be visible to one or more
-- owner-viewer profiles (multi-owner case).
create table public.property_owner_links (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  property_id       uuid not null references public.properties(id) on delete cascade,
  owner_profile_id  uuid not null references public.profiles(id) on delete cascade,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  unique (property_id, owner_profile_id)
);


-- ================================================================
-- STAYS
-- ================================================================

-- stays: a single guest booking. A turnover inspection pairs an
-- outgoing stay with an incoming stay.
-- status: 'upcoming' | 'in_progress' | 'checked_out' | 'closed'
create table public.stays (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  property_id       uuid not null references public.properties(id) on delete cascade,
  expected_arrival  timestamptz,
  expected_checkout timestamptz,
  actual_arrival    timestamptz,
  actual_checkout   timestamptz,
  guest_first_name  text,
  guest_phone       text,
  guest_email       text,
  ota_reference     text,
  status            text not null default 'upcoming',
  created_by        uuid not null references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create trigger trg_stays_set_updated_at
  before update on public.stays
  for each row execute function public.set_updated_at();


-- ================================================================
-- INSPECTION TEMPLATES (three-layer model)
-- ================================================================

-- inspection_templates: company-level template definitions.
-- template_kind: 'turnover' | 'pre_arrival_only' | 'post_stay_only'
--   | 'annual_audit' | 'custom'
create table public.inspection_templates (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  template_kind text not null,
  name          text not null,
  version       int not null default 1,
  active        boolean not null default true,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create trigger trg_inspection_templates_set_updated_at
  before update on public.inspection_templates
  for each row execute function public.set_updated_at();


create table public.inspection_template_sections (
  id                            uuid primary key default gen_random_uuid(),
  template_id                   uuid not null references public.inspection_templates(id) on delete cascade,
  title                         text not null,
  order_index                   int not null,
  auto_populate_from_inventory  boolean not null default false,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  deleted_at                    timestamptz
);
create trigger trg_inspection_template_sections_set_updated_at
  before update on public.inspection_template_sections
  for each row execute function public.set_updated_at();


-- inspection_template_items:
--   category: 'cleanliness' | 'amenities' | 'appliances' | 'inventory'
--     | 'maintenance' | 'safety' | 'condition' | 'custom'
--   check_mode: 'pass_fail' | 'numeric' | 'text' | 'photo_required'
--     | 'multi_state'
--   required_photo: 'none' | 'if_flagged' | 'always' | 'multi_required'
--   required_note: 'none' | 'if_flagged' | 'always' | 'if_flagged_and_type_in'
create table public.inspection_template_items (
  id                    uuid primary key default gen_random_uuid(),
  section_id            uuid not null references public.inspection_template_sections(id) on delete cascade,
  label                 text not null,
  category              text,
  check_mode            text not null default 'pass_fail',
  required_photo        text not null default 'none',
  required_photo_count  int not null default 0,
  required_note         text not null default 'none',
  mandatory_individual  boolean not null default false,
  order_index           int not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create trigger trg_inspection_template_items_set_updated_at
  before update on public.inspection_template_items
  for each row execute function public.set_updated_at();


-- property_template_overrides: per-property additions / removals / edits
-- against a company template.
-- override_kind: 'add_item' | 'remove_item' | 'edit_item'
create table public.property_template_overrides (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies(id) on delete cascade,
  property_id             uuid not null references public.properties(id) on delete cascade,
  template_id             uuid not null references public.inspection_templates(id) on delete cascade,
  override_kind           text not null,
  target_template_item_id uuid references public.inspection_template_items(id),
  payload                 jsonb not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);
create trigger trg_property_template_overrides_set_updated_at
  before update on public.property_template_overrides
  for each row execute function public.set_updated_at();


-- ================================================================
-- INVENTORY ITEMS (per-property catalogue)
-- ================================================================

-- inventory_items: each property's bookable items.
-- category: 'kitchen' | 'bathroom' | 'bedroom' | 'living_room' |
--   'outdoor' | 'safety' | 'other'
create table public.inventory_items (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references public.companies(id) on delete cascade,
  property_id                uuid not null references public.properties(id) on delete cascade,
  name                       text not null,
  expected_quantity          int not null default 1,
  unit                       text not null default 'each',
  category                   text,
  replacement_cost_estimate  decimal(12,2),
  is_active                  boolean not null default true,
  notes                      text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  deleted_at                 timestamptz
);
create trigger trg_inventory_items_set_updated_at
  before update on public.inventory_items
  for each row execute function public.set_updated_at();


-- ================================================================
-- INSPECTION INSTANCES (snapshots of templates at start time)
-- ================================================================

-- inspections: one row per inspection. Pairs an outgoing stay with
-- an incoming stay for turnovers. stay_id is kept null in v1.0+
-- (deprecated; use outgoing/incoming instead).
-- status: 'draft' | 'submitted' | 'reviewed'
create table public.inspections (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  property_id           uuid not null references public.properties(id) on delete cascade,
  template_id           uuid not null references public.inspection_templates(id),
  template_version      int not null,
  template_kind         text not null,
  outgoing_stay_id      uuid references public.stays(id),
  incoming_stay_id      uuid references public.stays(id),
  stay_id               uuid references public.stays(id), -- DEPRECATED: use outgoing/incoming instead
  status                text not null default 'draft',
  ready_for_next_guest  boolean,
  ready_blocker_reason  text,
  started_at            timestamptz not null default now(),
  submitted_at          timestamptz,
  reviewed_at           timestamptz,
  inspector_id          uuid not null references public.profiles(id),
  reviewer_id           uuid references public.profiles(id),
  client_uuid           text,  -- offline idempotency key from the device
  extra_notes           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  unique (company_id, client_uuid)
);
create trigger trg_inspections_set_updated_at
  before update on public.inspections
  for each row execute function public.set_updated_at();


-- inspection_sections: per-inspection snapshot of template sections.
create table public.inspection_sections (
  id                  uuid primary key default gen_random_uuid(),
  inspection_id       uuid not null references public.inspections(id) on delete cascade,
  template_section_id uuid references public.inspection_template_sections(id),
  title               text not null,
  order_index         int not null,
  bulk_ok_at          timestamptz,
  bulk_ok_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger trg_inspection_sections_set_updated_at
  before update on public.inspection_sections
  for each row execute function public.set_updated_at();


-- inspection_items: per-inspection snapshot of template items + inventory
-- items (auto-populated for the inventory section).
-- status: 'pending' | 'ok' | 'flagged' | 'not_applicable'
create table public.inspection_items (
  id                    uuid primary key default gen_random_uuid(),
  inspection_id         uuid not null references public.inspections(id) on delete cascade,
  section_id            uuid not null references public.inspection_sections(id) on delete cascade,
  template_item_id      uuid references public.inspection_template_items(id),
  inventory_item_id     uuid references public.inventory_items(id),
  label                 text not null,
  category              text,
  check_mode            text not null default 'pass_fail',
  required_photo        text not null default 'none',
  required_note         text not null default 'none',
  mandatory_individual  boolean not null default false,
  is_one_off            boolean not null default false,
  order_index           int not null,
  status                text not null default 'pending',
  numeric_value         decimal(12,2),
  text_value            text,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger trg_inspection_items_set_updated_at
  before update on public.inspection_items
  for each row execute function public.set_updated_at();


-- ================================================================
-- FLAGS — the parent record for every real-world problem
-- ================================================================

-- flag_categories: the 11 taxonomy rows. company_id IS NULL for the
-- system seed; per-company extensions arrive in v1.5+.
create table public.flag_categories (
  id                                uuid primary key default gen_random_uuid(),
  company_id                        uuid references public.companies(id) on delete cascade,
  key                               text not null,
  display_label                     text not null,
  icon                              text,
  severity_default                  text not null default 'low',
  default_action                    text,
  default_classification_sla_hours  int,
  default_action_sla_hours          int,
  is_active                         boolean not null default true,
  created_at                        timestamptz not null default now(),
  -- NULLS NOT DISTINCT (Postgres 15+) treats two (NULL, 'x') rows as a
  -- duplicate, which is what we want for system seeds where every
  -- system row has company_id IS NULL. Without this, two re-runs of the
  -- system seed could silently create duplicate (NULL, 'condition_note')
  -- rows. Per-company custom categories (v1.5+) use the same constraint
  -- transparently because their company_id is non-NULL.
  unique nulls not distinct (company_id, key)
);


-- flags: the parent record for every real-world problem. Downstream
-- tables (issues, maintenance_jobs, inventory_movements, guest_recovery_tasks,
-- accountability_records) carry parent_flag_id pointing back here.
-- status: 'raised' | 'classified' | 'actioned' | 'closed' | 'no_action'
-- severity: 'low' | 'med' | 'high'
-- chargeable_party_decision: 'guest' | 'owner' | 'company' | 'contractor'
--   | 'pending_decision' (set by manager triage; controls cost cascade)
create table public.flags (
  id                          uuid primary key default gen_random_uuid(),
  company_id                  uuid not null references public.companies(id) on delete cascade,
  property_id                 uuid not null references public.properties(id) on delete cascade,
  inspection_id               uuid references public.inspections(id) on delete set null,
  inspection_item_id          uuid references public.inspection_items(id) on delete set null,
  stay_id                     uuid references public.stays(id) on delete set null,
  flag_category_id            uuid not null references public.flag_categories(id),
  status                      text not null default 'raised',
  severity                    text not null default 'low',
  description                 text,
  chargeable_party_decision   text,
  raised_by                   uuid not null references public.profiles(id),
  raised_at                   timestamptz not null default now(),
  classified_by               uuid references public.profiles(id),
  classified_at               timestamptz,
  actioned_at                 timestamptz,
  closed_at                   timestamptz,
  no_action_reason            text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  deleted_at                  timestamptz
);
create trigger trg_flags_set_updated_at
  before update on public.flags
  for each row execute function public.set_updated_at();


-- ================================================================
-- ISSUES, MAINTENANCE JOBS, INVENTORY MOVEMENTS
-- ================================================================

-- issues: investigative ticket created from a flag (or standalone).
-- priority: 'low' | 'med' | 'high'
-- status: 'open' | 'in_progress' | 'resolved' | 'verified'
create table public.issues (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  property_id     uuid not null references public.properties(id) on delete cascade,
  parent_flag_id  uuid references public.flags(id),
  title           text not null,
  description     text,
  priority        text not null default 'med',
  status          text not null default 'open',
  assignee_id     uuid references public.profiles(id),
  estimated_cost  decimal(12,2),
  actual_cost     decimal(12,2),
  opened_by       uuid not null references public.profiles(id),
  opened_at       timestamptz not null default now(),
  resolved_at     timestamptz,
  verified_by     uuid references public.profiles(id),
  verified_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create trigger trg_issues_set_updated_at
  before update on public.issues
  for each row execute function public.set_updated_at();


-- maintenance_jobs: scheduled / in-progress maintenance work.
-- status: 'open' | 'scheduled' | 'in_progress' | 'done' | 'verified'
-- emergency_override fields support safety/urgent work that proceeds
-- before approval (audited post-event).
create table public.maintenance_jobs (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references public.companies(id) on delete cascade,
  property_id                uuid not null references public.properties(id) on delete cascade,
  issue_id                   uuid references public.issues(id),
  parent_flag_id             uuid references public.flags(id),
  assignee_id                uuid references public.profiles(id),
  status                     text not null default 'open',
  scheduled_for              timestamptz,
  estimated_cost             decimal(12,2),
  actual_cost                decimal(12,2),
  emergency_override         boolean not null default false,
  emergency_override_reason  text,
  emergency_override_by      uuid references public.profiles(id),
  emergency_override_at      timestamptz,
  created_by                 uuid not null references public.profiles(id),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  deleted_at                 timestamptz
);
create trigger trg_maintenance_jobs_set_updated_at
  before update on public.maintenance_jobs
  for each row execute function public.set_updated_at();


-- inventory_movements: per-item inventory event log.
-- movement_type: 'missing' | 'damaged' | 'restocked' | 'returned'
--   | 'replaced' | 'extra'
create table public.inventory_movements (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  property_id       uuid not null references public.properties(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  inspection_id     uuid references public.inspections(id) on delete set null,
  parent_flag_id    uuid references public.flags(id),
  movement_type     text not null,
  quantity          int not null default 1,
  notes             text,
  recorded_by       uuid not null references public.profiles(id),
  recorded_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create trigger trg_inventory_movements_set_updated_at
  before update on public.inventory_movements
  for each row execute function public.set_updated_at();


-- ================================================================
-- GUEST RECOVERY
-- ================================================================

-- guest_recovery_tasks: same-day post-stay damage recovery flow.
-- status: 'new' | 'guest_notified' | 'guest_resolved' | 'ota_attempted'
--   | 'ota_resolved' | 'fallback_decision' | 'closed'
-- final_chargeable_party: 'guest' | 'ota' | 'company' | 'owner'
create table public.guest_recovery_tasks (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies(id) on delete cascade,
  property_id              uuid not null references public.properties(id) on delete cascade,
  stay_id                  uuid not null references public.stays(id),
  parent_flag_id           uuid not null references public.flags(id),
  source_inspection_id     uuid references public.inspections(id) on delete set null,
  description              text,
  estimated_amount         decimal(12,2),
  actual_amount            decimal(12,2),
  status                   text not null default 'new',
  deadline_at              timestamptz not null,
  final_chargeable_party   text,
  created_by               uuid not null references public.profiles(id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  closed_at                timestamptz,
  deleted_at               timestamptz
);
create trigger trg_guest_recovery_tasks_set_updated_at
  before update on public.guest_recovery_tasks
  for each row execute function public.set_updated_at();


-- recovery_attempts: every contact attempt / OTA claim / decision
-- attached to a guest recovery task. Append-only in spirit
-- (no updated_at / deleted_at — mistakes are corrected with a new row).
-- attempt_type: 'guest_direct' | 'ota_claim' | 'company_absorb' | 'owner_charge'
-- attempt_method: 'whatsapp' | 'email' | 'sms' | 'phone' | 'ota_portal'
--   | 'in_person' | 'app_decision' | 'manual_copy' | 'whatsapp_deeplink'
-- outcome: 'paid_full' | 'paid_partial' | 'refused' | 'no_response'
--   | 'denied' | 'pending' | 'approved_internal' | 'approved_owner'
create table public.recovery_attempts (
  id                       uuid primary key default gen_random_uuid(),
  task_id                  uuid not null references public.guest_recovery_tasks(id) on delete cascade,
  attempt_type             text not null,
  attempt_method           text,
  message_sent_at          timestamptz,
  message_template_id      text,
  message_body_snapshot    text,
  response_at              timestamptz,
  response_evidence_path   text,
  outcome                  text,
  amount_recovered         decimal(12,2),
  recorded_by              uuid not null references public.profiles(id),
  recorded_at              timestamptz not null default now(),
  notes                    text
);


-- ================================================================
-- APPROVALS AND ACCOUNTABILITY
-- ================================================================

-- approval_policies: configurable caps at company / owner / property /
-- category scope. The active policy at decision time is found by
-- precedence (property > owner > company > system fallback).
-- scope_type: 'company' | 'owner' | 'property' | 'category'
create table public.approval_policies (
  id                          uuid primary key default gen_random_uuid(),
  company_id                  uuid not null references public.companies(id) on delete cascade,
  scope_type                  text not null,
  scope_id                    uuid,        -- owner/property id when applicable
  category                    text,        -- when scope_type = 'category'
  single_inventory_item_cap   decimal(12,2),
  single_maintenance_item_cap decimal(12,2),
  single_owner_chargeable_cap decimal(12,2),
  monthly_owner_total_cap     decimal(12,2),
  annual_owner_total_cap      decimal(12,2),
  internal_approvable_below   decimal(12,2) not null default 0,
  internal_ceiling            decimal(12,2),
  absolute_block_above        decimal(12,2),
  active_from                 timestamptz not null default now(),
  active_to                   timestamptz,
  notes                       text,
  created_by                  uuid not null references public.profiles(id),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  deleted_at                  timestamptz
);
create trigger trg_approval_policies_set_updated_at
  before update on public.approval_policies
  for each row execute function public.set_updated_at();


-- accountability_records: the chain of who-pays-for-what.
-- source_type: 'inspection_item' | 'issue' | 'inventory_movement'
--   | 'maintenance_job' | 'guest_recovery_task'
-- chargeable_party / final_chargeable_party: 'none' | 'guest' | 'owner'
--   | 'company' | 'contractor' | 'pending_decision'
-- recovery_status: 'not_attempted' | 'guest_attempted' | 'guest_paid'
--   | 'ota_attempted' | 'ota_paid' | 'company_absorbed'
--   | 'owner_charged' | 'closed'
create table public.accountability_records (
  id                          uuid primary key default gen_random_uuid(),
  company_id                  uuid not null references public.companies(id) on delete cascade,
  property_id                 uuid not null references public.properties(id) on delete cascade,
  source_type                 text not null,
  source_id                   uuid not null,
  parent_flag_id              uuid references public.flags(id),
  chargeable_party            text not null default 'pending_decision',
  estimated_amount            decimal(12,2),
  actual_amount               decimal(12,2),
  recovery_status             text not null default 'not_attempted',
  recovery_attempts_count     int not null default 0,
  linked_recovery_task_id     uuid references public.guest_recovery_tasks(id),
  final_chargeable_party      text,
  absorbed_reason             text,    -- required when final = 'company'
  approved_by                 uuid references public.profiles(id),
  approved_at                 timestamptz,
  notes                       text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  deleted_at                  timestamptz
);
create trigger trg_accountability_records_set_updated_at
  before update on public.accountability_records
  for each row execute function public.set_updated_at();


-- approval_decisions: APPEND-ONLY log of every approval action.
-- subject_type: 'accountability_record' | 'maintenance_job' | 'inventory_movement'
-- cap_breached: 'none' | 'single_item' | 'monthly_total' | 'annual_total'
--   | 'category' | 'absolute'
-- decision: 'approved' | 'pending_owner' | 'owner_approved' | 'owner_rejected'
--   | 'blocked' | 'overridden' | 'emergency_override'
create table public.approval_decisions (
  id                            uuid primary key default gen_random_uuid(),
  company_id                    uuid not null references public.companies(id) on delete cascade,
  property_id                   uuid not null references public.properties(id) on delete cascade,
  subject_type                  text not null,
  subject_id                    uuid not null,
  amount                        decimal(12,2) not null,
  policy_used_id                uuid not null references public.approval_policies(id),
  cap_breached                  text not null default 'none',
  decision                      text not null,
  decided_by                    uuid not null references public.profiles(id),
  owner_response_method         text,
  owner_response_evidence_path  text,
  decided_at                    timestamptz not null default now(),
  override_reason               text,
  created_at                    timestamptz not null default now()
  -- NO updated_at, NO deleted_at — append-only.
);


-- ================================================================
-- PHOTOS
-- ================================================================

-- photos: the one photos table. Evidence Vault is a filtered view
-- over this table, not a separate store. Every FK is nullable so
-- a photo can be attached to whatever it is evidence of.
-- entity_type: 'inspection_item' | 'issue' | 'maintenance_before'
--   | 'maintenance_after' | 'inventory' | 'property' | 'flag'
--   | 'guest_recovery' | 'recovery_message_proof' | 'evidence'
-- retention_class: 'routine_pre_arrival' | 'routine_post_stay'
--   | 'dispute_evidence' | 'owner_chargeable_evidence'
--   | 'annual_audit_evidence' | 'maintenance_before_after'
--   | 'inventory_evidence'
-- sync_status (device-only): 'queued' | 'uploading' | 'synced' | 'failed'
create table public.photos (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies(id) on delete cascade,
  property_id              uuid references public.properties(id) on delete set null,
  stay_id                  uuid references public.stays(id) on delete set null,
  inspection_id            uuid references public.inspections(id) on delete set null,
  inspection_item_id       uuid references public.inspection_items(id) on delete set null,
  flag_id                  uuid references public.flags(id) on delete set null,
  issue_id                 uuid references public.issues(id) on delete set null,
  maintenance_job_id       uuid references public.maintenance_jobs(id) on delete set null,
  inventory_movement_id    uuid references public.inventory_movements(id) on delete set null,
  guest_recovery_task_id   uuid references public.guest_recovery_tasks(id) on delete set null,
  entity_type              text not null,
  retention_class          text not null,
  uploaded_by              uuid not null references public.profiles(id),
  captured_at              timestamptz,
  uploaded_at              timestamptz not null default now(),
  storage_path             text not null,
  thumbnail_path           text,
  file_hash                text,
  mime_type                text,
  width                    int,
  height                   int,
  size_bytes               int,
  notes                    text,
  sync_status              text not null default 'synced',
  bytes_deleted_at         timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz
);
create trigger trg_photos_set_updated_at
  before update on public.photos
  for each row execute function public.set_updated_at();


-- ================================================================
-- OWNER COMMUNICATIONS
-- ================================================================

-- weekly_status_updates: per-property weekly digest to owner.
-- status: 'draft' | 'sent'
create table public.weekly_status_updates (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies(id) on delete cascade,
  property_id              uuid not null references public.properties(id) on delete cascade,
  week_starting            date not null,
  week_ending              date not null,
  status                   text not null default 'draft',
  prepared_by              uuid not null references public.profiles(id),
  prepared_at              timestamptz not null default now(),
  sent_by                  uuid references public.profiles(id),
  sent_at                  timestamptz,
  manual_property_status   text,
  manual_occupancy_note    text,
  notes_to_owner           text,
  content_snapshot         jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  unique (company_id, property_id, week_starting)
);
create trigger trg_weekly_status_updates_set_updated_at
  before update on public.weekly_status_updates
  for each row execute function public.set_updated_at();


-- owner_monthly_summaries: per-property monthly report (the headline
-- v1.3 deliverable; schema lands now per "schema decisions are roadmap
-- decisions").
create table public.owner_monthly_summaries (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  property_id       uuid not null references public.properties(id) on delete cascade,
  year_month        text not null,             -- 'YYYY-MM'
  status            text not null default 'draft',
  prepared_by       uuid not null references public.profiles(id),
  prepared_at       timestamptz not null default now(),
  sent_by           uuid references public.profiles(id),
  sent_at           timestamptz,
  total_estimated   decimal(12,2),
  total_actual      decimal(12,2),
  notes_to_owner    text,
  content_snapshot  jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  unique (company_id, property_id, year_month)
);
create trigger trg_owner_monthly_summaries_set_updated_at
  before update on public.owner_monthly_summaries
  for each row execute function public.set_updated_at();


create table public.owner_monthly_summary_lines (
  id                        uuid primary key default gen_random_uuid(),
  summary_id                uuid not null references public.owner_monthly_summaries(id) on delete cascade,
  accountability_record_id  uuid references public.accountability_records(id),
  description               text not null,
  amount                    decimal(12,2),
  photo_ids                 uuid[],    -- array; FK integrity enforced in app code
  order_index               int
);


-- ================================================================
-- AUDIT
-- ================================================================

-- audit_events: APPEND-ONLY history of every meaningful state change.
-- The schema plan calls for entity_type / entity_id pairs so audit
-- rows are queryable per-entity for history views.
create table public.audit_events (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid references public.companies(id) on delete set null,
  actor_id     uuid references public.profiles(id) on delete set null,
  event_kind   text not null,
  entity_type  text,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  metadata     jsonb,
  created_at   timestamptz not null default now()
  -- NO updated_at, NO deleted_at — append-only.
);
