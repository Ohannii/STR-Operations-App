# DATABASE_SCHEMA_PLAN.md

## Purpose

This is the **final, consolidated** database schema for v1.0–v1.3 of the STR ops product. It is the source-of-truth shape that migrations will be generated from. No more patch-notes. Every table here is in its final v1.0–v1.3 form.

Where a column is added in a later stage, the column is shown with a `STAGE:` tag (e.g. `STAGE: v1.2`). The schema is built once; only UI and code wiring stages.

---

## Conventions

- Every business table has `company_id uuid not null` referencing `companies(id)`. This is what makes multi-tenant isolation work.
- Primary keys are `uuid` (`gen_random_uuid()`).
- Timestamps `created_at`, `updated_at`, `deleted_at` (nullable, for soft delete) on every business table.
- Any state change writes a row to `audit_events`.
- All foreign keys are explicit. Cascade rules chosen deliberately per table.
- All tables have RLS enabled before data is inserted.
- Money columns are `decimal(12,2)` to handle ZAR safely.
- Soft delete via `deleted_at IS NULL` filter in RLS. No hard deletes from app code.

---

## Architectural rule that the schema enforces

**The flag is the parent record for every real-world problem.** Every downstream record (issues, maintenance jobs, inventory movements, guest recovery tasks, accountability records) carries `parent_flag_id uuid null references flags(id)` so the Action Centre can group them under one card. This rule is from `DEDUPLICATION_AND_TASK_GROUPING_RULES.md`. Schema-level enforcement: there's an `idx_<table>_parent_flag_id` index on every downstream table for fast lookups.

---

## Entity groups (final list)

1. Tenancy and identity
2. Roles
3. Properties
4. Stays
5. Inspection templates
6. Inspection instances
7. Inventory items
8. Flags
9. Issues
10. Maintenance jobs
11. Inventory movements
12. Guest recovery
13. Accountability and approvals
14. Photos and evidence
15. Owner communications
16. Audit

---

## Table-by-table definitions

### `companies`

```
id                          uuid pk
name                        text not null
slug                        text unique
plan_tier                   text default 'free'
seed_policy_applied         boolean default false
created_at                  timestamptz default now()
updated_at                  timestamptz default now()
deleted_at                  timestamptz null
```

### `profiles`

```
id                          uuid pk (matches auth.users.id)
full_name                   text
email                       text
phone                       text
locale                      text default 'en'
created_at                  timestamptz default now()
updated_at                  timestamptz default now()
deleted_at                  timestamptz null
```

### `company_memberships`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
user_id                     uuid not null fk → profiles(id)
role_key                    text not null fk → roles(key)
is_active                   boolean default true
created_at, updated_at, deleted_at
UNIQUE (company_id, user_id)
```

### `roles` (system-wide seed, not per-company)

```
key                         text pk     -- 'company_admin', 'gm', 'ops_manager', 'maintenance_coordinator',
                                          -- 'inspector', 'maintenance_tech', 'inventory_manager',
                                          -- 'finance', 'auditor', 'property_owner_viewer', 'super_admin'
display_label               text
description                 text
```

### `invitations`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
email                       text not null
role_key                    text not null fk → roles(key)
invited_by                  uuid not null fk → profiles(id)
token                       text unique not null
accepted_at                 timestamptz null
expires_at                  timestamptz not null
created_at, deleted_at
```

---

### `properties`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
name                        text not null
address                     text
unit_reference              text
bedrooms                    int
notes                       text
status                      text default 'idle'
                            -- 'idle' | 'guest_in' | 'between_stays' |
                            -- 'pre_arrival_pending' | 'post_stay_pending' |
                            -- 'needs_attention' | 'critical' | 'ready_for_arrival' | 'not_ready'
thumbnail_path              text null
owner_profile_id            uuid null fk → profiles(id)   -- optional owner viewer link
created_at, updated_at, deleted_at
```

### `property_assignments`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
user_id                     uuid not null fk → profiles(id)
role_at_property            text  -- 'inspector' | 'manager' | 'coordinator' | etc.
created_at, deleted_at
UNIQUE (property_id, user_id, role_at_property)
```

