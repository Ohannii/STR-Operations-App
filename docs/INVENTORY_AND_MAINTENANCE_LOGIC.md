# INVENTORY_AND_MAINTENANCE_LOGIC.md

## Plain-English overview

**Inventory** answers: *"What's supposed to be in this apartment, what actually is, and who's responsible for the difference?"*

**Maintenance** answers: *"Something needs to be fixed — who is doing it, by when, and what proof do we have when it's done?"*

Both feed into the same goal: a trustworthy monthly summary that a property owner can read without arguing about whether something really happened.

---

## Part 1 — Inventory MVP logic

### Goal

Track what moved, what is missing or damaged, who is accountable, and what may need to be charged to owners (or guests, or absorbed by the company) at the end of the month.

### Data model recap

(Full schema in `DATABASE_SCHEMA_PLAN.md`. Repeating the relevant bits here for clarity.)

- `inventory_items` — per-property catalogue: "TV remote", "Bed sheets — queen", "Kettle".
- `inventory_movements` — every time an item's status changes (missing, damaged, restocked, returned, replaced).
- `accountability_records` — links a movement (or issue) to a chargeable party and approval state.

### Fields per inventory item

- `name` (e.g. "TV remote")
- `expected_quantity` (default 1)
- `unit` (default `each`)
- `is_active` (false = retired from this property)
- `company_id`, `property_id`

### Fields per movement

- `movement_type`: `missing` | `damaged` | `restocked` | `returned` | `replaced`
- `quantity` (positive integer)
- `notes` (free text)
- `recorded_by` (user id)
- `inspection_id` (the source inspection, if any)
- Photos: linked via `photos.inventory_movement_id`

### Fields per accountability record

- `source_type`: `inspection_item` | `issue` | `inventory_movement` | `maintenance_job` | `guest_recovery_task`
- `source_id`: the id of that source row
- `chargeable_party`: `none` | `guest` | `owner` | `company` | `contractor` | `pending_decision`
- `estimated_amount` (optional decimal)
- `actual_amount` (optional decimal)
- `approved_by` / `approved_at`
- `notes`
- **Cost recovery cascade fields (added in v1.1 — see "Cost recovery cascade" section below):**
  - `recovery_status`: `not_attempted` | `guest_attempted` | `guest_paid` | `ota_attempted` | `ota_paid` | `company_absorbed` | `owner_charged` | `closed`
  - `recovery_attempts_count`: integer
  - `linked_recovery_task_id`: FK to `guest_recovery_tasks` if applicable
  - `final_chargeable_party`: set only when fully resolved
  - `absorbed_reason`: required when `chargeable_party = 'company'` as a fallback

### Lifecycle of an inventory loss

1. Inspector finds the TV remote missing during a post-stay inspection.
2. Inspector marks the inventory line item as **Missing** and adds a photo of the empty spot.
3. The system creates an `inventory_movement` (`movement_type = missing`, `quantity = 1`).
4. Inspector can optionally suggest a `chargeable_party` (e.g. `guest`), but this is **just a suggestion** — it is not yet binding.
5. Ops Manager or above reviews the inspection.
6. Ops Manager creates an `accountability_record` linked to that movement, sets `chargeable_party`, fills `estimated_amount`, and clicks **Approve**.
7. Approval writes an audit event (`accountability.approved`) with the actor's user id and timestamp.
8. The approved record is now eligible to roll into the owner's monthly summary (if `chargeable_party = owner`) or the OTA evidence pack (if `chargeable_party = guest`).
9. If the company later recovers the cost (e.g. Airbnb pays out), `actual_amount` is updated and `recovered = true` is set, with another audit event.

### Hard rules

1. **Inspectors propose; managers approve.** Inspectors never finalise a chargeable party.
2. **Every chargeable approval is audited.** No exceptions.
3. **No silent edits to approved records.** Editing an approved record requires unapproval first, which is itself audited.
4. **Photos are mandatory for any non-zero charge.** A missing-item movement without a photo cannot be approved as chargeable.
5. **Owner-chargeable approval is the highest gate.** Approval requires Ops Manager, GM, or Company Admin.

### Edge cases

| Situation | Behaviour |
|---|---|
| Item marked missing on day 1, then found on day 3 | Create a `returned` movement; both rows remain in history. |
| Same remote missing in two consecutive inspections | Two movements exist; the second flags the first as still-open in the UI. |
| Inventory item retired (no longer in the apartment) | Set `is_active = false`. Historical movements stay. |
| Wrong charge approved by mistake | Manager opens the record, clicks "Unapprove" (audited), edits, reapproves (audited). The original approval timestamp is retained in audit. |
| Inspector deletes a photo before submitting | Allowed; nothing is logged because the inspection is still a draft. |
| Manager deletes a photo after approval | Not allowed in MVP. Only Company Admin, audited. |

