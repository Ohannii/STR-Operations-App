# OWNER_COMMUNICATION_WORKFLOWS.md

## Plain-English overview

Owners want three things from a property manager:

1. **A regular heartbeat** — "What's happening at my place this week?"
2. **A monthly summary** — "What did this cost me this month, and where's the evidence?"
3. **Approval requests when needed** — "Something came up and I need your sign-off."

The product must support all three without requiring the manager to write owner messages from scratch every time. Templated drafts + manager review + send is the pattern.

This document covers:

- The **weekly owner status update** (new — ships in v1.3).
- The **monthly owner charge summary** (already planned — `REPORTING_REQUIREMENTS.md`).
- The **ad-hoc owner approval request** (already covered by `APPROVAL_LIMITS_AND_CONTRACT_RULES.md`).
- Where each comes from and what each contains.

---

## Weekly owner status update

### Why it exists

Monthly summaries are about money. Weekly updates are about presence — they tell the owner the team is on the case, the property is being looked after, and there's nothing to worry about (or there's something brewing they should know about).

A short weekly heartbeat does three things:

1. Prevents the monthly summary from being a surprise.
2. Reduces "what's happening at my property?" WhatsApp messages.
3. Builds trust between owner and manager.

### Frequency

Default: once a week, on a configurable day (default Sunday evening). The manager generates, reviews, and sends.

