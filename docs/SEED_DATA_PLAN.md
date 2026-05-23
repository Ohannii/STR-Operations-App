# SEED_DATA_PLAN.md

## Purpose

When a new company is created in the app, several things must auto-exist before the first user can do meaningful work: default templates, default flag categories, the default approval policy, and a default property inventory baseline. This document defines exactly what is seeded, when, and how.

The point is to avoid the "blank app on first login" problem where a Company Admin signs in and has no idea what to do because nothing exists yet.

---

## What is seeded on company creation

When a `companies` row is inserted, the system synchronously seeds:

1. **Roles** (already system-wide; not company-scoped — just referenced).
2. **Flag categories** — 11 rows of the standard taxonomy (`flag_categories` table; see `FLAG_AND_ACTION_MODEL.md`).
3. **Approval policy** — one row in `approval_policies` with `scope_type = 'company'` and the Dropinn-defaults.
4. **Inspection templates** — four rows in `inspection_templates`:
   - Turnover (combined post-stay + pre-arrival) — the default.
   - Pre-arrival only.
   - Post-stay only.
   - Annual audit.
5. **Template sections and items** — the seeded contents of each template (see below for the Turnover seed; the others follow the same pattern).
6. **`companies.seed_policy_applied = true`** — flag flipped so seeding never runs twice.

This happens inside a database transaction. If any seed insert fails, the company creation is rolled back.

---

## Flag categories seeded

The 11 categories from `FLAG_AND_ACTION_MODEL.md`:

| key | display_label | icon | severity_default | default_action |
|---|---|---|---|---|
| `condition_note` | "Just a note" | clipboard | low | no_action |
| `cleaning_issue` | "Cleaning needed" | broom | low | create_issue (v1.5) |
| `maintenance_issue` | "Broken thing" | wrench | med | create_issue |
| `inventory_missing` | "Item missing" | search-off | med | create_movement |
| `inventory_damaged` | "Item damaged" | broken-circle | med | create_movement |
| `guest_damage` | "Guest broke it" | user-x | high | create_recovery |
| `owner_chargeable` | "Owner pays" | wallet | low | create_accountability |
| `company_responsibility` | "Company pays" | building | low | create_accountability |
| `safety_urgent` | "Safety!" | alert-octagon | high | create_issue (urgent) |
| `follow_up_required` | "Check next time" | calendar-clock | low | no_action |
| `no_action_record` | "Just noting it" | bookmark | low | no_action |

These ship as system seed rows with `company_id IS NULL`. Each company inherits them at lookup time; per-company customisation is a v1.5 addition.

---

## Approval policy seeded

One row per new company:

| field | value |
|---|---|
| `scope_type` | `company` |
| `single_inventory_item_cap` | 1000.00 |
| `single_maintenance_item_cap` | 2000.00 |
| `single_owner_chargeable_cap` | 2000.00 |
| `monthly_owner_total_cap` | 2000.00 |
| `annual_owner_total_cap` | 60000.00 |
| `internal_approvable_below` | 0 |
| `internal_ceiling` | 2000.00 |
| `absolute_block_above` | 10000.00 |
| `active_from` | now() |
| `active_to` | NULL |
| `notes` | "Default policy seeded on company creation. Edit before approving any charges." |

A Company Admin sees a banner on first login until the policy is reviewed: *"Please review your approval policy before approving any charges."* The banner clears when any field on the policy is edited (any edit = "reviewed").

Per-market policy templates ("South Africa STR default," "Portugal STR default") are a v1.5 enhancement. v1.0 ships only the South Africa default because that's where the first customer is.

---

## Turnover template seeded contents

The Turnover template has six sections in this order:

### Section 1 — Previous guest damage check

- `Category check: walls` — `pass_fail`, `required_photo = if_flagged`, `required_note = if_flagged`
- `Category check: floors` — same
- `Category check: furniture` — same
- `Category check: appliance surfaces` — same
- `Category check: bedding` — same
- `Category check: bathroom fixtures` — same
- Free "any other damage" — `pass_fail`, `required_photo = if_flagged`

