# GUEST_DAMAGE_RECOVERY_WORKFLOW.md

## Plain-English overview

Damage caused by a guest must be addressed **the same day they check out**, or recovery becomes harder by the hour. WhatsApp messages get lost. OTA dispute windows close. The guest goes silent. By the end of the week, the cost falls on the company or the owner.

This document defines:

- The same-day workflow from "post-stay inspection flags guest damage" to "recovery resolved."
- The deadline dashboard that prevents tasks from going stale.
- The cost recovery cascade: guest → OTA → company → owner.
- The copy-paste message generator that lets the manager send a clean message in WhatsApp / email / OTA without any external API integration.

Ships in **v1.1** alongside maintenance, because guest damage almost always also creates a maintenance job and uses the same data spine.

### Where this workflow lives (important)

The guest recovery workflow is **not a separate module the manager has to navigate to.** It lives inside the **flag card** on the Apartment Action Centre:

- A `guest_damage` flag is the **parent record**. The `guest_recovery_tasks` row carries `parent_flag_id` (and `source_flag_id`) back to it.
- The recovery task, any maintenance job, and any accountability record for the same damage are **children of that one flag**, shown in the flag card's work strip — one card, not several. See `DEDUPLICATION_AND_TASK_GROUPING_RULES.md`.
- The **"Notify guest"** button is on the flag card. Tapping it opens the message flow inline. The manager never goes to a separate "Guest Recovery" screen to send the message.
- Evidence (the original damage photos AND the screenshot proof of the sent WhatsApp message) is the same `photos` data, surfaced in the flag card's Evidence Drawer — not a separate vault. See `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`.

The screenshot of a sent message is stored as a photo with `entity_type = 'recovery_message_proof'`, `guest_recovery_task_id` set, and `retention_class = 'dispute_evidence'`. That is what removes the need to ever scroll WhatsApp for proof again.

---

## The recovery cascade

When something is flagged as "guest damage" by an inspector, the cost recovery chain is:

```
   Guest direct  ──refuses or no response──►  OTA claim  ──denied or partial──►  Company absorbs / falls to owner
       ▲                                          ▲                                            ▲
       │                                          │                                            │
   first attempt                            second attempt                              final outcome
```

The app must track **each attempt** with its own timestamp, outcome, evidence, and notes — not collapse the chain into a single chargeable_party field.

Why: a guest who paid in full goes to "resolved." A guest who refused goes to "OTA attempted." If the OTA paid out, resolved. If not, the cost has to land *somewhere*, and the app must explicitly record whether the company absorbed it or the owner did. Otherwise damage costs leak across the portfolio and the founder loses track of who owes what.

---

## The data model

(Schema details in `DATABASE_SCHEMA_PLAN.md`. Summary here.)

### Table: `guest_recovery_tasks`

One per guest damage incident.

Key fields:

- `id`, `company_id`, `property_id`
- `stay_id` (FK to the stay; links the pre-arrival and post-stay inspections)
- `source_flag_id` (the flag that created this task)
- `parent_flag_id` (the parent-record link used for Action Centre grouping; equals the source flag)
- `source_inspection_id` (the post-stay inspection)
- `description` (short narrative — used in messages)
- `estimated_amount` (decimal, ZAR)
- `actual_amount` (decimal, ZAR, when known)
- `status` — see state machine below
- `deadline_at` (default: checkout time + 24h; configurable per company)
- `created_at`, `closed_at`
- `final_chargeable_party` — `'guest'` | `'ota'` | `'company'` | `'owner'` | NULL (set only when status is `closed`)
- Photos linked via `photos.guest_recovery_task_id` with class `dispute_evidence`

### Table: `recovery_attempts`

One per attempt against a `guest_recovery_task`.

Key fields:

- `id`, `task_id` (FK)
- `attempt_type` — `'guest_direct'` | `'ota_claim'` | `'company_absorb'` | `'owner_charge'`
- `attempt_method` — `'whatsapp'` | `'email'` | `'sms'` | `'phone'` | `'ota_portal'` | `'in_person'` | `'app_decision'`
- `message_sent_at` (when the manager sent the message, if applicable)
- `message_template_id` (which template was used)
- `message_body_snapshot` (the actual text sent, captured for audit)
- `response_at` (when the guest / OTA responded, if at all)
- `response_evidence_path` (screenshot/photo of their reply)
- `outcome` — `'paid_full'` | `'paid_partial'` | `'refused'` | `'no_response'` | `'denied'` | `'pending'` | `'approved_internal'` | `'approved_owner'`
- `amount_recovered` (decimal, can be partial)
- `recorded_by` (user id), `recorded_at`
- `notes`

