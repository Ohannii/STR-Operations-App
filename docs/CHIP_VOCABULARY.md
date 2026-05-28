# CHIP_VOCABULARY.md

## Purpose

This is the **single source of truth** for the lightweight operational marks
(a.k.a. "chips") that sit on every flag. Each chip is a discrete piece of
operational state — *Asana logged*, *Guest notified*, *Maintenance assigned*,
*Item replaced* — that the field team toggles as work progresses.

Chips are the daily-driver UI surface for "where is this issue right now?".
They are deliberately separate from:

- **The flag's own `status` field** (`raised` / `classified` / `actioned` /
  `closed` / `no_action`) — the lifecycle state machine.
- **The flag's `chargeable_party_decision`** (`guest` / `owner` / `company`
  / `contractor` / `pending_decision`) — the responsibility decision.
- **The optional `guest_recovery_tasks` workflow** — the formal escalation
  path for direct guest follow-up with WhatsApp + paid/refused audit
  trail. Rare. Used only when the chip layer is not sufficient.

Chips inherit company scope from the parent flag. They are stored in the
`flag_operational_marks` table (Session 6 migration).

---

## How chips work

- Every chip is a row in `flag_operational_marks` with a `kind` (the string
  identifier listed below) and optional `metadata` (jsonb).
- One **active** chip per `(flag_id, kind)` at any time — enforced by a
  partial unique index:
  ```sql
  create unique index flag_operational_marks_one_active_per_kind
    on public.flag_operational_marks (flag_id, kind)
    where cleared_at is null;
  ```
- Toggling a chip "off" sets `cleared_at = now()` and `cleared_by = auth.uid()`.
  The row is **not deleted** — historical rows accumulate, providing an
  audit trail of when each chip was set / cleared and by whom.
- Toggling a chip "on" again inserts a fresh row (because the previous one
  is no longer active).

`kind` values are application-controlled strings. **Adding new chip kinds
does not require a database migration** — it requires updating this
document and the UI code. Renaming or removing existing kinds DOES require
a data backfill plan, so the vocabulary below should evolve additively.

---

## Initial chip kinds (Session 6 first cut)

The first batch ships ten chips covering the most common operational state.
Sessions 7+ may extend this list (e.g., inventory item-level marks, OTA
claim status). Sessions never remove a kind without an explicit deprecation
plan.

| `kind` | Display label | When it's set | Metadata shape |
|---|---|---|---|
| `guest_notified` | "Guest notified" | Manager has sent the guest a message (WhatsApp, email, or other) about the flag. Replaces the recovery-task workflow for 90% of cases. | `{ method: 'whatsapp' \| 'email' \| 'sms' \| 'phone' \| 'in_person', whatsapp_url?: string }` |
| `owner_notified` | "Owner notified" | Owner has been told about the issue (verbally, WhatsApp, email). | `{ method: 'whatsapp' \| 'email' \| 'sms' \| 'phone' \| 'in_person' }` |
| `asana_logged` | "Asana logged" | A corresponding task has been created in Asana for the company's existing workflow tooling. | `{ url?: string }` |
| `maintenance_pending` | "Maintenance pending" | A maintenance job is needed but not yet assigned. | `{ }` (none) |
| `maintenance_assigned` | "Maintenance assigned" | A maintenance person / vendor has been booked. Replaces `maintenance_pending`. | `{ assignee?: string, scheduled_for?: string (ISO date) }` |
| `maintenance_done` | "Maintenance done" | The maintenance work is complete and verified. | `{ done_at?: string (ISO date), completed_by?: string }` |
| `replaced` | "Replaced" | An inventory item flagged as missing or damaged has been replaced. Becomes part of the apartment's replacement history. | `{ replaced_at?: string, cost?: number, vendor?: string, item_label?: string }` |
| `awaiting_owner_approval` | "Owner approval pending" | The cost exceeds an internal limit and needs the owner's sign-off before proceeding. | `{ amount?: number, requested_at?: string }` |
| `owner_approved` | "Owner approved" | The owner has signed off on the cost (verbally, in writing, via WhatsApp). Replaces `awaiting_owner_approval`. | `{ approved_at?: string, method?: string, evidence_path?: string }` |
| `needs_reclean` | "Needs reclean" | Cleaning team has been notified that the area needs re-cleaning before this flag closes. | `{ notified_at?: string }` |

Display labels are operator-grade plain English (matching the
operator-grade flag-category labels established in Session 3 polish).
The icons each chip uses live in the UI code (`src/lib/ui/chip-vocabulary.ts`
when Session 6 ships), not here — this file documents semantics only.

---

## Compositions worth knowing

Some chip patterns chain together to express common workflow shapes.
The app does not enforce these chains — they are conventions used by
the dashboard summary cards (Session 7) to count operational state:

- **Cost recovery pending:**
  Flag has `chargeable_party_decision = 'guest'`
  AND `guest_notified` is active
  AND no `cost_recovered` chip yet *(reserved future kind)*

- **Ready for Asana:**
  Flag status is `classified` or `actioned`
  AND `asana_logged` is NOT active
  AND `no_action` flag-status is not set

- **Owner approval blocking:**
  `awaiting_owner_approval` is active
  AND `owner_approved` is NOT active.

- **Maintenance in flight:**
  `maintenance_pending` OR `maintenance_assigned` is active
  AND `maintenance_done` is NOT active.

These are read-side derivations, not separate state. The dashboard
summary tiles count flags matching each composition.

---

## Reserved for later sessions (not in Session 6)

These chip kinds are intentionally NOT in the first cut but documented
here so we don't fork the vocabulary later when they're added:

- `cost_recovered` — for "the money has been recovered from the guest /
  insurance / OTA / company-absorb". Ships when the recovery flow
  promotes from optional to first-class.
- `evidence_pack_ready` — for "the pre-arrival evidence bundle for this
  property is assembled and ready to share". Ships with the Evidence
  Pack feature (post Evidence Camera, Session 8+).
- `ota_claim_filed` / `ota_claim_resolved` — for OTA dispute workflow
  (v1.1).
- `inspection_section_complete:<section_id>` — for marking sections of
  an inspection complete during a multi-pass workflow. Ships with
  Session 10 inspection workflow. *Note: these are inspection-level
  chips that may live on `inspections`, not `flags` — design TBD at
  Session 10 time.*

---

## Why this layout (not separate boolean columns on `flags`)

Three reasons we use a `flag_operational_marks` child table instead of
adding columns to `flags`:

1. **Extensibility.** New chip = new `kind` string + UI code. No migration.
2. **Audit.** Each toggle is a row with `marked_at` / `marked_by` /
   `cleared_at` / `cleared_by`. The history is preserved automatically.
3. **Queryability.** "Show me all flags missing Asana" is a clean LEFT JOIN
   filter, not a boolean column check that would need its own index per chip.

This decision is locked. Sessions that want to add chip-like state should
extend this vocabulary, not add columns to `flags`.

---

## When NOT to add a new chip kind

- When the concept belongs on a different entity (e.g., inspection-level
  state belongs on `inspections`, not `flags`).
- When the concept needs structured fields that a flat `metadata` jsonb
  can't represent — that's a sign the concept warrants its own table.
- When the state is genuinely binary on the flag itself (e.g., the flag's
  own `status` lifecycle). Chips are *parallel* state, not the state
  machine.

When in doubt, write a one-paragraph proposal in a session prompt before
shipping.