### Section 2 — Inventory check

- (Auto-populated at inspection-start time from `inventory_items` for this property.)
- Default `required_photo = if_flagged` per inventory item.

### Section 3 — Cleanliness

- Bins emptied
- Kitchen surfaces clean
- Bathroom scrubbed
- Floors mopped
- Beds made
- Linen fresh
- Glassware clean
- (All `pass_fail`, `required_photo = if_flagged`)

### Section 4 — Amenities present

- WiFi card visible
- Welcome book present
- Toiletries stocked (shampoo, conditioner, soap)
- Towels stocked
- Toilet paper stocked
- Tea/coffee/sugar stocked
- (All `pass_fail`, `required_photo = if_flagged`)

### Section 5 — Appliances working

- Oven heats up
- Stove burners work
- Microwave heats
- Kettle boils
- Water heats up (hot tap)
- Lights all working
- HVAC working (heating/cooling)
- (All `pass_fail`, `mandatory_individual = true`, `required_photo = if_flagged`)

### Section 6 — Maintenance / condition observations

- (Empty by default. Inspectors add one-off entries here.)
- "Add observation" affordance prominent in this section.

---

## Pre-arrival only template

Same as Turnover but starts at Section 3 (Cleanliness). Sections 1 and 2 are skipped because there's no previous guest. Inventory still appears in Section 2 (renumbered).

---

## Post-stay only template

Sections 1 + 2 + 6 only. No cleanliness or amenities (those belong to pre-arrival or to the next turnover).

---

## Annual audit template

Same six sections as Turnover, but with:

- Every inventory item set to `required_photo = always`.
- No `mandatory_individual = true` items skippable.
- Every appliance section item carries explicit individual photo evidence.
- Default photo retention class on the inspection = `annual_audit_evidence`.

UI for annual audit ships in v1.3; the template seed lands in v1.0.

---

## Property inventory seeding

When a new `properties` row is created:

- If the company has defined a "company standard inventory" template, the items are copied into the property's `inventory_items` rows.
- If not, the property starts with an empty inventory and the manager populates it manually before the first turnover.

The company standard inventory is a v1.2 feature. v1.0 / v1.1 ship without it; managers populate per-property inventory directly.

---

## What is NOT seeded

- **Users** beyond the first Company Admin (created by the signup flow itself).
- **Properties.** Each company must create their own.
- **Stays.** Created when inspections start or pulled from Hostaway (v1.5+).
- **Photos.** Captured during operations.
- **Flags / issues / accountability.** Operational, not seed.

---

## Test vs production seeding

Staging and production use the same seeding logic. There is no "test data" seeded in production. Demo data is only loaded into staging on explicit request via a script (`scripts/seed_demo_data.ts`, v1.0 if needed for field-test rehearsal; otherwise v1.5).

This protects against the failure mode of "developer accidentally seeded test apartments into the founder's live production database."

---

## How seeding is tested

In `TESTING_CHECKLIST.md`:

- [ ] On creating a fresh company, `flag_categories` rows exist (or are accessible via system seed).
- [ ] On creating a fresh company, an `approval_policies` row exists with Dropinn defaults and `seed_policy_applied = true`.
- [ ] On creating a fresh company, the four inspection templates exist.
- [ ] The Turnover template has the six sections in correct order.
- [ ] A Company Admin sees the "please review approval policy" banner until the policy is edited at least once.
- [ ] Seeding is idempotent: rerunning the seed on an existing company does not create duplicates.

---

## Future seed evolution

Things that will move into seed over time:

- Per-market approval policy templates (v1.5).
- Per-property-type starter inventory lists (v1.5: "Studio apartment starter inventory," "2-bedroom apartment starter inventory").
- Cleaning task templates (when housekeeping role lands, v1.5).
- Guest message templates (`recovery_templates`) — already implicit; v1.3+ may move into a configurable seed.

When something is added to the seed, this doc gets updated and `CHANGELOG.md` records the change.