A task can have many attempts in sequence. The final outcome is determined by the last attempt that resolved positively, OR by an explicit `company_absorb` / `owner_charge` decision.

---

## State machine for a recovery task

```
   [new]                                                — Just created from the flag.
     │
     │  manager opens, sets details, picks first attempt
     ▼
   [guest_notified]                                     — Message sent to the guest.
     │
     │  guest responds (paid / refused) or 24h passes
     ▼
   [guest_resolved] (status closed: paid_full/partial)  — Best case.
     OR
   [ota_attempted]                                      — Guest refused / no response → claim filed with OTA.
     │
     │  OTA responds
     ▼
   [ota_resolved] (status closed)
     OR
   [fallback_decision]                                  — Company decides: absorb internally, or charge to owner.
     │
     │  manager picks
     ▼
   [closed] with final_chargeable_party set
```

Every transition writes to `audit_events` AND to `recovery_attempts` with the manager's id.

---

## Same-day deadline dashboard

The Action Centre (see `APARTMENT_ACTION_CENTRE.md`) surfaces guest recovery tasks under a "Today's recovery deadlines" widget. Rows are colour-coded:

| Time since checkout | Colour | Meaning |
|---|---|---|
| 0–6 hours | green | Plenty of time to notify guest. |
| 6–18 hours | amber | Should already be notifying. |
| 18–24 hours | orange | Final window. |
| > 24 hours | red | Deadline passed; quality of recovery drops. |

The dashboard surfaces *all* open recovery tasks across all properties for the company, sorted by deadline. Anyone with the Coordinator / Ops Manager / GM / Company Admin role sees this on login.

---

## Copy-paste message templates (MVP — no API)

The product ships with **message templates** the manager copies into WhatsApp / email / OTA portal manually. **No WhatsApp API integration is needed for MVP.** This was the right call: WhatsApp Business API requires Meta approval, costs per message, and is overkill before product-market fit.

### Template variables

The system fills in variables from the task and property:

- `{guest_first_name}` — from the stay record (or "there" if not stored)
- `{property_name}`
- `{checkout_date}`
- `{item_description}` — from the flag/recovery task description
- `{estimated_amount}` — formatted "R1,250"
- `{photo_summary}` — "We've attached 3 photos showing the issue."
- `{manager_name}` — the current user's name
- `{company_name}`
- `{response_deadline}` — typically "by [date+2 days]"

### Seeded templates

#### Guest direct — first contact (WhatsApp)

> Hi {guest_first_name}, this is {manager_name} from {company_name}. We've completed the post-checkout inspection at {property_name}. Unfortunately we noted: {item_description}. {photo_summary} The estimated cost to repair/replace is {estimated_amount}. Could you please confirm by reply or transfer by {response_deadline} so we can settle this quickly? Happy to discuss if you have questions.

#### Guest direct — follow-up (if no response within 12h)

> Hi {guest_first_name}, just following up on the message about {item_description} at {property_name}. We haven't heard back. If we don't hear from you by {response_deadline}, we'll have to file a claim through {ota_name} — we'd much rather resolve this directly. Please reply when you can.

#### OTA claim — Airbnb resolution centre

> Claim summary: {item_description}. Property: {property_name}. Checkout: {checkout_date}. Estimated cost: {estimated_amount}. Photos: see attached. We attempted direct contact with the guest on {attempt_dates} and received {response_status}.

#### OTA claim — Booking.com / generic email

> Subject: Damage claim — {property_name} — {checkout_date}
>
> Dear {ota_name} team,
>
> We are submitting a damage claim for the stay at {property_name} ending {checkout_date}. The item in question: {item_description}. Estimated cost: {estimated_amount}. Attached: pre-arrival photos showing the property in good condition, and post-checkout photos showing the damage. We attempted to contact the guest directly on {attempt_dates}. Their response: {response_status}.
>
> Please advise on next steps.
>
> {manager_name}
> {company_name}

