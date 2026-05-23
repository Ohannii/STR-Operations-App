# TEMPLATE_AND_INVENTORY_MODEL.md

## Plain-English overview

Two problems must be solved together:

1. **Templates** — A pre-arrival inspection for apartment 4B should ask the same 50 things every time, but the team should be able to customise that list per apartment because every apartment is slightly different (some have a Jacuzzi; some don't).
2. **Inventory** — Apartment 4B has 30 items; apartment 5A has 35; some overlap, some don't. The inspection must check the *right* items for *this* apartment, not a generic list.

The model: **company-level standard templates** that all properties start with, then **property-level overrides** that customise per apartment, plus a **per-property inventory list** that is the source of truth for what should be in this specific apartment.

---

## The four template kinds (seeded on company creation)

| Template kind | Default? | Used for |
|---|---|---|
| Turnover (combined post-stay + pre-arrival) | ✅ default for most ops | Standard back-to-back inspection between guests |
| Pre-arrival only | ✅ seeded but optional | When no post-stay is needed (e.g., apartment was vacant) |
| Post-stay only | ✅ seeded but optional | When pre-arrival is being done separately (rare) |
| Annual audit | ✅ seeded as v1.0 schema; UI in v1.3 | Once per year deep review |

The **Turnover** template is the default operational template, because the real-world workflow is combined (see `TURNOVER_INSPECTION_WORKFLOW.md`). The split pre-arrival-only and post-stay-only templates exist for edge cases.

Custom templates can be created by Company Admin in v1.3 (template editor). v1.0 ships with the four seeded templates and no editing UI; companies use what they get.

---

## Three-layer template model

```
   System defaults (Anthropic-shipped baselines per template kind)
        │
        ▼
   Company standard templates  ← Company Admin edits this layer in v1.3
        │
        ▼
   Property overrides          ← Manager edits this per-apartment
        │
        ▼
   Inspection snapshot         ← Frozen at the moment an inspection starts
```

1. **System defaults** — sensible baselines we ship. For example, Turnover comes pre-loaded with sections "Cleanliness," "Amenities," "Inventory check," "Maintenance flags." Read-only at the system layer.
2. **Company standard templates** — each company starts with copies of the system defaults. Company Admin can edit them centrally. Changes apply to all properties using that company standard.
3. **Property overrides** — managers can copy a company standard down to a single property and customise (add items, remove items, mark items as not-applicable, change required-photo settings). Changes apply only to that property.
4. **Inspection snapshot** — when an inspection starts, the relevant template (with property overrides applied) is **snapshotted** into the inspection's sections and items. Future template edits do not change historical inspections.

The data model (see `DATABASE_SCHEMA_PLAN.md` for the consolidated final shape):

- `inspection_templates` — company-level master records.
- `inspection_template_sections` — sections inside a master template.
- `inspection_template_items` — line items inside a section.
- `property_template_overrides` — per-property additions / removals / changes against a company template.
- `inspections` carries `template_id`, `template_version_id` so a snapshot is reproducible.
- `inspection_sections` and `inspection_items` are the per-inspection snapshot rows.

---

## How a property template is copied from a company standard and customised

1. Company Admin creates the company standard "Turnover" template. Has 50 items across 6 sections.
2. Manager assigns apartment 4B to "Turnover."
3. By default, apartment 4B uses the company standard as-is. No override row exists. Inspections of 4B snapshot directly from the company standard.
4. The manager realises apartment 4B has a Jacuzzi that isn't on the standard template. She taps "Customise template for this apartment."
5. A property override is created (`property_template_overrides` row). It is initially empty (= no diff vs the standard).
6. The manager adds a new line item: "Jacuzzi — clean and running." Tags it `category = amenity`, `required_photo = true`.
7. The override now contains the added item. Inspections of 4B from this point on include the Jacuzzi check; other apartments don't.
8. If the company standard later changes, the override still applies on top. Adds, removes, and edits are merged at snapshot time.

Removing an item from the standard for one property is also supported. The override row marks the item as `is_excluded = true` for this property. The line item still exists on the company standard for other properties.

---

## Per-apartment inventory list

The inventory list per apartment is **not** the same as the inspection template, but it feeds into specific inspection sections.

- `inventory_items` table — per-property catalogue of expected items: "TV remote × 1," "Bed sheets queen × 2," "Coffee mugs × 4."
- Each item carries: `name`, `expected_quantity`, `unit`, `is_active`, `category` (optional), `replacement_cost_estimate` (optional), `notes`.
- Categories: `kitchen`, `bathroom`, `bedroom`, `living_room`, `outdoor`, `safety`, `other`.

When a turnover or annual audit inspection runs:

- The system pulls the property's active `inventory_items` rows.
- They are rendered as line items inside the "Inventory check" section of the inspection.
- The inspector marks each item: `present` / `missing` / `damaged` / `extra` / `mark all OK for category`.
- Flagging an item `missing` or `damaged` creates an `inventory_movement` (and optionally an accountability record) — child of the parent flag.

Inventory differs per apartment by design. Apartment 4B has a Jacuzzi; apartment 5A has a balcony heater. The inventory list is the per-apartment ground truth.

---

## Company standard inventory list

A "company standard inventory" is a baseline list a Company Admin can define ("every apartment should at least have: bed sheets, towels, mugs, kettle, microwave"). When a new property is created, the company standard is **copied** into the property's `inventory_items` rows. From that moment on, the property's list is independent — adding to one doesn't change the other.

This is a one-way copy. v1.0 doesn't support live propagation of standard changes to existing properties (that would risk overwriting per-property customisations). v1.5 may add an opt-in "apply standard updates" flow.

---

## Item categories (used in templates and inventory)

For inspection line items:

| Category | Example items | UX colour |
|---|---|---|
| `cleanliness` | "Floors clean," "Bins emptied," "Bathroom scrubbed" | green |
| `amenities` | "WiFi password card present," "Towels stocked," "Toiletries restocked" | blue |
| `appliances` | "Oven working," "Stove working," "Water heats up," "Microwave heats" | orange |
| `inventory` | (Auto-populated from `inventory_items`) | grey |
| `maintenance` | "Tap dripping," "Door hinge loose," "Light bulb out" | red |
| `safety` | "Smoke detector test," "Gas check," "Lock function" | red, urgent |
| `condition` | "Wall scuff," "Existing wear" (record-only) | neutral |
| `custom` | One-off audit items | neutral |

Categories drive: UI grouping, colour, default required-photo rules, default required-note rules, default flag-type suggestions.

---

## Item check modes

Each template item has a `check_mode`:

| Check mode | UX behaviour |
|---|---|
| `pass_fail` (default) | Tap "OK" or "Flag." OK requires nothing more. Flag opens the flag-raising flow. |
| `numeric` | Enter a number (e.g., "Towels in linen cupboard"). Compare to expected count from inventory. |
| `text` | Required short text answer (e.g., "Last cleaned by"). Rare. |
| `photo_required` | Must capture at least one photo to satisfy. |
| `multi_state` | Pick from a defined set (e.g., "Excellent / Good / Fair / Poor"). |

Default `check_mode` is `pass_fail`. Other modes are used sparingly because they slow the inspection. Safety items are typically `pass_fail` plus `photo_required`.

---

## Mandatory one-by-one checks

Some items cannot be bulk-OK'd. Even on a busy turnover with Mark-All-OK enabled, the inspector must tap each of these individually.

Items marked `mandatory_individual = true` are the **non-bulkable** ones. Defaults:

- Anything with `category = safety` (smoke detector, gas, locks).
- Anything in `category = appliances` (oven, stove, water heating).
- Anything explicitly flagged by the Company Admin as "must check individually."

The inspector cannot tap "Mark all OK" for a section that contains any mandatory-individual items without addressing those items first. The UI greys out the bulk action and shows "Section contains items that must be checked individually."

---

## Section-level "Mark all OK"

The big speed win. A 12-item "Cleanliness" section where everything is fine should not cost 12 taps.

UX:

- Each section header has a **"Mark all OK"** button.
- Tapping it sets every non-flagged, non-mandatory-individual item in the section to `OK` in one action.
- A small confirmation appears: "Marked 9 items OK. 3 still need individual check."
- Items requiring individual check remain unchecked.
- The inspector still tap-tap-taps the 3 individual ones.

This is the difference between a 45-second clean section and a 5-second clean section.

Audit log records that the section was bulk-OK'd, by whom, at what timestamp — so a manager can spot inspectors who bulk-OK everything indiscriminately.

---

## Item-level required-photo rules

Each template item has `required_photo`:

| Value | Meaning |
|---|---|
| `none` (default) | Photo optional. Most items. |
| `if_flagged` | Photo required only when the item is flagged. (Encourages photo evidence on problems without forcing photos for OK items.) |
| `always` | Photo required regardless of status. Used for safety items and high-evidence items. |
| `multi_required` | At least N photos required (configurable). |

`if_flagged` is the most useful default for most items. Inspector marks OK → moves on; flags an issue → must take a photo.

---

## Item-level required-note rules

Same structure with `required_note`:

| Value | Meaning |
|---|---|
| `none` (default) | Note optional. |
| `if_flagged` | Note required only when item is flagged. |
| `always` | Note required regardless of status. |
| `if_flagged_and_type_in` | Note required only for certain flag types (e.g., guest_damage). |

`if_flagged` is the most useful default. We don't want inspectors writing essays about every OK item.

---

## Record-only observations

Some items are notes-for-history-only:

- "Pre-existing wall scuff in entrance."
- "Couch has light wear consistent with normal use."
- "Light fixture in bedroom 2 is slightly crooked but functional."

These need to be captured so they appear in the apartment's history (and so they can't be later mistaken for new damage), but they should NOT appear on the Action Centre as open work.

