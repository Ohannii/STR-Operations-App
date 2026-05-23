# INTEGRATION_ROADMAP.md

## Plain-English overview

The MVP does **not** require any integrations. That is the whole point of an evidence-first system — it has to be useful on its own.

Integrations come later. When they do, they fit through a thin **adapter layer** so that no third-party SDK ever pollutes core tables.

---

## MVP approach

- No live integrations.
- No webhook endpoints exposed.
- No third-party SDKs in the codebase except for things we *use ourselves* (Supabase, Sentry).
- The data model is shaped so that integrations can attach later without rewriting tables.

---

## Phasing summary

| Integration | Phase | Why this phase |
|---|---|---|
| Hostaway (property + reservation sync) | v1.5–v2 | Highest customer pull; STR companies live in it. |
| WhatsApp Business API (share links + notifications) | v1.5 | Cheapest way to massively improve adoption. |
| Email (transactional) | v1 (basic) | Already needed for password reset; expand in v1.5. |
| Asana (copy-paste summary → optional outbound push) | transition / v1.5 | Optional mirror for teams already on Asana. One task per parent flag. Never a dependency. |
| Slack (notifications) | v2 | Good for internal ops teams. |
| Google Calendar (maintenance schedule) | v2 | Coordinator convenience. |
| Airbnb / Booking.com direct APIs | v3+ | OAuth flows are heavy; defer until a customer pays for it. |
| Guesty | v3+ | Same reasoning as Hostaway, second priority. |
| Accounting (Xero / QuickBooks) | v3+ | Useful but heavy; many customers will export CSV. |

This is intentionally conservative. We can pull anything forward if a paying customer demands it.

---

## Integration principles

1. **Internal canonical records always come first.** A property in our database is the source of truth. Hostaway is a mirror, not a master.
2. **Adapters, not couplings.** Every integration sits behind an interface (`PropertySource`, `IssueSink`, `MessageSender`). The core code never imports a vendor SDK directly.
3. **All integrations are optional.** A company can run the product with zero integrations.
4. **Sync events are logged.** Every push, pull, or webhook delivery writes to a `integration_events` log (added when the first integration ships).
5. **Failures are visible.** A failed sync surfaces to the user; we don't fail silently.
6. **No vendor data leaks across tenants.** A Hostaway token for Company A cannot read Company B's properties.
7. **Webhooks are signed.** Inbound webhooks verify signatures; rejected payloads are logged.
8. **Backoff and retry.** Sync workers use exponential backoff with a dead-letter queue after N retries.
9. **Rate limits respected.** Each integration has explicit rate-limit handling.
10. **PII discipline.** We send the minimum data needed to the third party.

---

## Detailed roadmap

### Hostaway integration (v1.5–v2)

**Goal:** A company connects Hostaway once; properties and upcoming reservations sync into our app. Inspections can be triggered automatically by check-in/check-out events.

**Phase 1 (v1.5):**
- Read-only sync from Hostaway:
  - Pull properties → mirror to our `properties` table (linked by `external_id` on a new `property_integrations` table).
  - Pull upcoming reservations → store in a new `reservations` table.
- A company-level setting: "Hostaway API key (encrypted at rest)".
- Manual "Sync now" button + scheduled hourly sync via a cron Edge Function.

**Phase 2 (v2):**
- Inspections auto-suggested when a check-out happens (post-stay) or 24h before a check-in (pre-arrival).
- Webhook receiver for Hostaway events (where they offer one).

**What we never do with Hostaway in MVP:**
- Write back to Hostaway (no creating reservations from our app).
- Modify pricing.
- Manage messages.

**Adapter shape (pseudocode, NOT code):**

```
interface PropertySource {
  listProperties(companyId): Property[]
  listReservations(companyId, from, to): Reservation[]
}

class HostawayAdapter implements PropertySource { ... }
```

The core never knows it's talking to Hostaway. Replacing it with Guesty later is one new class.

---

### WhatsApp integration (v1.5)

**Goal:** Share inspection summaries, owner reports, and OTA packs by WhatsApp without leaving the app.

**Two phases:**

**Phase 1 — share links (v1.5, cheap):**
- Generate a **signed, time-limited share URL** for a report.
- The app opens WhatsApp on the user's phone with a prefilled message containing the link.
- No WhatsApp Business API account required.