### `property_owner_links` (a property may be visible to one or more owner-viewer profiles)

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
owner_profile_id            uuid not null fk → profiles(id)
created_at, deleted_at
UNIQUE (property_id, owner_profile_id)
```

---

### `stays`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
expected_arrival            timestamptz null
expected_checkout           timestamptz null
actual_arrival              timestamptz null
actual_checkout             timestamptz null
guest_first_name            text null
guest_phone                 text null
guest_email                 text null
ota_reference               text null      -- e.g., Airbnb reservation code
status                      text default 'upcoming'
                            -- 'upcoming' | 'in_progress' | 'checked_out' | 'closed'
created_by                  uuid not null fk → profiles(id)
created_at, updated_at, deleted_at
```

---

### `inspection_templates`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
template_kind               text not null
                            -- 'turnover' | 'pre_arrival_only' | 'post_stay_only' | 'annual_audit' | 'custom'
name                        text not null
version                     int default 1
active                      boolean default true
created_by                  uuid fk → profiles(id)
created_at, updated_at, deleted_at
```

### `inspection_template_sections`

```
id                          uuid pk
template_id                 uuid not null fk → inspection_templates(id)
title                       text not null
order_index                 int not null
auto_populate_from_inventory boolean default false   -- true on the Inventory section
created_at, updated_at, deleted_at
```

### `inspection_template_items`

```
id                          uuid pk
section_id                  uuid not null fk → inspection_template_sections(id)
label                       text not null
category                    text  -- 'cleanliness' | 'amenities' | 'appliances' | 'inventory' | 'maintenance' | 'safety' | 'condition' | 'custom'
check_mode                  text default 'pass_fail'
                            -- 'pass_fail' | 'numeric' | 'text' | 'photo_required' | 'multi_state'
required_photo              text default 'none'
                            -- 'none' | 'if_flagged' | 'always' | 'multi_required'
required_photo_count        int default 0
required_note               text default 'none'
                            -- 'none' | 'if_flagged' | 'always' | 'if_flagged_and_type_in'
mandatory_individual        boolean default false
order_index                 int not null
created_at, updated_at, deleted_at
```

### `property_template_overrides` (per-property additions/removals against a company template)

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
template_id                 uuid not null fk → inspection_templates(id)
override_kind               text not null
                            -- 'add_item' | 'remove_item' | 'edit_item'
target_template_item_id     uuid null fk → inspection_template_items(id)   -- null for add_item
payload                     jsonb not null
                            -- shape depends on override_kind; e.g., for add_item: {label, category, required_photo, ...}
created_at, updated_at, deleted_at
```

---

### `inspections`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
template_id                 uuid not null fk → inspection_templates(id)
template_version            int not null
template_kind               text not null
outgoing_stay_id            uuid null fk → stays(id)
incoming_stay_id            uuid null fk → stays(id)
stay_id                     uuid null fk → stays(id)   -- DEPRECATED: kept null in v1.0+; use outgoing/incoming instead
status                      text default 'draft'
                            -- 'draft' | 'submitted' | 'reviewed'
ready_for_next_guest        boolean null   -- set on submit for turnover/pre-arrival
ready_blocker_reason        text null
started_at                  timestamptz default now()
submitted_at                timestamptz null
reviewed_at                 timestamptz null
inspector_id                uuid not null fk → profiles(id)
reviewer_id                 uuid null fk → profiles(id)
client_uuid                 text  -- for offline idempotency
extra_notes                 text null
created_at, updated_at, deleted_at
UNIQUE (company_id, client_uuid)
```

### `inspection_sections` (snapshot)

```
id                          uuid pk
inspection_id               uuid not null fk → inspections(id)
template_section_id         uuid null fk → inspection_template_sections(id)
title                       text not null
order_index                 int not null
bulk_ok_at                  timestamptz null
bulk_ok_by                  uuid null fk → profiles(id)
created_at, updated_at
```

### `inspection_items` (snapshot)

```
id                          uuid pk
inspection_id               uuid not null fk → inspections(id)
section_id                  uuid not null fk → inspection_sections(id)
template_item_id            uuid null fk → inspection_template_items(id)
inventory_item_id           uuid null fk → inventory_items(id)
label                       text not null
category                    text
check_mode                  text default 'pass_fail'
required_photo              text default 'none'
required_note               text default 'none'
mandatory_individual        boolean default false
is_one_off                  boolean default false
order_index                 int not null
status                      text default 'pending'
                            -- 'pending' | 'ok' | 'flagged' | 'not_applicable'
