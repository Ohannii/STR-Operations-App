# DEDUPLICATION_AND_TASK_GROUPING_RULES.md

## Plain-English overview

One real-world problem must show up as **one thing** in the app. Not three. Not five.

If an inspector notices "the TV is broken — the guest probably did it," that is one problem. In the data model it can generate up to four linked records: an issue (something is broken), a maintenance job (it needs to be fixed), a guest recovery task (try to recover the cost from the guest), and an accountability record (decide who pays). But on the Action Centre, on reports, in the Evidence Vault, and in any owner-facing surface — it must appear as **one card**.

This document defines the rule that holds the whole product together: **the flag is the parent. Everything else is a child of the flag. The UI groups by flag.**

This is the rule that prevents the product from becoming the same mess as Asana + WhatsApp.

---

## The core rule

> **Every real-world problem is a single `flags` row. Downstream records (issues, maintenance jobs, inventory movements, guest recovery tasks, accountability records, owner charge lines) are children linked back to the flag via `parent_flag_id`. The Action Centre surfaces the flag, not the children.**

Said another way:

- The flag is the source of truth for "what is the problem?"
- The children are the source of truth for "what action is being taken about it?"
- A user always sees the problem first; the actions are nested under it.

This is non-negotiable. Any screen, report, search, or notification that violates it is wrong and needs fixing before merge.

### One parent flag holds every kind of child action (prototype finding #17)

The Replit prototype confirmed the failure mode this rule prevents: a single real-world issue must not scatter into duplicate tasks. One parent flag holds **all** of its child actions together:

- evidence (photos)
- Asana logging
- guest notification (recovery task)
- maintenance (issue → job)
- owner charge (accountability record)
- review / sign-off

All six attach under the one flag. The Action Centre shows one card; the work strip shows the child actions; nothing about this problem appears anywhere else as an independent open task. If a manager adds "maintenance required" to a flag that already has a guest-notification child, both live under the same parent — they do not become two separate problems.

---

## What "flag-as-parent" means in the data

The `flags` table is the only table whose rows represent **problems**. Every other operational table represents **work being done about a problem**. Specifically:

- `issues.parent_flag_id` (nullable but populated when the issue came from a flag)
- `maintenance_jobs.parent_flag_id` (nullable, populated when from a flag)
- `inventory_movements.parent_flag_id` (nullable, populated when from a flag)
- `guest_recovery_tasks.source_flag_id` (already exists in schema; this is the parent link)
- `accountability_records.parent_flag_id` (nullable, populated when from a flag)

A flag can have multiple children. A child belongs to exactly one parent flag (or zero — see "Standalone records" below).

(The schema details and column names are consolidated in `DATABASE_SCHEMA_PLAN.md`.)

---

## When a flag spawns one child

Most flags spawn **zero or one** downstream record:

| Flag type | Typical children spawned |
|---|---|
| Condition note | None. Recorded for history only. |
| No-action record | None. |
| Follow-up required | None until promoted on next inspection. |
| Cleaning issue | One issue (in v1.5, a cleaning task). |
| Maintenance issue (no cost) | One issue. |
| Inventory missing | One inventory movement. |
| Inventory damaged | One inventory movement. |
| Owner-chargeable wear | One accountability record. |
| Company responsibility | One accountability record (chargeable_party = company). |
| Safety / urgent | One issue (high priority). |

For these flags, the Action Centre card shows: the flag header, plus the single child's status pill. No duplication.

## When a flag spawns multiple children (the case that breaks naïve UIs)

The expensive flag is **guest damage**. Real example:

> "The TV is cracked and we think the guest did it. It's worth R3,500."

This single problem can create up to **four** linked records:

1. A `flags` row (the parent — type = `guest_damage`, severity = high, photos attached).
2. A `guest_recovery_tasks` row (the same-day workflow to try to recover from the guest, then OTA, then fallback).
3. A `maintenance_jobs` row (the work to actually repair/replace the TV — someone has to do this regardless of who pays).
4. An `accountability_records` row (where the cost lands once the recovery cascade resolves).

If we showed these as four independent Action Centre items, the manager would see:

- "Cracked TV — needs attention" (the flag)
- "Notify guest about TV damage — deadline 8 hours" (the recovery task)
- "Replace TV — find contractor" (the maintenance job)
- "TV replacement — R3,500 — pending approval" (the accountability)

Four rows. Same TV. The manager is now confused about whether they're tracking four different broken TVs or one.

**Correct behaviour:**