### What we are NOT building in MVP for inventory

- Barcode / QR scanning.
- Stock levels across multiple storage rooms.
- Procurement / re-order workflows.
- Per-item depreciation tracking.
- Auto-price lookup from a vendor catalogue.

---

## Part 1.5 — Cost recovery cascade (the no-leakage principle)

### Why this part exists

Across a large portfolio, every Rand of damage and every Rand of replacement cost must end up paid by someone. If a guest doesn't pay, the company may try to recover via the OTA. If the OTA denies, the company either absorbs the cost or charges it to the owner. **No cost may silently disappear.** Without explicit tracking, costs leak across the portfolio and the founder loses track of who actually owes what.

This section defines the cascade: the ordered chain of attempts to recover a cost, with explicit resolution at the end.

### The cascade

```
   Guest direct  ──refuses/no response──►  OTA claim  ──denied/partial──►  Company absorb  ──or──►  Owner charge
       ▲                                         ▲                                ▲                       ▲
       │                                         │                                │                       │
   first attempt                          second attempt                  fallback decision        last resort
```

Important: the cascade is **not** linear in all cases. The relevant chain depends on the source:

- **Guest damage flag** (post-stay) → starts at guest direct, may cascade to OTA, to company, to owner.
- **Owner-chargeable wear/age** → goes directly to owner charge (subject to approval policy). No guest/OTA step.
- **Company error** (e.g., staff lost a key, broke something during cleaning) → goes directly to company absorb. No guest/owner step.
- **Maintenance from age/wear** → goes directly to owner charge. No guest/OTA.

The cascade only loops through guest → OTA → company → owner when the **source** is "guest damage" and the chargeable party is not yet finalised.

### Where the cascade lives

- `accountability_records` carries the **summary** of the final outcome — what was recovered, from whom, how much.
- `guest_recovery_tasks` carries the **task** — the work of contacting the guest, filing the OTA claim, etc. — for guest damage cases.
- `recovery_attempts` carries each **attempt** — guest message sent at, response at, outcome.

When a flag is created with type `guest_damage`, the system creates BOTH a `guest_recovery_tasks` row AND an `accountability_records` row. The accountability record's `linked_recovery_task_id` points to the task. As the task progresses through `recovery_attempts`, the accountability record's `recovery_status` and `final_chargeable_party` are updated.

For non-guest sources (owner-chargeable wear, company error, etc.) only an `accountability_records` row is created; no `guest_recovery_tasks` row is needed.

### Transition rules

| From state | Action | To state | Who can do this |
|---|---|---|---|
| `not_attempted` | Mark guest notified | `guest_attempted` | Coordinator, Ops Manager, GM, Company Admin |
| `guest_attempted` | Guest paid in full / partial | `guest_paid` (closed) | Coordinator+ |
| `guest_attempted` | Guest refused / no response in 24h | (manual transition) → `ota_attempted` | Coordinator+ |
| `ota_attempted` | OTA paid in full / partial | `ota_paid` (closed) | Coordinator+ |
| `ota_attempted` | OTA denied | (manual decision) → `company_absorbed` OR `owner_charged` | Ops Manager+ |
| `not_attempted` (non-guest source) | Decide chargeable party | directly `owner_charged` OR `company_absorbed` | Ops Manager+ (subject to approval policy) |
| `owner_charged` | Owner approves (if cap hit) | `closed` | Ops Manager+ records owner response |
| `owner_charged` | Owner rejects | back to `not_attempted` for re-decision | Ops Manager+ |
| `company_absorbed` | Reason recorded | `closed` | Ops Manager+ |

The `closed` state requires `final_chargeable_party` to be set. The system blocks closure if it isn't.

### No-leakage rule (critical)

**An accountability record cannot be left in an unresolved state indefinitely.**

- Records in `not_attempted` for > 7 days surface on the Action Centre as "stale."
- Records in `guest_attempted` past their `deadline_at` surface as overdue.
- Records in `ota_attempted` for > 30 days surface as "OTA stale — decide fallback."
- Reports include a "leakage check" — any record older than 60 days without `final_chargeable_party` set is flagged for manager review.

This protects against the failure mode that the founder explicitly flagged: damage costs disappearing into the portfolio because nobody followed up on the recovery attempt.

### Approval policy intersection

The cascade interacts with the approval policy (`APPROVAL_LIMITS_AND_CONTRACT_RULES.md`):