numeric_value               decimal(12,2) null
text_value                  text null
notes                       text null
created_at, updated_at
```

---

### `inventory_items` (per-property catalogue)

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
name                        text not null
expected_quantity           int default 1
unit                        text default 'each'
category                    text  -- 'kitchen' | 'bathroom' | 'bedroom' | 'living_room' | 'outdoor' | 'safety' | 'other'
replacement_cost_estimate   decimal(12,2) null
is_active                   boolean default true
notes                       text
created_at, updated_at, deleted_at
```

---

### `flag_categories` (system-wide seed)

```
id                          uuid pk
company_id                  uuid null    -- null = system seed; per-company extensions in v1.5+
key                         text not null
display_label               text not null
icon                        text
severity_default            text default 'low'
default_action              text  -- 'no_action' | 'create_issue' | 'create_movement' | 'create_recovery' | 'create_accountability'
default_classification_sla_hours  int
default_action_sla_hours    int null
is_active                   boolean default true
created_at
UNIQUE (company_id, key)
```

### `flags` — the parent record for every real-world problem

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
inspection_id               uuid null fk → inspections(id)
inspection_item_id          uuid null fk → inspection_items(id)
stay_id                     uuid null fk → stays(id)
flag_category_id            uuid not null fk → flag_categories(id)
status                      text default 'raised'
                            -- 'raised' | 'classified' | 'actioned' | 'closed' | 'no_action'
severity                    text default 'low'
                            -- 'low' | 'med' | 'high'
description                 text
chargeable_party_decision   text null
                            -- 'guest' | 'owner' | 'company' | 'contractor' | 'pending_decision'
                            -- (set by manager triage; controls cascade)
raised_by                   uuid not null fk → profiles(id)
raised_at                   timestamptz default now()
classified_by               uuid null fk → profiles(id)
classified_at               timestamptz null
actioned_at                 timestamptz null
closed_at                   timestamptz null
no_action_reason            text null
created_at, updated_at, deleted_at
```

(Note: in earlier patch-note revisions, `flags` carried `linked_*` shortcut FK columns. In this consolidated final shape, those are NOT on `flags`. Instead the relationship is reversed: child tables carry `parent_flag_id`. This is cleaner: one flag can have many children of the same kind without bloating the parent row.)

---

### `issues`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
parent_flag_id              uuid null fk → flags(id)   -- the parent-record link
title                       text not null
description                 text
priority                    text default 'med'
                            -- 'low' | 'med' | 'high'
status                      text default 'open'
                            -- 'open' | 'in_progress' | 'resolved' | 'verified'
assignee_id                 uuid null fk → profiles(id)
estimated_cost              decimal(12,2) null
actual_cost                 decimal(12,2) null
opened_by                   uuid not null fk → profiles(id)
opened_at                   timestamptz default now()
resolved_at                 timestamptz null
verified_by                 uuid null fk → profiles(id)
verified_at                 timestamptz null
created_at, updated_at, deleted_at
```

### `maintenance_jobs`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
issue_id                    uuid null fk → issues(id)
parent_flag_id              uuid null fk → flags(id)
assignee_id                 uuid null fk → profiles(id)
status                      text default 'open'
                            -- 'open' | 'scheduled' | 'in_progress' | 'done' | 'verified'
scheduled_for               timestamptz null
estimated_cost              decimal(12,2) null
actual_cost                 decimal(12,2) null
emergency_override          boolean default false
emergency_override_reason   text null
emergency_override_by       uuid null fk → profiles(id)
emergency_override_at       timestamptz null
created_by                  uuid not null fk → profiles(id)
created_at, updated_at, deleted_at
```

---

### `inventory_movements`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
inventory_item_id           uuid not null fk → inventory_items(id)
inspection_id               uuid null fk → inspections(id)
parent_flag_id              uuid null fk → flags(id)
movement_type               text not null
                            -- 'missing' | 'damaged' | 'restocked' | 'returned' | 'replaced' | 'extra'
quantity                    int default 1
notes                       text
recorded_by                 uuid not null fk → profiles(id)
recorded_at                 timestamptz default now()
created_at, updated_at, deleted_at
```

---

### `guest_recovery_tasks`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
stay_id                     uuid not null fk → stays(id)
parent_flag_id              uuid not null fk → flags(id)
source_inspection_id        uuid null fk → inspections(id)
description                 text
estimated_amount            decimal(12,2) null
actual_amount               decimal(12,2) null
status                      text default 'new'
                            -- 'new' | 'guest_notified' | 'guest_resolved'
                            -- | 'ota_attempted' | 'ota_resolved'
                            -- | 'fallback_decision' | 'closed'