One card on the Action Centre. The card title is the flag description ("Cracked TV — apartment 4B"). The card body shows a small **work strip** with the four nested records and their statuses:

```
┌─────────────────────────────────────────────────────────┐
│  ⚠️  Cracked TV — Apartment 4B                          │
│  Guest damage • R3,500 est • Raised 2h ago              │
│  [3 photos]                                             │
│  ─────────────────────────────────────                  │
│  Work in progress:                                      │
│  • Notify guest         [Sent ✓]   [Recovery card →]    │
│  • Get TV replaced      [Open]     [Maintenance card →] │
│  • Decide who pays      [Pending owner]  [Charge card →]│
│  ─────────────────────────────────────                  │
│  [Open]  [Add photo]  [Notify guest]  [Add note]        │
└─────────────────────────────────────────────────────────┘
```

The manager sees **one problem** with **three sub-states**. Tapping a sub-state opens the focused view for that specific child record.

The "Notify guest" button lives **on the flag card** because the guest-notification action belongs to this problem, not to a separate Guest Recovery module. Pressing it opens the recovery task's copy-paste message flow inline.

---

## Standalone records (when a downstream record has no parent flag)

A downstream record can exist without a flag in narrow cases:

- A scheduled maintenance job (e.g., "annual aircon service") — no flag, just a scheduled job.
- A planned inventory restock (e.g., "deliver 6 new towels") — no flag, just a movement.
- A direct accountability adjustment (e.g., "owner reimbursed company for last month's electricity overrun") — no flag, just a record.

In these cases the downstream record has `parent_flag_id = NULL` and surfaces as its own Action Centre card. This is **not** a duplication; there is no parent to group under.

Rule: only operational problems flow through flags. Routine scheduled work or financial adjustments don't.

---

## When to create a downstream record vs not

Default behaviour: **don't create downstream records until they're actually needed.** A flag in `classified` state with no children is fine — it means "we know about this; we're deciding what to do."

| Trigger | Spawn downstream record? |
|---|---|
| Flag raised, type not yet picked | No. Stays in `raised`. |
| Flag classified as condition note / no-action / follow-up | No. Never. |
| Flag classified as maintenance issue, manager decides "needs fixing" | Yes — one issue. Manager taps "Convert to issue." |
| Flag classified as guest damage, manager decides "pursue recovery" | Yes — one recovery task. AND one maintenance job (if repair needed). |
| Flag classified as inventory missing, manager decides "log it" | Yes — one movement. |
| Flag classified as owner-chargeable wear | Yes — one accountability record. |
| Flag re-classified after children already exist | No new children. Existing children are repurposed or closed. |

The manager has explicit "Convert to ..." buttons on each flag. **Conversion is never automatic except for guest damage** (because the 24h recovery window is too short to wait for a human to remember to convert).

---

## Preventing accidental duplicates

### Same problem flagged twice in the same inspection

If an inspector accidentally flags the same broken TV on two different line items in the same inspection:
- v1.0 behaviour: both flags exist; manager triages and merges (mark one as `no_action`, link the keeper).
- v1.5 behaviour: a "Looks similar to flag X" hint surfaces on the second flag at raise time.

### Same problem flagged in pre-arrival and again in post-stay

If the broken TV is flagged in pre-arrival and the post-stay also notes "TV still broken":
- The post-stay inspector should see "Known issue: TV broken (raised 3 days ago)" inline on the line item.
- They tap "Already known" instead of raising a new flag.
- The pre-arrival flag's `history` gains a new observation event.
- Only one flag exists.

(v1.0 shows the inline "Known issue" hint as a stretch goal; v1.1 has it firm.)

### Same problem flagged across multiple inspections over weeks

If the TV is still broken three inspections later:
- Each subsequent inspection's "Already known" tap adds an observation event to the existing flag.
- The flag's age grows; the Action Centre escalates colour as it ages.
- No new flags. No new children.

### Two inspectors flag the same problem within minutes

(Possible if a Coordinator is also walking the property.)
- Both flags get created.
- Action Centre shows them as "Possible duplicates" (same property, same line item, same flag type within 60 minutes).
- Manager merges manually in v1.0.

---

## How the Action Centre groups

The Action Centre query is, conceptually:

```sql
SELECT flag.*,
       COUNT(child.id) FILTER (WHERE child.status NOT IN ('closed', 'verified', 'paid')) AS open_children,
       json_agg(child) FILTER (WHERE child.parent_flag_id = flag.id) AS work_strip
FROM flags flag
LEFT JOIN (
  SELECT id, parent_flag_id, status, 'issue' AS kind FROM issues
  UNION ALL
  SELECT id, parent_flag_id, status, 'maintenance' FROM maintenance_jobs
  UNION ALL
  SELECT id, parent_flag_id, status, 'movement' FROM inventory_movements
  UNION ALL
  SELECT id, source_flag_id AS parent_flag_id, status, 'recovery' FROM guest_recovery_tasks
  UNION ALL
  SELECT id, parent_flag_id, status, 'accountability' FROM accountability_records
) child ON child.parent_flag_id = flag.id
WHERE flag.company_id = $1
  AND flag.status NOT IN ('closed', 'no_action')
GROUP BY flag.id
```

Plus a separate query for standalone records (`parent_flag_id IS NULL`).

Result: one row per flag, with all its children rolled into the same row. The UI never has to deduplicate after the fact.

---

## How linked records appear under one card

The card has three zones:

1. **Header** — what the problem is, who raised it, when, severity, photos badge.
2. **Work strip** — small chips for each child record with its kind and current state. Tappable; opens the focused detail view for that child.
3. **Action buttons** — the most useful action right now, based on the flag's current dominant state. For guest damage in `guest_attempted`: the brightest button is "Record guest response." For an unconverted maintenance flag: the brightest button is "Convert to job."

The card never shows duplicate buttons for the same action across children. If two children both have a "needs photos" gap, the card shows one "Add photos" button that adds photos to the parent flag's evidence set (which all children inherit).

---

## How Asana copy-paste / outbound sync avoids duplication

**Asana is optional outbound only** — see `INTEGRATION_ROADMAP.md`. Three rules:

1. **The app is the source of truth.** Asana never owns state. If Asana and the app disagree, the app wins.
2. **One Asana task per parent flag, not per child.** When a manager taps "Copy as Asana task," the generated text summarises the flag *and* its children. Pasting this into Asana creates one task that mirrors one Action Centre card.
3. **One-way outbound only (v1.5+).** If we ever automate the sync, it pushes flag-level updates to Asana. It does NOT pull from Asana. It does NOT create one Asana task per child record.

A manager who copy-pastes during the transition period will see the same one-card-per-problem discipline in Asana that the app enforces internally.

---

## How this prevents the failure modes you flagged

| Failure mode to avoid | How this rule prevents it |
|---|---|
| "Issue Centre" as a separate surface from Action Centre | There is no Issue Centre. Issues are children of flags. They are seen inside flag cards. |
| "Evidence Vault" + "Photo Gallery" + "Evidence Drawer" as separate things | They are all the same data — the `photos` table — filtered differently. The Evidence Vault is a *search/filter view* over photos, not a separate module. See `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`. |
| Asana tasks as mandatory | The app never requires Asana. Asana copy-paste is a transition tool. The roadmap names this explicitly. |
| Guest Recovery task and separate Issue task for the same damage | Both are children of the same parent flag. They appear together in one Action Centre card under the same problem. |

---

## What is NOT this rule's job

- **Cross-property correlation.** "The same brand of TV broke in three apartments" is a pattern, not a duplicate. Each apartment's TV is its own flag.
- **Cross-company sharing.** Companies never see each other's flags; that's an RLS concern.
- **Auto-categorisation.** Deciding whether a flag is "maintenance" or "guest damage" stays with humans.

---

## Acceptance tests for the rule

These are the tests that fail if the rule is implemented wrong (also in `TESTING_CHECKLIST.md`):

1. One broken TV creates one Action Centre card, regardless of how many child records exist.
2. The card shows the child records' statuses in a work strip, not as separate cards.
3. Tapping a child status opens the child's focused view; closing it returns to the card.
4. Resolving all children closes the flag automatically (or prompts the manager to close it).
5. Re-opening a child re-opens the flag.
6. Search for "TV" returns one result, not four.
7. The Evidence Vault shows the photos under the parent flag's heading, not under each child.
8. Generated Asana copy-paste text contains one task summary per parent flag, with the children listed as a checklist inside that one task.

---

## Why this matters

A product whose UX duplicates rows for the same problem becomes unusable at scale. Your team would scroll past five rows about one TV and miss two other apartments' worth of real problems entirely.

The flag-as-parent rule is what lets the Action Centre stay scannable when you have 200 apartments and 80 open flags. Without it, the product becomes the mess you're trying to escape — only with a nicer login screen.