UX:

- Inspector taps "Add observation" rather than "Add flag."
- An observation creates a flag with `category = condition_note` (or `no_action_record`).
- The flag is immediately set to `status = no_action` with the observation as its description.
- It does not appear in the Action Centre's open queue.
- It is still searchable in the property's history.
- It is still included in the apartment's annual audit baseline.

Observations can be **promoted to flags** later if a manager decides "actually, that scuff needs fixing." The promotion writes an audit event and brings the row into the active queue.

---

## Custom one-off audit checks

Sometimes a manager wants to add an inspection item for one specific inspection — "Check the new doorbell installed last week" — without changing the property's template.

UX:

- Inside an in-progress inspection, an inspector or manager taps "Add one-off check."
- They type a short title.
- Tap "Save."
- The item appears at the end of the relevant section.
- It is treated as an inspection_item with `is_one_off = true`. It is **not** propagated to the template.

This is the safety valve: when life surprises the team, they don't have to choose between "ignore it" and "edit the template forever."

---

## How template edits avoid changing historical inspections

The rule: **inspections are snapshots.** Once started, the template is frozen for that inspection.

Implementation:

- `inspection_templates` and `inspection_template_sections` and `inspection_template_items` carry a `version_id` that is incremented on save.
- An inspection records the `template_version_id` it was started against.
- The actual inspection rows in `inspection_sections` and `inspection_items` are **copied** from the template at start time. They are independent rows. Editing the template later does not retroactively modify them.
- Re-rendering an inspection report years later produces the same output every time.