deadline_at                 timestamptz not null
final_chargeable_party      text null
                            -- 'guest' | 'ota' | 'company' | 'owner'
created_by                  uuid not null fk → profiles(id)
created_at, updated_at, closed_at, deleted_at
```

### `recovery_attempts`

```
id                          uuid pk
task_id                     uuid not null fk → guest_recovery_tasks(id)
attempt_type                text not null
                            -- 'guest_direct' | 'ota_claim' | 'company_absorb' | 'owner_charge'
attempt_method              text
                            -- 'whatsapp' | 'email' | 'sms' | 'phone' | 'ota_portal' | 'in_person' | 'app_decision' | 'manual_copy' | 'whatsapp_deeplink'
message_sent_at             timestamptz null
message_template_id         text null
message_body_snapshot       text null
response_at                 timestamptz null
response_evidence_path      text null   -- e.g., screenshot of WhatsApp reply
outcome                     text
                            -- 'paid_full' | 'paid_partial' | 'refused' | 'no_response'
                            -- | 'denied' | 'pending' | 'approved_internal' | 'approved_owner'
amount_recovered            decimal(12,2) null
recorded_by                 uuid not null fk → profiles(id)
recorded_at                 timestamptz default now()
notes                       text
```

---

### `approval_policies`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
scope_type                  text not null
                            -- 'company' | 'owner' | 'property' | 'category'
scope_id                    uuid null
                            -- owner profile id, property id, etc.; null for company-scope
category                    text null
                            -- when scope_type = 'category'
single_inventory_item_cap   decimal(12,2) null
single_maintenance_item_cap decimal(12,2) null
single_owner_chargeable_cap decimal(12,2) null
monthly_owner_total_cap     decimal(12,2) null      -- per property per calendar month
annual_owner_total_cap      decimal(12,2) null      -- per property rolling 12 months
internal_approvable_below   decimal(12,2) default 0
internal_ceiling            decimal(12,2) null
absolute_block_above        decimal(12,2) null
active_from                 timestamptz default now()
active_to                   timestamptz null
notes                       text
created_by                  uuid not null fk → profiles(id)
created_at, updated_at, deleted_at
```

### `approval_decisions` (append-only)

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
subject_type                text not null
                            -- 'accountability_record' | 'maintenance_job' | 'inventory_movement'
subject_id                  uuid not null
amount                      decimal(12,2) not null
policy_used_id              uuid not null fk → approval_policies(id)
cap_breached                text default 'none'
                            -- 'none' | 'single_item' | 'monthly_total' | 'annual_total' | 'category' | 'absolute'
decision                    text not null
                            -- 'approved' | 'pending_owner' | 'owner_approved' | 'owner_rejected'
                            -- | 'blocked' | 'overridden' | 'emergency_override'
decided_by                  uuid not null fk → profiles(id)
owner_response_method       text null
owner_response_evidence_path text null
decided_at                  timestamptz default now()
override_reason             text null
created_at
-- NO updated_at, NO deleted_at — append-only.
```

### `accountability_records`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
source_type                 text not null
                            -- 'inspection_item' | 'issue' | 'inventory_movement'
                            -- | 'maintenance_job' | 'guest_recovery_task'
source_id                   uuid not null
parent_flag_id              uuid null fk → flags(id)
chargeable_party            text default 'pending_decision'
                            -- 'none' | 'guest' | 'owner' | 'company' | 'contractor' | 'pending_decision'
estimated_amount            decimal(12,2) null
actual_amount               decimal(12,2) null
recovery_status             text default 'not_attempted'
                            -- 'not_attempted' | 'guest_attempted' | 'guest_paid'
                            -- | 'ota_attempted' | 'ota_paid' | 'company_absorbed'
                            -- | 'owner_charged' | 'closed'
recovery_attempts_count     int default 0
linked_recovery_task_id     uuid null fk → guest_recovery_tasks(id)
final_chargeable_party      text null
absorbed_reason             text null   -- required when final_chargeable_party = 'company'
approved_by                 uuid null fk → profiles(id)
approved_at                 timestamptz null
notes                       text
created_at, updated_at, deleted_at
```

---

