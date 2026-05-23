# FLAG_AND_ACTION_MODEL.md

## Plain-English overview

A **flag** is anything anyone notices about an apartment that might need attention. Some flags are nothing (a slightly crooked picture). Some are urgent (a gas leak). Some are money (a broken TV). The product's job is to give every flag exactly one home so nothing is lost and nothing gets stuck in WhatsApp.

This document defines:

- The taxonomy of flag types.
- The lifecycle of a flag (raised → triaged → actioned → closed).
- The conversion paths (a flag can become an issue, a maintenance job, an inventory movement, an accountability record, a guest recovery task, an owner charge line, or nothing).
- Who can do what at each step.

---

## Why a flag taxonomy matters

Before this model: flags are just "Damaged / Missing / Attention." That collapses too many real-world cases into the same bucket:

- A wall scuff and a cracked microwave both look like "Damaged" — but one is a R0 condition note and the other is a R3,500 guest recovery candidate.
- A missing TV remote and a missing safety door key both look like "Missing" — but one is a R150 inventory replacement and the other is a same-day safety issue.
- "Attention" is so vague it becomes a dumping ground.

After this model: the inspector picks the *type* of flag at capture. The system then automatically suggests the right next action, the right approval gate, and the right photo retention class.

---

## The taxonomy (11 flag types)

| # | Flag type | Plain English | Auto-suggested action |
|---|---|---|---|
| 1 | **Condition / status note** | "Just noting how this thing currently looks. Not a problem." | None — record only. |
| 2 | **Cleaning issue** | "Needs cleaning beyond normal turnover." | Cleaning task (v1.5) or follow-up cleaning inspection. |
| 3 | **Maintenance issue** | "Something is broken or worn." | Create issue → maintenance job. |
| 4 | **Inventory missing** | "Item that should be here is not here." | Inventory movement (`missing`). |
| 5 | **Inventory damaged** | "Item is here but broken." | Inventory movement (`damaged`). |
| 6 | **Guest damage** | "Damage that looks caused by the most recent guest." | Guest recovery task + inventory or maintenance issue. |
| 7 | **Owner-chargeable** | "Wear, age, or owner responsibility — chargeable to owner." | Accountability record, owner-chargeable. |
| 8 | **Company responsibility** | "Company absorbs this — staff error, gesture, etc." | Accountability record, company-chargeable. |
| 9 | **Safety / urgent** | "Smoke alarm, gas, lock, electrical, water leak." | Same-day issue, high priority, manager notified. |
| 10 | **Follow-up required** | "Not actionable now; check again next inspection." | Carried to next inspection on this property. |
| 11 | **No-action record** | "I saw it, it's fine, but I want a record." | None — record only. |

Notes:

- A single inspection line item can carry multiple flags (e.g., "Inventory damaged" + "Guest damage" + "Owner-chargeable if guest doesn't pay").
- Types 1, 10, and 11 produce zero downstream work — they exist so that "no problem found" is a deliberate, recorded decision, not a silent omission.
- Type 9 (Safety/urgent) is the one type that **bypasses normal triage** and lands directly in the Action Centre as a red banner.

---

## Flag lifecycle

```
   [raised]  ──triage──►  [classified]  ──convert──►  [actioned]  ──resolve──►  [closed]
                                                          │
                                                          └── or [no_action] for types 1, 10, 11
```

| State | Meaning | Who can move it forward |
|---|---|---|
| `raised` | An inspector or any field user logged it. Type may not be set yet. | Inspector (set type), or Manager. |
| `classified` | Type chosen. Awaiting conversion or no-action decision. | Manager, Coordinator, Ops Manager. |
| `actioned` | Has been converted to an issue / job / movement / recovery / charge / no-action. | Auto-set by the system on conversion. |
| `closed` | Underlying work is done OR the no-action decision was confirmed. | Manager on resolution, or system on linked work close. |
| `no_action` | Deliberately closed without downstream work (types 1, 10, 11). | Manager confirms; audited. |

A flag in `classified` longer than its SLA shows up red on the Action Centre. Default SLAs:

| Type | Default classification SLA | Default action SLA |
|---|---|---|
| Safety / urgent | Immediate (manager notified on raise) | 4 hours |
| Guest damage | 2 hours | Same day (24h post-checkout) |
| Maintenance issue | 24 hours | per priority |
| Inventory missing / damaged | 24 hours | next monthly summary |
| Owner-chargeable | 48 hours | next monthly summary |
| Cleaning issue | 24 hours | next turnover |
| Condition note / Follow-up / No-action | 7 days | n/a |

SLAs are **company-configurable** (post-v1.0); defaults ship with the product.

---

## Conversion paths

Every classified flag has one or more "convert to" buttons. The system pre-fills as much as possible.

| From flag type | Can be converted to |
|---|---|
| Maintenance issue | Issue → Maintenance job |
| Inventory missing | Inventory movement (`missing`) + optional Accountability record |
| Inventory damaged | Inventory movement (`damaged`) + optional Accountability record |
| Guest damage | Guest recovery task + Inventory movement (if applicable) + Maintenance job (if applicable) |
| Owner-chargeable | Accountability record (owner) |
| Company responsibility | Accountability record (company) |
| Safety / urgent | Issue (high priority) + manager notification |
| Cleaning issue | Cleaning task (v1.5) or follow-up cleaning inspection |
| Condition note / Follow-up / No-action | Close as `no_action` with reason. |