**Phase 2 — WhatsApp Business API (v2, requires Meta approval):**
- Send templated notifications: "Inspection complete for [Property]", "Owner monthly report ready", "Maintenance job verified".
- Two-way replies routed to in-app issues.
- Requires the customer to bring their own Business API provider account (e.g. Twilio, 360Dialog) or use ours; pricing implications.

**Adapter shape:**

```
interface MessageSender {
  sendTemplate(to, templateId, vars): Result
  sendText(to, message): Result    // only allowed within 24h reply window
}
```

---

### Email (v1 basic, v1.5 expanded)

**v1:**
- Password reset (handled by Supabase Auth).
- Invitation email when a user is invited (Supabase Auth + a custom template).

**v1.5:**
- "Your monthly summary is ready" emails to owner viewers.
- "Your maintenance job is overdue" reminders.

**Provider:** Supabase Auth's default for transactional auth emails; **Resend** (cheap, simple) for everything else.

---

### Asana (optional transitional / outbound only)

**Goal:** Let teams that currently live in Asana keep a mirror during the transition period — without the app ever depending on Asana, and without duplicating one real-world problem across many tasks.

**Hard rules (these are product anchors, not just integration choices):**

1. **The app is always the source of truth.** Asana is a mirror, never a master. If the app and Asana disagree, the app wins. Asana is never required for any workflow.
2. **One Asana task per parent flag — never per child record.** When a manager taps "Copy as Asana task" on a flag card, the generated text summarises the parent flag *and* lists its children (recovery task, maintenance job, accountability) as a checklist inside that single task. Pasting it into Asana yields **one** task that mirrors **one** Action Centre card. This mirrors the deduplication discipline in `DEDUPLICATION_AND_TASK_GROUPING_RULES.md`.
3. **Outbound only.** We push; we never pull. There is no path where Asana creates or mutates app records.

**Phased delivery:**

- **Transition (available conceptually from v1.0):** manual **copy-paste** Asana summary generated from a flag card. Zero integration, zero credentials, zero dependency. This is all most teams need.
- **v1.5+ (optional automated outbound):** a per-company toggle + project ID that pushes flag-level updates to Asana via the adapter `IssueSink.sendFlagSummary(flag)`. Still one Asana task per parent flag. Still one-way. Still never required.

**What we will not build:** inbound Asana sync, per-child Asana tasks, or any flow that makes Asana load-bearing. Those would re-introduce exactly the duplication and source-of-truth confusion the product exists to remove.

---

### Slack (v2)

**Goal:** Per-company channel notifications for new high-priority issues, overdue jobs, completed inspections.

- Slack Incoming Webhook per company.
- Notification settings per role.
- Adapter: `MessageSender` (same interface as WhatsApp).

---

### Google Calendar (v2)

**Goal:** Maintenance Coordinator can sync scheduled maintenance jobs to a shared Google Calendar.

- OAuth per Coordinator user (not per company).
- One-way sync (our app → calendar).
- Adapter: `ScheduleSink`.

---

### Airbnb / Booking.com direct (v3+)

**Goal:** Pull reservations and listings without going through Hostaway.

- Both require OAuth flows + listing-level scoping.
- Booking.com Connectivity Partner certification is heavyweight.
- Defer until a customer specifically requires it and is willing to commit.

---

### Guesty (v3+)

Similar to Hostaway. Lower customer demand initially in our target market. Same adapter pattern means the work is repeatable, not novel.

---

### Accounting integrations (v3+)

Most customers will accept CSV export to start. Direct Xero / QuickBooks integration is post-MVP, post-PMF. Adapter: `LedgerSink`.

---

## What every integration needs (a checklist for later)

When we add any integration, we always do these things:

- [ ] Adapter interface + at least one alternate implementation possible
- [ ] Encrypted credential storage (Supabase Vault or equivalent)
- [ ] Per-company on/off switch
- [ ] Sync event log
- [ ] Backoff + dead-letter queue
- [ ] Rate-limit handling
- [ ] Signature verification on inbound webhooks
- [ ] PII minimisation review
- [ ] Documentation in `docs/INTEGRATION_ROADMAP.md` (this file) with the actual scope shipped
- [ ] Manual test plan in `docs/TESTING_CHECKLIST.md`
- [ ] Customer-facing setup guide

---

## Things we are explicitly NOT integrating with — ever (in MVP scope)

- Any service that requires storing payment card data.
- Any service that auto-charges customers without human approval.
- Any service that allows AI to talk to guests directly without human review.
- Any service that requires us to host their guest PII long-term.