### `photos`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid null fk → properties(id)
stay_id                     uuid null fk → stays(id)
inspection_id               uuid null fk → inspections(id)
inspection_item_id          uuid null fk → inspection_items(id)
flag_id                     uuid null fk → flags(id)
issue_id                    uuid null fk → issues(id)
maintenance_job_id          uuid null fk → maintenance_jobs(id)
inventory_movement_id       uuid null fk → inventory_movements(id)
guest_recovery_task_id      uuid null fk → guest_recovery_tasks(id)
entity_type                 text not null
                            -- 'inspection_item' | 'issue' | 'maintenance_before'
                            -- | 'maintenance_after' | 'inventory' | 'property'
                            -- | 'flag' | 'guest_recovery' | 'recovery_message_proof' | 'evidence'
retention_class             text not null
                            -- 'routine_pre_arrival' | 'routine_post_stay' | 'dispute_evidence'
                            -- | 'owner_chargeable_evidence' | 'annual_audit_evidence'
                            -- | 'maintenance_before_after' | 'inventory_evidence'
uploaded_by                 uuid not null fk → profiles(id)
captured_at                 timestamptz null
uploaded_at                 timestamptz default now()
storage_path                text not null
thumbnail_path              text null
file_hash                   text
mime_type                   text
width                       int
height                      int
size_bytes                  int
notes                       text null
sync_status                 text default 'synced'   -- 'queued' | 'uploading' | 'synced' | 'failed' on device only
bytes_deleted_at            timestamptz null
created_at, updated_at, deleted_at
```

---

### `weekly_status_updates`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
week_starting               date not null
week_ending                 date not null
status                      text default 'draft'   -- 'draft' | 'sent'
prepared_by                 uuid not null fk → profiles(id)
prepared_at                 timestamptz default now()
sent_by                     uuid null fk → profiles(id)
sent_at                     timestamptz null
manual_property_status      text null
manual_occupancy_note       text null
notes_to_owner              text null
content_snapshot            jsonb null
created_at, updated_at, deleted_at
UNIQUE (company_id, property_id, week_starting)
```

### `owner_monthly_summaries`

```
id                          uuid pk
company_id                  uuid not null fk → companies(id)
property_id                 uuid not null fk → properties(id)
year_month                  text not null   -- 'YYYY-MM'
status                      text default 'draft'
prepared_by                 uuid not null fk → profiles(id)
prepared_at                 timestamptz default now()
sent_by                     uuid null fk → profiles(id)
sent_at                     timestamptz null
total_estimated             decimal(12,2)
total_actual                decimal(12,2)
notes_to_owner              text
content_snapshot            jsonb null
created_at, updated_at, deleted_at
UNIQUE (company_id, property_id, year_month)
```

### `owner_monthly_summary_lines`

```
id                          uuid pk
summary_id                  uuid not null fk → owner_monthly_summaries(id)
accountability_record_id    uuid null fk → accountability_records(id)
description                 text not null
amount                      decimal(12,2)
photo_ids                   uuid[]
order_index                 int
```

---

### `audit_events` (append-only)

```
id                          uuid pk
company_id                  uuid null
actor_id                    uuid null fk → profiles(id)
event_kind                  text not null
entity_type                 text
entity_id                   uuid
before                      jsonb null
after                       jsonb null
metadata                    jsonb null
created_at                  timestamptz default now()
-- NO updated_at, NO deleted_at — append-only.
```

---

## Row-Level Security (RLS) policy outline

Every business table will have policies along these lines (paraphrased):

- **SELECT:** `company_id = (current user's active company_id)` AND role allows reading that entity.
- **INSERT:** `company_id = (current user's active company_id)` AND role allows creating that entity.
- **UPDATE:** same company + role allows updating + (for restricted fields like `approved_by`) actor's role is in the approving set.
- **DELETE:** generally disallowed; soft-delete via `deleted_at` instead.

For `audit_events`:

- **SELECT:** Company Admin, GM, and Auditor only; restricted to events where `entity` belongs to their company.
- **INSERT:** any user (RLS allows; code controls what gets written).
- **UPDATE / DELETE:** disallowed at the policy level.

For `approval_decisions`:

- **SELECT:** restricted to roles per `USER_ROLES_AND_PERMISSIONS.md`.
- **INSERT:** any user with policy edit / decision rights.
- **UPDATE / DELETE:** disallowed at the policy level.