Can be turned off per owner / per property (some owners don't want weekly updates).

### Contents

Each weekly update contains, for the past 7 days:

- **Property status** — currently occupied / between stays / inspection pending / etc.
- **Open issues** — short list with priorities. Brief, not a full report.
- **Resolved issues** — what was fixed this week, with cost if any.
- **Upcoming or pending maintenance** — what's scheduled next week.
- **Pending owner approvals** — anything waiting for the owner's sign-off (linked to the approval policy flow).
- **Notable inspection findings** — any flags raised this week worth knowing about even if not chargeable.
- **Manual occupancy/reservation note** — the manager can add a one-line free-text note about upcoming bookings, since the product does not yet pull from a PMS. (v1.5+ may auto-fill this from Hostaway.)
- **Photos** — up to 6 thumbnails from the most evidence-worthy events of the week.

Deliberate non-contents:

- No dollar/rand totals (those belong in the monthly summary).
- No internal staff names beyond the manager's signature.
- No raw audit log.
- No analytics ("inspections completed this week: 4" — owners don't care).

### Data model

(Schema details in `DATABASE_SCHEMA_PLAN.md`.)

#### Table: `weekly_status_updates`

Key fields:

- `id`, `company_id`, `property_id`
- `week_starting` (date)
- `week_ending` (date)
- `status` — `'draft'` | `'sent'`
- `prepared_by` (user id), `prepared_at`
- `sent_by` (user id, may equal prepared_by), `sent_at`
- `manual_occupancy_note` (free text)
- `manual_property_status` — pre-filled by system but editable
- `notes_to_owner` (free text)
- The list of linked issues, accountability records, and photos is computed at generation time and stored as linked rows or embedded JSON for the snapshot

### Workflow

1. Manager opens the **Weekly Status Updates** page for a property (or for all properties in a list view).
2. Clicks **"Generate this week's update"** (or it's pre-generated automatically on Sunday morning).
3. System assembles the update from:
   - Open issues at end of week.
   - Issues closed in the week with non-zero cost.
   - Maintenance jobs scheduled for next week.
   - Approval-pending items.
   - Inspections submitted in the week with flags raised.
4. Manager reviews. Edits free-text notes. Can hide individual lines with a reason (audited).
5. Manager clicks **"Send"** → `status = 'sent'`. Audit row written.
6. Owner sees it on their dashboard (Owner Viewer role).
7. Manager can also use the **copy-paste WhatsApp** button to send a short summary link via WhatsApp (the same signed-share-link approach as v1.5 polish).

### Stupid-proof UX

- **Default day pre-set.** Sunday evening, configurable per company.
- **One-tap generate.** Manager doesn't decide what's in it; the system pulls from structured data.
- **The "Send" button is the brightest thing on the page.**
- **No required free-text.** Manager can send without writing a single character. The system has enough structured data to fill in everything.
- **Owner sees the same view** the manager prepared, with the manager's name as the signature line.
- **Auto-skip** an update for a week with zero activity (and notify the manager: "No activity this week at Property X — skipping the update unless you want to send one anyway.").

---

## Monthly owner charge summary

Already covered in `REPORTING_REQUIREMENTS.md`. Summarised here for cross-reference:

- One per (company, property, calendar month).
- Built from approved owner-chargeable accountability records.
- Status workflow: `draft` → `sent`.
- HTML in v1.3, native PDF in v1.5.
- Must meet the presentation quality bar (clean / professional / printable / structured).
- Total appears at the top in large type.
- Owner sees only their property; cannot see other properties.
- Once sent, immutable.

The monthly summary and the weekly update are **independent**: a property can have weekly updates turned off but monthly summaries on (or vice versa). They share data but each has its own send state and audit trail.

---

## Ad-hoc owner approval requests

Triggered when an approval cap is hit (see `APPROVAL_LIMITS_AND_CONTRACT_RULES.md`).

Already covered there. Summary:

- Manager picks a template, the app fills variables, manager copies to WhatsApp / email / OTA.
- Owner replies (in whatever channel), manager records the response in the app with a screenshot.
- The approval policy then unlocks the charge.

The weekly update lists pending owner approvals as a section, so even if the manager forgot to follow up on a single request, it surfaces in the weekly heartbeat.

---

## Owner-facing dashboard (Owner Viewer role)

The owner logs into the app and sees:

- A list of their properties.
- For each property:
  - Latest weekly update (when sent).
  - Latest monthly summary (when sent).
  - Pending approval requests (with the copy-paste message that was sent to them, for context).
  - Recent photo gallery (last 30 days, evidence-class only — no routine photos).
- A simple "request a call" button that emails the company admin.

The owner does **not** see:

- Other owners' properties.
- Internal staff names (beyond the manager who sent each artefact).
- The audit log.
- Routine inspection photos (only flagged ones).
- Operational metrics ("inspections completed").
- Pending charges that haven't been sent for owner approval yet.

---

## Owner communication channels

The MVP product is the app + copy-paste outbound. We don't send messages on the owner's behalf via WhatsApp / SMS / email API in v1.

In v1.3, the owner views the weekly update and monthly summary **in the app** (via their Owner Viewer login). The manager can also copy a signed share link and send it via WhatsApp / email manually — same pattern as guest messaging.

In v1.5+:

- Email notifications when a new update / summary / approval request is ready (transactional email via Resend or similar).
- WhatsApp Business API integration for owners who prefer WhatsApp.
- SMS for short notifications.

None of those are required for the product to work in v1.3.

---

## Permissions

| Action | Inspector | Coordinator | Ops Manager | Manager | GM | Company Admin | Property Owner Viewer |
|---|---|---|---|---|---|---|---|
| Generate weekly update | ⬜ | ⬜ | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Send weekly update | ⬜ | ⬜ | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Edit a draft weekly update | ⬜ | ⬜ | ✅ | ✅ | ✅ | ✅ | ⬜ |
| Edit a sent weekly update | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ (correction only, audited) | ⬜ |
| View own property's weekly update | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ✅ (sent only) |
| Configure weekly update day for company | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ✅ | ⬜ |
| Turn off weekly update for a property | ⬜ | ⬜ | ⬜ | ⬜ | ✅ | ✅ | request only |

---

## Acceptance criteria for v1.3 owner communications

1. Manager can generate a weekly update for one or more properties.
2. The update assembles from structured data only (no hand-curation needed in the happy case).
3. Manager can review, edit notes, hide individual lines with a reason.
4. The "Send" button transitions to `sent` and writes an audit row.
5. Owner Viewer sees the update in the app, scoped to their property only.
6. The HTML rendering passes the presentation quality bar in `REPORTING_REQUIREMENTS.md`.
7. A property with weekly updates turned off shows no update in the owner's view.
8. A week with zero activity prompts the manager to skip rather than auto-generating an empty update.
9. Pending owner approvals show up in the weekly update's "needs your sign-off" section.

---

## Why this matters

Weekly updates take 30 seconds for the manager to send and prevent hours of "what's going on at my apartment?" WhatsApp ping-pong. They also turn the monthly summary from "a surprise bill" into "the formal version of what you already knew was coming." Trust compounds week by week.

For a non-technical founder with a small team, a one-tap heartbeat is the difference between an owner who feels looked-after and an owner who feels in the dark.