A template edit on the company side is therefore safe to do mid-day; no in-flight inspection is affected.

A property-level override is the same: each override row is versioned, and inspections snapshot the version active at start time.

---

## How template version diff is rendered (v1.3+)

When Company Admin edits a template, the editor shows a diff view: "Added 1 item, removed 2 items, changed 1 photo requirement." This protects against accidental destructive edits.

Pushing a version live writes an audit row with the diff payload. Audit trail shows: "Sipho changed Turnover template at 14:23: added 'Jacuzzi clean' to section Amenities."

---

## Annual audit template specifics

The annual audit template:

- Is more thorough than turnover (every inventory item must be individually checked; no Mark-All-OK).
- Default `required_photo = always` for every inventory item and every appliance.
- Default `required_note` is `if_flagged`.
- Generates `annual_audit_evidence` photos (longest retention class: 7 years).
- Schema lands in v1.0 (as a template kind). UI for running annual audits ships in v1.3 unless founder accelerates it.

The annual audit pulls from the property's `inventory_items` directly. It is the formal source of "what is in this apartment as of [date]." It is the baseline an OTA dispute six months later can reference.

---

## What is NOT in v1.0 / v1.1

- **Template editor UI.** v1.3. v1.0 ships the four seeded templates as-is. Founder can request a template change verbally; we update the seed.
- **Property override UI.** v1.3 alongside the editor.
- **Cross-property template propagation.** v1.5+. Templates are copied at property creation, not synchronised live.
- **Template marketplace** (sharing templates between companies). Out of scope for MVP entirely.
- **Conditional items** (show item X only if item Y was flagged). v2+.

What does ship in v1.0:

- Four seeded templates.
- Per-property `inventory_items` rows that an inspection can render.
- Property-level overrides via the schema (no editor; founder can request changes).
- Mark-All-OK at section level.
- Required-photo and required-note rules per item.
- Record-only observations.
- One-off audit items inside an in-progress inspection.

---

## Why this matters

The product fails if inspections are slow. Inspections are slow when they ask too much. Mark-All-OK + per-property inventory + record-only observations are the three features that turn a 30-minute generic inspection into a 10-minute apartment-specific one.

The three-layer template model is also the product's growth path. Right now you have one company (the founder's). When the second company joins, they want their own standards without affecting yours. The model is already built for that without retrofitting.