- A guest-paid recovery is **not** subject to the owner-approval cap because the cost never lands on the owner.
- An OTA-paid recovery is **not** subject to the cap for the same reason.
- A **company-absorbed** outcome that exceeds the company's "absolute_block_above" cap requires GM or Company Admin approval. A small repair the company chooses to absorb as goodwill is normal; a R20,000 absorption is a business decision needing scrutiny.
- An **owner-charged** outcome goes through the full approval policy: single-item cap, monthly cap, annual cap. If any cap is breached, the charge enters `pending_owner_approval` and the owner-approval copy-paste workflow is triggered.

### Worked example

A R3,500 broken TV is flagged on a post-stay inspection as guest damage.

1. Flag created (`guest_damage`). System creates `guest_recovery_tasks` + `accountability_records` linked. `recovery_status = 'not_attempted'`.
2. Manager opens the task, sends guest message via copy-paste WhatsApp template. Records "sent" with screenshot evidence. `recovery_status = 'guest_attempted'`. `recovery_attempts_count = 1`.
3. Guest refuses to pay. Manager records response. `recovery_attempts_count = 2`.
4. Manager files Airbnb resolution centre claim with the copy-paste template. `recovery_status = 'ota_attempted'`. `recovery_attempts_count = 3`.
5. Airbnb pays R2,000 (partial). Manager records "paid_partial — R2000". `recovery_status = 'ota_paid'`, `actual_amount = 2000`. Outstanding R1,500.
6. Manager decides the outstanding R1,500 is owner-chargeable (TV is owner property; replacement is owner responsibility). Sets `chargeable_party = 'owner'` on a new linked accountability record for R1,500.
7. R1,500 is below Dropinn's R2,000 single-item cap. Manager approves directly. `final_chargeable_party = 'owner'`, `recovery_status = 'closed'`.
8. The R1,500 lands on the next monthly owner summary. The R2,000 Airbnb recovery is recorded for the company's books but does not appear on the owner summary.

Full audit trail captures every step.

### Worked example — company absorbs

Same TV, but the company decides to absorb the cost as a goodwill gesture because the owner is a new client.

1-5. As above through OTA partial pay.
6. Manager picks "Company absorb" for the outstanding R1,500 and records `absorbed_reason = 'New owner relationship — goodwill'`. `chargeable_party = 'company'`, `final_chargeable_party = 'company'`, `recovery_status = 'closed'`.
7. R1,500 lands on the company's internal P&L tracking (out of scope for MVP but the data is there). Does NOT appear on the owner summary.

### Worked example — no guest, just wear

A microwave dies after 4 years of use during a routine pre-arrival inspection.

1. Flag created (`maintenance_issue` + `owner_chargeable`). No `guest_recovery_tasks` row created (no guest involved).
2. Accountability record created with `chargeable_party = 'owner'` immediately. `recovery_status = 'not_attempted'`.
3. Quoted at R1,800 for replacement. Below Dropinn's R2,000 single-item cap. Manager approves.
4. `final_chargeable_party = 'owner'`, `recovery_status = 'closed'`.
5. Lands on the next monthly owner summary.

If the microwave replacement had been quoted at R2,500: the approval policy would force `pending_owner_approval`, the manager would send a copy-paste message to the owner, get sign-off, record it with screenshot, then close. Same cascade end state but with the owner-approval step in between.

---

## Part 2 — Maintenance MVP logic

### Goal

Track an issue from "an inspector noticed something" through "a technician fixed it" to "a manager verified it's actually fixed", with photo proof at both ends.

### Two-layer model

- **Issue** = the *problem statement* ("Tap in bathroom 2 is dripping").
- **Maintenance job** = the *work order* attached to that issue ("Plumber Joe scheduled Tuesday, R450 est.").