A guest damage flag is the most expensive in terms of downstream work because it can simultaneously create three records: a guest recovery task, an inventory movement, and a maintenance job. The system creates them as a linked group so closing the recovery task surfaces the linked records.

---

## Where flags live in the data model

(See `DATABASE_SCHEMA_PLAN.md` for the full consolidated schema. Summary here for cross-reference.)

- `flag_categories` — the taxonomy table. Seeded with the 11 categories above. Company-extensible later.
- `flags` — every flag ever raised. Carries: `id`, `company_id`, `property_id`, `inspection_id` (optional), `inspection_item_id` (optional), `stay_id` (optional), `flag_category_id`, `status`, `severity` (low/med/high), `description`, `chargeable_party_decision` (set by manager triage), `raised_by`, `raised_at`, `classified_by`, `classified_at`, `actioned_at`, `closed_at`, `no_action_reason`.

**Important relationship direction (finalised in the consolidated schema):** the `flags` table does **not** carry `linked_issue_id` / `linked_movement_id` / etc. Instead, the relationship is **reversed** — each downstream table carries `parent_flag_id` pointing back to its parent flag:

- `issues.parent_flag_id`
- `maintenance_jobs.parent_flag_id`
- `inventory_movements.parent_flag_id`
- `guest_recovery_tasks.parent_flag_id`
- `accountability_records.parent_flag_id`

This is cleaner: one flag can have many children of the same kind without bloating the parent row, and the Action Centre can group children under a flag with a single join. The discipline and grouping behaviour are specified in **`DEDUPLICATION_AND_TASK_GROUPING_RULES.md`** — read it alongside this file.

A flag stays in `flags` for its entire life. The Action Centre lists **one card per flag** and rolls its children into a work strip; it never shows the same real-world problem as multiple independent rows. Base query: `SELECT * FROM flags WHERE status NOT IN ('closed','no_action') AND company_id = ?`, with children joined by `parent_flag_id`.

---

## Who can do what

| Action | Inspector | Coordinator | Ops Manager | GM | Company Admin |
|---|---|---|---|---|---|
| Raise a flag | ✅ | ✅ | ✅ | ✅ | ✅ |
| Set / change flag type at raise | ✅ | ✅ | ✅ | ✅ | ✅ |
| Re-classify after raise | ⬜ (only own flags pre-submit) | ✅ | ✅ | ✅ | ✅ |
| Convert flag → issue / movement / accountability | ⬜ | ✅ | ✅ | ✅ | ✅ |
| Convert flag → guest recovery task | ⬜ | ✅ | ✅ | ✅ | ✅ |
| Mark flag `no_action` | ⬜ | ✅ | ✅ | ✅ | ✅ |
| Reopen a closed flag | ⬜ | ⬜ | ✅ | ✅ | ✅ |
| Edit a flag's history | ⬜ | ⬜ | ⬜ | ⬜ | ✅ (audited) |

Inspectors raise; managers classify, convert, and close. This is the same approval-gating principle used elsewhere — field users propose, managers decide.

---

## Stupid-proof UX rules for flag capture

The flag taxonomy is only useful if the field team picks the right type without thinking. Rules:

1. **Pictures, not jargon.** Each flag type has an icon and a 3-word label ("Broken thing" / "Guest broke it" / "Missing item" / "Safety!"). The internal taxonomy name is hidden.
2. **One-tap default.** When an inspector taps "Add flag" from a line item, the most common type for that line item context is pre-selected (e.g., on a TV line item, "Inventory damaged" is pre-selected, but the field team can tap a different option).
3. **Safety is unmissable.** The safety option is red, on the right of the row, and has a different icon shape (octagon).
4. **No multi-select on first tap.** First tap commits a type. Adding a second type is a deliberate "+ another flag" action.
5. **Manager re-classification is invisible to the inspector.** The inspector's submitted flag is preserved in audit; the active type is the manager's.
6. **No taxonomy training required.** If we ever need to train an inspector on the 11 types, we've failed. Icons + context defaults must do it.

---

## What is NOT in v1.0 for flags

- The `cleaning_task` entity (covered by a cleaning issue type that's recorded but not yet auto-routed to housekeeping until v1.5).
- Company-customisable flag types (Dropinn can suggest custom ones; we seed the 11 and extend in v1.5 if customers ask).
- Per-property SLA overrides (v1.5).
- Bulk re-classification of historical flags (v1.5).
- AI-suggested flag type from the photo (v2+, gated behind `AI_FEATURE_ROADMAP.md` rules — never authoritative).

---

## Why this matters

The flag taxonomy is the single biggest UX bet in the product. If we get it right, the Action Centre becomes legible at a glance and Asana disappears from your operation. If we get it wrong, the Action Centre becomes a soup and the team keeps using WhatsApp.

Defaults, icons, and one-tap conversion are not optional polish — they are the difference between a working product and an unused one for a small unskilled team.
