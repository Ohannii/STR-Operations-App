# APPROVAL_LIMITS_AND_CONTRACT_RULES.md

## Plain-English overview

Different management companies have different contracts with different owners. Some contracts say: "The management company can spend up to R2,000 on the owner's behalf without asking. Anything bigger needs the owner to approve."

The app must respect these limits automatically. If a manager tries to approve a R3,000 repair on behalf of the owner, the app should:

1. Block the approval as "internal-only" — managers cannot fully approve a charge above the contract limit.
2. Route it to an "Owner approval pending" state.
3. Generate a copy-paste message the manager can send to the owner.
4. Once the owner approves (in person, by WhatsApp, by email), the manager marks the owner-approval as captured and the charge is then approved.
5. Audit every step.

These limits must be **configurable per company, per owner, per property, and per category**, because real contracts vary.

---

## Dropinn — the first example policy

Dropinn cannot internally approve:

- Any single inventory item above **R1,000**.
- Any single maintenance item above **R2,000**.
- Total owner-chargeable items above **R2,000 per month** for a property.
- Total owner-chargeable items above **R60,000 per year** for a property.

Anything over those caps must be routed to the owner for approval before it can become a final charge. The audit trail must show: when it was raised, when it crossed the cap, when the owner was asked, when they answered, and the final outcome.

These limits should ship as the **default policy** for any company set up with "STR management — South African market" template, and can be edited by Company Admin.

---

## Policy levels

The app supports four levels of policy, applied in this precedence:

1. **Property override** (highest priority — most specific)
2. **Owner override** (a specific owner across all their properties)
3. **Company default** (a default for all properties in a company)
4. **System fallback** (used if a company has not set anything yet — Dropinn limits are the seeded fallback for the South African market)

A policy lookup for "can I approve this R1,800 maintenance job for property X" runs the levels top-down and uses the first one it finds that has a value for the relevant cap.

---

## Cap types

A policy can set caps on any of these:

| Cap | Applies to | Example |
|---|---|---|
| `single_inventory_item_cap` | One inventory item charge | R1,000 |
| `single_maintenance_item_cap` | One maintenance job total | R2,000 |
| `single_owner_chargeable_cap` | Any single owner-chargeable line | R2,000 |
| `monthly_owner_total_cap` | Sum of approved owner charges for one property in one calendar month | R2,000 |
| `annual_owner_total_cap` | Sum of approved owner charges for one property in one rolling 12 months | R60,000 |
| `category_cap` | A per-category override (e.g., "appliances" capped at R3,500 even if global is R2,000) | flexible |

Caps not set at any level mean "no cap" — but the app warns Company Admin in setup if any of the four headline caps are unset for a new company.

---

## Three approval ceilings, not one

A naïve model has a single approval level. Real life needs three:

1. **`internal_approvable_below`** — Manager+ can approve up to this amount on their own. Default: R0 (i.e., any chargeable line needs at least a manager approval); typical companies set this to a small "comfort" amount (e.g. R200) so trivial charges don't require ceremony.
2. **`internal_ceiling`** — Manager+ can approve up to this amount without owner sign-off. Above this, the charge enters `pending_owner_approval` state. *Dropinn maintenance example: R2,000.*
3. **`absolute_block_above`** — Above this amount, the charge cannot be approved by anyone in the app without escalation to Company Admin or GM. Used to catch typos. Default: 5× the internal ceiling.

A charge of R1,500 (under R2,000) → manager can approve, done.
A charge of R3,000 → manager can mark "ready for owner approval"; the system blocks final approval until the owner confirms.
A charge of R30,000 → blocked at the UI level; requires GM + Company Admin to override (audited).

---

## Data model

(See `DATABASE_SCHEMA_PLAN.md` for the full schema. Summary here.)

### Table: `approval_policies`

Holds policies at any level (company / owner / property / category).

Key fields:

- `id` (uuid)
- `company_id` (every policy is scoped to one company)
- `scope_type` — `'company'` | `'owner'` | `'property'` | `'category'`
- `scope_id` — id of the owner, property, or category (NULL for `scope_type = 'company'`)
- `category` — when `scope_type = 'category'`, the category name (e.g. "appliances")
- `single_inventory_item_cap` (decimal, nullable)
- `single_maintenance_item_cap` (decimal, nullable)
- `single_owner_chargeable_cap` (decimal, nullable)
- `monthly_owner_total_cap` (decimal, nullable)
- `annual_owner_total_cap` (decimal, nullable)
- `internal_approvable_below` (decimal, default 0)
- `internal_ceiling` (decimal, nullable)
- `absolute_block_above` (decimal, nullable)
- `active_from`, `active_to` (so policy changes are time-aware)
- `notes` (free text)
- `created_by`, `created_at`, `deleted_at`

### Table: `approval_decisions`

Every approval action writes here (separate from the general `audit_events` table because these have structured fields for limits).

Key fields:

- `id`
- `company_id`, `property_id`
- `subject_type` — `'accountability_record'` | `'maintenance_job'` | `'inventory_movement'`
- `subject_id`
- `amount` (decimal)
- `policy_used_id` (FK to `approval_policies`)
- `cap_breached` — `'none'` | `'single_item'` | `'monthly_total'` | `'annual_total'` | `'category'` | `'absolute'`
- `decision` — `'approved'` | `'pending_owner'` | `'owner_approved'` | `'owner_rejected'` | `'blocked'` | `'overridden'`
- `decided_by` (user id)
- `owner_response_method` — `'in_person'` | `'whatsapp'` | `'email'` | `'sms'` | `'phone'` | `'app'` (when v1.5+) | NULL
- `owner_response_evidence_path` (storage path for screenshot/photo of owner agreement)
- `decided_at` (timestamp)
- `override_reason` (required when `decision = 'overridden'`)

This table also feeds the monthly cap calculation: "for property P, in month M, sum of approved owner-chargeable amounts."

---

## Cap calculation rules

These are the rules the app uses to decide whether a new charge crosses a cap.

1. **Single-item caps** are checked at approval time. The amount being approved is compared to the cap.
2. **Monthly total caps** are computed as: sum of `amount` for `approval_decisions` rows where `subject` is owner-chargeable, `decision IN ('approved', 'owner_approved')`, `property_id = X`, and the underlying record's chargeable month is the current month. Pending charges do NOT count toward the monthly cap.
3. **Annual total caps** are rolling 12 months from the current date, same approach.
4. **Category caps** apply only when the subject record has a category assigned (categories are an optional refinement; for v1.0 the headline four caps are enough).
5. **A charge that would cross a cap when approved must be saved in `pending_owner_approval` first**, never silently approved. The audit row is written immediately.

---

## Workflow when a cap is hit

Imagine a manager trying to approve a R3,000 owner-chargeable maintenance job under Dropinn's policy.

1. Manager clicks "Approve" on the R3,000 maintenance job.
2. The app checks the policy: `single_maintenance_item_cap = R2,000`. The charge exceeds it.
3. The app sets the job's accountability record to `pending_owner_approval`. Writes an `approval_decisions` row with `decision = 'pending_owner'`, `cap_breached = 'single_item'`.
4. The app shows the manager a **copy-paste message** template, pre-filled:

   > Hi [Owner first name], we have an upcoming maintenance job at [Property name]: [short description]. The estimated cost is R3,000. Under our agreement, charges above R2,000 need your sign-off. Please reply "Approved" or "Declined", or let us know if you'd like to discuss. Photos attached.

5. Manager copies, sends via WhatsApp / email / whatever. (No API integration needed in MVP.)
6. Manager comes back, picks the owner's response (`approved` / `rejected`), uploads a screenshot or photo of the owner's reply as evidence, and confirms.
7. App writes a second `approval_decisions` row: `decision = 'owner_approved'`, `owner_response_method = 'whatsapp'`, `owner_response_evidence_path = <path>`.
8. The accountability record moves to `approved` and is eligible for the next monthly summary.
9. Audit trail shows the full chain: raised → cap hit → owner asked → owner approved → final approval.

If the owner rejects: the accountability record moves to `rejected_by_owner`. The cost recovery cascade (`INVENTORY_AND_MAINTENANCE_LOGIC.md`) decides what happens next — usually the company absorbs it, or the work is cancelled.

---

## Monthly cap behaviour

For Dropinn's R2,000/month cap on owner charges per property:

- The first charge of the month is checked against `single_*_cap` only — there's no running total yet.
- The second, third, … charges are checked against the running total of approved charges this month.
- If a new charge would push the total above R2,000, it goes to `pending_owner_approval` regardless of its individual size. Example: R800 + R900 + R600 in the same month — the third one trips the monthly cap and needs owner sign-off.
- Owner-approved charges count toward the cap.
- Once the month rolls over, the running total resets.

The Action Centre shows a per-property "spend so far this month" widget for managers.

---

## Annual cap behaviour

Same logic, rolling 12 months. For Dropinn's R60,000/year cap on owner charges per property:

- The app shows a per-property "spend in the last 12 months" widget.
- A new charge that would push the rolling 12-month total above R60,000 goes to `pending_owner_approval`.
- Annual cap takes precedence over the monthly cap — if both are tripped, the higher escalation wins.

---

## Per-company seeding

When a new company is created, a default `approval_policies` row is seeded:

| Field | Default (Dropinn-style for ZA STR market) |
|---|---|
| `scope_type` | `'company'` |
| `single_inventory_item_cap` | R1,000 |
| `single_maintenance_item_cap` | R2,000 |
| `single_owner_chargeable_cap` | R2,000 |
| `monthly_owner_total_cap` | R2,000 |
| `annual_owner_total_cap` | R60,000 |
| `internal_approvable_below` | R0 (every chargeable needs manager approval) |
| `internal_ceiling` | R2,000 |
| `absolute_block_above` | R10,000 |

Company Admin can edit these. The audit trail records who changed what and when.

---

## Who can edit policies

| Action | Inspector | Coordinator | Ops Manager | GM | Company Admin | Super Admin |
|---|---|---|---|---|---|---|
| View policy | ⬜ | ⬜ | ✅ | ✅ | ✅ | ✅ |
| Edit company-level policy | ⬜ | ⬜ | ⬜ | ⬜ | ✅ | ✅ |
| Add owner-level override | ⬜ | ⬜ | ⬜ | ✅ | ✅ | ✅ |
| Add property-level override | ⬜ | ⬜ | ⬜ | ✅ | ✅ | ✅ |
| Override a cap on a single charge | ⬜ | ⬜ | ⬜ | ✅ (audited, requires written reason) | ✅ (audited) | ✅ (audited) |
| Edit a historical approval_decisions row | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ✅ (rare; full audit) |

The `override` action exists for genuine emergencies (e.g., a burst pipe at midnight that costs R5,000 to stop) — but it requires a written reason and audits loudly. Use it sparingly.

---

## Edge cases

| Situation | Behaviour |
|---|---|
| Company has not set any policy yet | System fallback (Dropinn defaults) applies. Banner on Company Admin home: "Please review your approval policy." |
| Policy changes mid-month (cap raised) | New cap applies to future approvals only. Already-approved charges are not retroactively re-evaluated. |
| Owner-level override conflicts with property-level | Property wins (most specific). |
| Two policies have overlapping active dates | The most recently created wins; older one is shown as superseded in audit. |
| Cap is set to zero | All chargeables need owner approval. Used for "trust still being built" relationships. |
| Cap is unset | No limit at that level. App still warns Company Admin if headline caps are unset. |
| User tries to game by splitting a R3,000 charge into two R1,500 charges | Detected by the monthly cap; second charge trips it. Single-item splitting alone doesn't bypass the system. |
| Owner is unreachable for sign-off | Charge stays in `pending_owner_approval` indefinitely. Surfaces on Action Centre after 7 days as "awaiting owner — 7 days." Manager can escalate to GM to absorb as company-chargeable instead. |

---

## What is NOT in v1.0 / v1.2

- A full policy editor UI for non-Company-Admin roles.
- Per-category caps (the data model supports them; the UI seeds only the four headline caps in v1.2).
- Policy templates ("STR market: South Africa", "STR market: Portugal") — only the South African default is seeded in v1.0.
- Automated owner notifications (the system prepares the copy-paste message; the manager sends it manually).
- A live dashboard of "policies needing review" beyond the Action Centre signal.

These can all be added when there's demand. The data model supports them today.

---

## Why this matters

Without this, the product cannot represent the actual contract obligations between Dropinn and its owners. A manager approving R3,000 on the owner's behalf without owner sign-off is a contract breach — not a UI bug.

This is also the foundation of trust with owners: "We never spend your money without telling you, and the audit trail proves it." That alone may justify the product to a new property owner.