For owner viewers:

- **SELECT** on `inspections`, `photos`, `weekly_status_updates`, `owner_monthly_summaries`: restricted via `property_owner_links` join AND status = `sent` AND retention class is not routine.

---

## Indexing plan (MVP starting point)

- Every `company_id` column gets an index.
- Every `property_id` column gets an index.
- Every `parent_flag_id` column gets an index (heavy Action Centre use).
- Every `stay_id` column gets an index (heavy Evidence Vault use).
- `flags(property_id, status)` composite for Action Centre listing.
- `photos(property_id, retention_class, captured_at)` composite for Evidence Vault filters.
- `recovery_attempts(task_id, recorded_at)` composite.
- `approval_decisions(property_id, decided_at)` for monthly/annual cap calculations.
- `audit_events(entity_type, entity_id, created_at)` for entity history lookups.

---

## Migration strategy

- All schema changes via versioned SQL files under `supabase/migrations/`.
- Each migration is timestamped and named (`20260601000000_initial_schema.sql`).
- Migrations run on staging first, always, before production.
- One-way migrations (data loss possible) are explicitly noted in `CHANGELOG.md`.
- Point-in-time recovery (PITR) is enabled on Supabase Pro before any production migration.
- Backups taken before any production migration (per `DEPLOYMENT_GUIDE.md`).

---

## Added in v1.0 post-merge (Session 6 — operational marks)

### `flag_operational_marks`

Lightweight operational state attached to flags. Each row represents one
chip toggle. Full vocabulary + semantics in `CHIP_VOCABULARY.md`.

```
id           uuid pk default gen_random_uuid()
company_id   uuid not null fk → companies(id) on delete cascade
flag_id      uuid not null fk → flags(id) on delete cascade
kind         text not null               -- application-controlled string
                                          -- (see CHIP_VOCABULARY.md)
marked_at    timestamptz not null default now()
marked_by    uuid not null fk → profiles(id)
notes        text null
metadata     jsonb null                  -- chip-specific extra fields
                                          -- (assignee, scheduled date,
                                          --  Asana URL, amount, etc.)
cleared_at   timestamptz null            -- null = currently active mark
cleared_by   uuid null fk → profiles(id)
created_at   timestamptz not null default now()
updated_at   timestamptz not null default now()
```

**Partial unique index — critical:**

```sql
create unique index flag_operational_marks_one_active_per_kind
  on public.flag_operational_marks (flag_id, kind)
  where cleared_at is null;
```

Not a plain `UNIQUE (flag_id, kind, cleared_at)` constraint, because
PostgreSQL treats NULL as distinct in unique constraints — that would
let multiple active marks slip through (this is the same NULL-distinct
issue that bit the `flag_categories` constraint earlier; we used
`UNIQUE NULLS NOT DISTINCT` there, partial index here is cleaner).

The partial index expresses exactly what we mean: "at most one active
mark per (flag, kind)". Historical / cleared rows are unconstrained
and can stack freely.

**Indexes:**

- `idx_flag_operational_marks_flag_id` for "all marks for this flag" lookups
- `idx_flag_operational_marks_company_id` for tenant scope
- The partial unique index above also serves as a fast lookup
  for active marks by (flag_id, kind)

**RLS / grants pattern** (defined in the Session 6 migration):

- SELECT for company members
- INSERT for company members where `marked_by = auth.uid()`
- UPDATE for company members (to set `cleared_at` when toggling off)
- No DELETE — append-only history pattern

---

## Things deliberately deferred

- Multi-currency support (single-currency MVP — ZAR).
- Multi-company membership per user (table shape is ready; UI is single-company in MVP).
- Per-category approval caps active UI (data model supports them; UI v1.5).
- Snapshot-then-delete photo job (v1.5+).
- Hot/cold storage separation (v1.5+).
- Recurring inspection scheduling (v1.5+).
- Cleaning task entity (v1.5+).
- OTA evidence pack exports (v1.5+ presentation layer; data is in place from v1.0).
- Real-time push notifications.
- AI-assisted features (see `AI_FEATURE_ROADMAP.md`).
- Asset catalog / asset instances split (research doc recommends this;
  we keep the single `inventory_items` per-property table for v1.0,
  promote to catalog+instances in v1.5+ if commercial scale needs it).
- Native mobile (Expo React Native) for the inspection app (post v1.0).
