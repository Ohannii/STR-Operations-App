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

The first batch ships **fourteen chips** covering the most common
operational state. Most workflows use a **pending → completed** pair
so staff can actively mark intent ("this needs Asana logging")
rather than letting absence-of-completed-chip do the job — because
absence is not a deliberate operational state and would muddle
dashboard counts. The two exceptions are documented under the table.

Sessions 7+ may extend this list (e.g., inventory item-level marks,
OTA claim status). Sessions never remove a kind without an explicit
deprecation plan.

### Workflow pairs (pending → completed)

| Pending kind | Completed kind | Completed `replaces` |
|---|---|---|
| `asana_pending` | `asana_logged` | `['asana_pending']` |
| `guest_notify_pending` | `guest_notified` | `['guest_notify_pending']` |
| `owner_notify_pending` | `owner_notified` | `['owner_notify_pending']` |
| `maintenance_pending` | `maintenance_assigned` → `maintenance_done` | `assigned` replaces `['pending']`; `done` replaces `['pending', 'assigned']` |
| `replacement_needed` | `replaced` | `['replacement_needed']` |
| `awaiting_owner_approval` | `owner_approved` | `['awaiting_owner_approval']` |

### Single-state chips

| `kind` | When it's set |
|---|---|
| `needs_reclean` | Cleaning team has been notified the area needs re-cleaning. Toggle off when the reclean is done. Cleaning is fast / same-day so a separate `recleaned` companion is not needed in v1.0. |

### Full vocabulary with display + metadata shapes

| `kind` | Display label | When it's set | Metadata shape |
|---|---|---|---|
| `asana_pending` | "Asana pending" | Staff deliberately mark that this flag needs to be logged in Asana. Without this chip, the flag is NOT counted in "Ready for Asana" dashboard tiles. | `{ }` (none) |
| `asana_logged` | "Asana logged" | A corresponding task has been created in Asana. Clears `asana_pending`. | `{ url?: string }` |
| `guest_notify_pending` | "Guest notify pending" | Staff have decided the guest needs to be notified about this flag but the message hasn't been sent yet. Within the 24-hour guest damage window, this surfaces what's at risk. | `{ }` (none) |
| `guest_notified` | "Guest notified" | The guest has been messaged (WhatsApp, email, in-person). Clears `guest_notify_pending`. Replaces the heavy recovery-task workflow for 90% of cases. | `{ method?: 'whatsapp' \| 'email' \| 'sms' \| 'phone' \| 'in_person', whatsapp_url?: string }` |
| `owner_notify_pending` | "Owner notify pending" | Staff have decided the owner needs to be told about this flag but the message hasn't been sent yet. | `{ }` (none) |
| `owner_notified` | "Owner notified" | Owner has been told (verbally, WhatsApp, email). Clears `owner_notify_pending`. | `{ method?: 'whatsapp' \| 'email' \| 'sms' \| 'phone' \| 'in_person' }` |
| `maintenance_pending` | "Maintenance pending" | A maintenance job is needed but not yet assigned to a person/vendor. | `{ }` (none) |
| `maintenance_assigned` | "Maintenance assigned" | A maintenance person / vendor has been booked. Clears `maintenance_pending`. | `{ assignee?: string, scheduled_for?: string (ISO date) }` |
| `maintenance_done` | "Maintenance done" | The maintenance work is complete and verified. Clears both `maintenance_pending` and `maintenance_assigned`. | `{ done_at?: string (ISO date), completed_by?: string }` |
| `replacement_needed` | "Replacement needed" | An item needs replacing (missing / damaged / broken-beyond-repair). | `{ }` (none) |
| `replaced` | "Replaced" | The item has been replaced. Becomes part of the apartment's replacement history. Clears `replacement_needed`. | `{ replaced_at?: string, cost?: number, vendor?: string, item_label?: string }` |
| `awaiting_owner_approval` | "Owner approval pending" | The cost exceeds an internal limit and needs the owner's sign-off before proceeding. | `{ amount?: number, requested_at?: string }` |
| `owner_approved` | "Owner approved" | The owner has signed off on the cost. Clears `awaiting_owner_approval`. | `{ approved_at?: string, method?: string, evidence_path?: string }` |
| `needs_reclean` | "Needs reclean" | Cleaning team has been notified that the area needs re-cleaning. | `{ notified_at?: string }` |

Display labels are operator-grade plain English (matching the
operator-grade flag-category labels established in Session 3 polish).
Icons + tones live in `src/lib/ui/chip-vocabulary.ts`; this file
documents semantics only. All pending chips share Hourglass icon +
amber tone for visual consistency; completed chips inherit the
workflow's signature icon.

---

## Compositions worth knowing

These are the read-side derivations the dashboard summary cards
(Session 7) will use. The app does not enforce these chains; they are
conventions for counting operational state.

Because pending and completed are now explicit chip pairs, "Ready for"
and "X pending" counts read straight from chip presence — no
absence-as-state heuristics.

- **Ready for Asana:** flags with active `asana_pending` chip.
- **Asana logged this week:** flags with active `asana_logged` chip
  marked in the last 7 days.
- **Guest notification pending:** flags with active
  `guest_notify_pending` chip.
- **Owner notification pending:** flags with active
  `owner_notify_pending` chip.
- **Owner approval blocking:** flags with active
  `awaiting_owner_approval` chip.
- **Maintenance in flight:** flags with active `maintenance_pending`
  OR `maintenance_assigned` chip.
- **Needs replacement:** flags with active `replacement_needed` chip.

These are all read-side derivations, not separate state. Each is a
single chip-active filter — no absence checks, no composite logic.
That keeps the dashboard tiles cheap (single index-scan per tile) and
the meaning unambiguous.

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