An issue can exist without a job (a small thing the inspector noted that hasn't been triaged yet). A job always belongs to one issue.

### Fields per issue

- `title`, `description`
- `property_id`
- `source_inspection_id` (optional), `source_inspection_item_id` (optional)
- `priority`: `low` | `med` | `high`
- `status`: `open` | `in_progress` | `resolved` | `verified` | `closed`
- `created_by`, `assigned_to`
- `owner_chargeable` (bool) + approval fields
- Photos: linked via `photos.issue_id`

### Fields per maintenance job

- `issue_id`
- `technician_id`
- `status`: `pending` | `scheduled` | `in_progress` | `done` | `verified`
- `estimated_cost`, `actual_cost`
- `scheduled_for` (date)
- `completed_at` (timestamp)
- `verified_at` (timestamp)
- `chargeable_party`: `none` | `guest` | `owner` | `company` | `contractor`
- `notes`
- Photos: linked via `photos.maintenance_job_id` with `entity_type = 'maintenance_before' | 'maintenance_after'`

### State machine: issue

```
   [open] ── assign ──► [in_progress] ── tech reports done ──► [resolved]
                                                                    │
                                                       manager verifies (with photo check)
                                                                    ▼
                                                              [verified]
                                                                    │
                                                          close after month-end
                                                                    ▼
                                                              [closed]
```

- `open → in_progress` happens when a job is created and a technician is assigned.
- `in_progress → resolved` happens when the technician marks the job done.
- `resolved → verified` requires a manager to confirm — usually with a follow-up inspection.
- `verified → closed` is a housekeeping move at month-end. Closed issues remain queryable.

A status can go **backwards** (e.g. `resolved → in_progress`) if verification fails. This is allowed, audited, and shows as a "reopened" badge.

### State machine: maintenance job

```
   [pending] ── assign tech + date ──► [scheduled] ──► [in_progress] ──► [done] ──► [verified]
```

Each transition writes an audit event.

### Workflow — happy path

1. Inspector flags "Tap dripping" on a post-stay inspection with two photos.
2. After submit, the manager opens the inspection, taps the flagged item, and clicks **"Create issue"**. Title, property, and photos pre-fill.
3. Manager sets priority `med` and assigns to Maintenance Coordinator.
4. Coordinator creates a job: technician = Joe, scheduled = Tuesday, estimated cost = R450, chargeable_party = `owner`.
5. Owner-chargeable flag set on the issue. Ops Manager approves (audited).
6. Tuesday: Joe opens the app on his phone, sees his job list, taps the job, and reads the description with the two "before" photos.
7. Joe fixes the tap, takes two "after" photos, updates `actual_cost` to R420, and marks the job **done**.
8. Manager opens a follow-up inspection later in the week, ticks the item as OK with a verification photo, and marks the issue **verified**.
9. The accountability record (R420 actual, owner-chargeable) rolls into next owner monthly summary.

### Hard rules

1. **A maintenance job cannot be marked `done` without at least one "after" photo.**
2. **A job cannot be marked `verified` without manager action.** A technician cannot verify their own work.
3. **Cost changes after `verified` require Company Admin and are audited.**
4. **Owner-chargeable flag on an issue requires manager approval before it can roll into a summary.**
5. **Soft delete only.** Issues and jobs are never hard-deleted in MVP except by Super Admin (audited).

### SLA / due dates (v1 vs v1.5)

| Capability | MVP v1 | v1.5 |
|---|---|---|
| Set a due date on a job | ✅ | ✅ |
| Visual flag "overdue" in the list | basic | richer dashboard |
| Per-priority default SLAs | ⬜ | ✅ |
| SLA breach notifications (email) | ⬜ | ✅ |

### Edge cases

| Situation | Behaviour |
|---|---|
| Tech marks job done but uploads no "after" photo | Save fails with a clear error; tech cannot transition state. |
| Manager verifies, then property owner disputes | Manager can reopen the issue (audited). New evidence can be added. |
| Same issue keeps recurring at the same property | Visible as repeated rows; v1.5 adds a "recurrence" indicator. |
| Tech rejects the assignment | Status goes back to `pending`; coordinator reassigns. |
| Multiple jobs against one issue (e.g. plumber + electrician) | Allowed. Each job has its own state. The issue is `verified` only when all its jobs are `verified`. |
| Estimated cost in ZAR but actual paid in another currency | MVP stores a single numeric amount; currency is implicitly the company's. Multi-currency is post-MVP. |

### What we are NOT building in MVP for maintenance

- Recurring scheduled maintenance (e.g. quarterly aircon service).
- Vendor / contractor catalogues with rates.
- Parts inventory tracking.
- Calendar integration with technicians' personal calendars.
- Automated dispatching by priority/distance.
- SMS/WhatsApp notifications to technicians (manual notification in MVP).

---

## Cross-cutting: accountability summary

When the monthly cycle runs (manual button in MVP — see `REPORTING_REQUIREMENTS.md`):

1. Find all approved `accountability_records` for a (company, property, month) where `chargeable_party = 'owner'`.
2. Pull the linked source (inspection item, issue, movement, or maintenance job) and its photos.
3. Aggregate amounts (`estimated` if no `actual`, otherwise `actual`).
4. Build the `owner_monthly_summary` with its line items.
5. The manager reviews and clicks "Send" — only then does the summary become visible to the Owner Viewer.

This deliberately keeps the **human in the loop** on every owner-facing dollar (rand).