### Manager flow

1. Manager opens the recovery task.
2. Taps "Send guest message" → picks the template (default = "Guest direct — first contact").
3. The app renders the message with variables filled in.
4. Taps **"Copy"** → message is on clipboard.
5. Taps **"Open WhatsApp"** (deep-link `https://wa.me/<guest_phone>?text=<encoded text>` if guest phone is on the stay record) OR pastes manually into the channel of choice.
6. After sending, returns to the app and taps **"Mark sent"** with a timestamp and (optionally) a screenshot of the sent message as evidence.
7. When a response comes (or doesn't), manager opens the task again, records the outcome with another screenshot.

This whole flow is **zero external integration**. WhatsApp Business API can be added in v1.5+ as an enhancement — but it is not required to ship.

---

## Per-step stupid-proof UX

The team running this is small and busy. Rules:

1. **Default deadline pre-set.** Manager doesn't have to think about "when should this be done by." 24h post-checkout by default; manager can shorten but not lengthen beyond company maximum.
2. **One big button at each state.** "Send guest message" → "Mark sent" → "Record response" → "File OTA claim" / "Mark resolved" → done. No menus.
3. **The next step is always the brightest button.** Stale tasks have a red action button labelled "Action overdue — pick next step."
4. **Action Centre always shows what's next.** "Property X — guest recovery — message sent 2h ago, response due 22h."
5. **No required text fields beyond what we already have.** Description was filled by the flag. Photos came from the inspection.
6. **Cannot mark resolved without a final outcome picked from the four options.** "Resolved" without `final_chargeable_party` is invalid.
7. **Cannot mark "Company absorb" if amount > absolute_block_above policy cap** — see `APPROVAL_LIMITS_AND_CONTRACT_RULES.md`. Above that, GM or Company Admin must approve.
8. **Charging the owner requires explicit confirmation.** Hardest path; mostly used as a last resort when the guest disappeared, OTA denied, and the company decides it can't absorb. Audited prominently.

---

## What happens to the linked records

When a guest recovery task is closed:

- If `final_chargeable_party = 'guest'` and `paid_full`: nothing further. The audit shows "guest paid R1,500 on 2026-05-15."
- If `final_chargeable_party = 'ota'`: an `accountability_record` with `chargeable_party = 'company'` and a note "Recovered via OTA" is created; the company's books reflect a net-zero position.
- If `final_chargeable_party = 'company'`: an `accountability_record` with `chargeable_party = 'company'` is created and flagged "absorbed."
- If `final_chargeable_party = 'owner'`: an `accountability_record` with `chargeable_party = 'owner'` is created, which **then enters the normal approval policy flow** (see `APPROVAL_LIMITS_AND_CONTRACT_RULES.md`). If the amount exceeds the owner monthly/annual cap, the owner is asked for sign-off via copy-paste message before the charge becomes final.

The linked maintenance job (if any) is handled separately — the recovery task tracks **who paid**; the maintenance job tracks **whether the work is done**. Both stay open until both close.

---

## Acceptance criteria for v1.1

A v1.1 release including guest recovery is done when:

1. A post-stay inspection flag of type "guest damage" auto-creates a `guest_recovery_tasks` row.
2. The Action Centre shows the task with a colour-coded deadline.
3. The manager can pick a template, see it filled with variables, and copy it to clipboard with one tap.
4. The manager can mark the message sent, with a screenshot evidence upload.
5. The manager can record the response with an outcome from the enum.
6. The manager can move the task through the state machine to a closed state with a `final_chargeable_party`.
7. Closing with `final_chargeable_party = 'owner'` correctly creates an `accountability_record` and routes it through the approval policy.
8. Every transition is audited.
9. A task that exceeds its deadline shows red on the Action Centre.

---

## Why this matters

Same-day damage recovery is the highest-leverage operational moment in the entire product. A R3,000 broken kettle caught and billed to the guest within 18 hours is R3,000 recovered. The same kettle noticed three days later is almost certainly absorbed by the company or charged to a grumpy owner.

The current operational pain — flags lost in WhatsApp, OTA windows missed, costs leaking — is exactly what this workflow exists to fix. If the product ships without this, it ships solving the smaller half of the problem.
