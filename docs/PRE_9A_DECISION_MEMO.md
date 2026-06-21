# PRE_9A_DECISION_MEMO.md

**Type:** Decision memo — to be ratified before Session 9A coding
**Date:** 2026-06-21
**Companion:** `APP_AUDIT_2026-06.md` (the evidence behind these decisions)
**Status:** Proposed. Each decision has a recommended answer; mark each **Accepted / Amended / Rejected** after review.

> Purpose: settle the small number of structural decisions that are cheap to make on paper now and expensive to unwind once flags → maintenance → inventory → accountability → reports → integrations are wired together. The goal is a bulletproof, asset-protecting framework that stands on its own and adapts across verticals.

---

## How to read this memo

Each decision states: **the question**, the **options**, the **recommendation**, the **why**, what it **unblocks**, and what to **avoid**. Nothing here is code. No schema is changed by accepting these — most are direction + documentation, with a small, well-scoped data migration only for the taxonomy.

---

## Decision 1 — Canonical inspection model

**Question.** Is the structured "an inspection happened" record the rich `inspections` engine, or the lightweight `evidence_packs` the v1 UI currently ships on?

**Options.** (A) Keep extending `evidence_packs` as the de-facto inspection. (B) Make `inspections` the canonical operational event and connect `evidence_packs` to it. (C) Leave both growing in parallel.

**Recommendation: (B).** `inspections` is the canonical operational workflow/event; `evidence_packs` is the durable evidence/report output attached to it (see Decision 2). Adopt the model now in documentation; wire the UI to it incrementally. (C) is the failure mode — never let both grow as rivals.

**Why.** `inspections` already has what the operation needs and `evidence_packs` cannot express: structured checklist items (`inspection_items`, pass/fail), templates (`template_kind` → checkout / pre-arrival / tenant ingoing-outgoing / snagging / annual audit), the readiness gate (`ready_for_next_guest` + `ready_blocker_reason`, which is exactly the QC-fail mechanism), and offline idempotency (`client_uuid`). Building QC-fail or checkout on `evidence_packs` would re-implement all of this badly.

**Unblocks.** QC-fail/cleaner callback, checkout inspections, annual audits, and multi-vertical inspection kinds — all become "a template + UI on an existing engine," not new schema.

**Avoid.** A big-bang migration. Move pre-arrival onto `inspections` one slice at a time; the durable packs and photos already in flight keep working because photos are addressed by id, not by which parent they hang off.

---

## Decision 2 — Durable evidence pack / report model

**Question.** What is an evidence pack, and how long does it live?

**Recommendation.** An **evidence pack is a durable, retained evidence/report output** — a defensible record (photos + notes + metadata + signed report) attached to an inspection, flag, QC fail, claim, audit, or maintenance issue. It is **not** disposable and **not** short-lived.

**Retention rules (retain-by-default).**
- Pre-arrival packs: retained **at least 6 weeks after checkout** as a floor.
- Retained **indefinitely / until provably safe** when tied to a dispute, owner query, guest/OTA claim, audit, owner-chargeable item, or open accountability/maintenance record.
- Retention promotion is **one-way** (routine → dispute); never demote.
- The purge job must **never** delete a pack linked to an unresolved dispute/claim/audit/owner query/accountability record. Purge is the exception that must prove safety, not the default.

**Integrity (for asset protection / disputes).** Submitted packs are **immutable / append-only** — you may add a clarifying note or photo (audited), never rewrite or delete originals. Add a per-photo content hash (e.g. SHA-256) at upload so an image can later be proven unaltered. Keep a verified server-side capture timestamp alongside the device `captured_at`.

**On "interim".** The only interim thing is the *current v1 UI*, where pre-arrival packs exist standalone and are not yet linked to a formal `inspection`. That is an implementation gap to close — not a comment on their importance or lifespan.

**Unblocks.** Owner/guest/OTA evidence delivery; QC-fail report; confident long-horizon dispute defence.

**Avoid.** Any wording, UI, or job that treats packs as temporary; any storage-cost optimisation that risks deleting durable evidence. Cost is managed by compression + thumbnails + tiered storage (R2), **not** by early deletion.

---

## Decision 3 — Roles posture

**Question.** Do we enforce roles now, and with what split?

**Recommendation.** Enforce a **minimal permission matrix now**, server-side and auditable. Add a `cleaner` role (currently not seeded). UI gating is for convenience; the **server action / RLS layer is the authority**, especially for accountability and owner-sensitive writes.

**Proposed matrix (starting point).**

| Capability | company_admin | gm / ops_manager | inspector | maintenance_coord / tech | cleaner |
|---|---|---|---|---|---|
| Run & sign off own inspection tasks | ✅ | ✅ | ✅ | — | ✅ (cleanliness checklist only) |
| Raise flags (incl. item missing/damaged/issue) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Capture evidence / submit pack | ✅ | ✅ | ✅ | ✅ | ✅ (their checklist) |
| Set / change **final accountability** | ✅ | ✅ | — | — | ❌ |
| Close maintenance / accountability / owner-sensitive items | ✅ | ✅ | — | ✅ (maintenance only) | ❌ |
| Approve charges within policy | ✅ | ✅ | — | — | — |
| View owner financials / reports | ✅ | ✅ | limited | — | ❌ |

Notes: inspectors may **close inspection tasks for now**; cleaners may **complete/sign off their cleanliness checklist and raise/report issues** (including "item missing / damaged / there's an issue") but may **not decide final accountability** or close owner-sensitive items unless explicitly granted later. **Every close/sign-off writes an `audit_events` row** (the trail already exists — make coverage complete).

**Owner role (future, view-only — and a different scoping model).** Owners are not staff. They get a restricted, **view-only** portal scoped to **their own properties only** — via `property_owner_links`, **not** company membership — which means owner access needs **its own RLS path**, separate from `is_company_member()`. Owners may see: apartment health/readiness, open maintenance issues, breakages/damages, owner-chargeable items, completed repairs, and selected/shared evidence reports and owner-relevant requests. Owners must **not** see: unrelated properties, private guest details, internal staff task noise, sensitive internal notes, company-wide dashboards, or internal profitability/recovery workflows unless explicitly shared. Owners may **submit owner requests**, but those enter as **controlled records** (a request type staff triage) — never operational control. `owner` is not a seeded role yet; add it alongside `cleaner`.

**Why.** This is asset protection: it stops the wrong person quietly assigning cost responsibility or closing an owner-sensitive item, and it is a precondition for letting non-managers (cleaners, contractors) into the app during staff testing and for any second company.

**Unblocks.** Safe staff testing; SaaS onboarding; the cleaner QC flow.

**Avoid.** Enforcing only in the UI (trivially bypassed); over-engineering a full RBAC matrix before it is needed — ship the coarse, sensitive gates first (accountability, owner financials, sign-off), refine later.

---

## Decision 4 — Taxonomy + accountability + retention/back-fill

**Question.** How do we separate issue category from accountability without breaking evidence retention or existing flags?

**Recommendation.** Split the two dimensions and re-derive retention from **both**.

- **Issue category (what):** clean `flag_categories` to pure issue types — Maintenance, Inventory / item missing, Item damaged, Cleaning / housekeeping, Linen / towels, Safety, Access / keys / lock, Appliance / furniture, Guest incident, Follow-up, Record-only. Remove the accountability values masquerading as categories.
- **Preliminary accountability (who may pay):** expand `flags.chargeable_party_decision` (a free-text column, so this is code-only) to: Unknown / needs-assessment (default), Guest damage, Owner wear & tear, Owner chargeable, Company absorbed, Contractor / maintenance fault, Cleaning team, HOA / building, Internal operations. Editable after triage; never set as final by an inspector or cleaner (Decision 3).
- **Retention re-mapping (critical):** `retention.ts` currently keys off category, including `guest_damage` and `owner_chargeable`, which are moving to accountability. Re-derive the retention class from **category + accountability together** so dispute / owner-chargeable evidence is still classified for long retention. Validate this mapping before the migration.
- **Back-fill:** map existing flags whose category was an accountability concept (e.g. `guest_damage` → category "Guest incident"/"Item damaged" + accountability "Guest damage"; `owner_chargeable` → accountability "Owner chargeable"; `company_responsibility` → accountability "Company absorbed"). Test on staging first; preserve all evidence and audit history (append-only).

**Unblocks.** The Raise Flag redesign (Slice 1), clean downstream accountability, and correct legal retention.

**Avoid.** Shipping the taxonomy split before the retention re-map and back-fill are written and tested — that would silently mis-retain dispute evidence.

---

## Decision 5 — Integration principle (app is source of truth)

**Question.** What is the contract between the app and Asana / PMS / WhatsApp?

**Recommendation.** The app is the **source of truth** for inspections, evidence, flags, accountability, and reports. Integrations are **pluggable adapters behind a stable internal port** — never owners of canonical data.

- **Inbound adapters (feed the app):** PMS / channel managers — Hostaway, Guesty, NightsBridge — push reservations / dates / stays / turnaround schedules and may *trigger* inspections. The app owns everything once created.
- **Outbound adapters (the app feeds them):** Asana / Trello (tasks), WhatsApp / Slack / email (reports + notifications), accounting (cost recovery). **One-way export first.**
- **Asana specifics:** new **test** Asana projects only; **no live writes**; current exports are read-only field-mapping reference, not a mandate. Map Incidents & Damages ← flags + accountability_records + recovery; Maintenance Control ← issues + maintenance_jobs; Movement Log ← inventory_movements.

**Cheap now, valuable later.** When export is built, model a generic `external_task_links` concept (entity → external system → external id + status) instead of an Asana-specific column. That keeps Asana optional and makes new tools additive.

**Unblocks.** Drop-Inn's Asana workflow without coupling the product to it; future PMS ingestion; future Slack/other tools.

**Avoid.** Any design where the app cannot function if an external tool is absent; hardcoding Asana into core tables.

---

## Decision 6 — Future adaptability (STR, estate agency, construction)

**Question.** Do we build STR-only, or a model that extends to long-term rentals and construction snagging?

**Recommendation.** Keep the **inspection abstraction vertical-agnostic** from now on; verticals are configuration, not forks.

- **One engine, many template kinds:** `str_pre_arrival`, `str_checkout`, `ltr_ingoing`, `ltr_outgoing`, `construction_snag`, `annual_audit`. The *kind* is data; the engine renders checklist + evidence.
- **Decouple from STR-only concepts:** an inspection must run with **no** stay (the stay links are already nullable). For long-term rentals "stay" becomes a tenancy; for construction there is no occupancy. Treat occupancy as optional context.
- **Configurable labels per company/vertical:** "property", "guest", "owner" map to "unit/site", "tenant", "landlord/developer" without schema change.
- **Evidence annotations (arrows / blocks / markups) — non-destructive:** store annotations as an overlay layer over the untouched master (`annotations` JSON or a `photo_annotations` table), never baked into the original. Preserves chain-of-custody for disputes and snagging alike.

**Why.** This is what makes the app "next level": the same evidence-and-accountability spine that protects STR owners protects landlords against tenant deposit disputes and developers against snagging disputes — a far larger market — with configuration rather than a rebuild.

**Avoid.** Hardcoding STR words and STR-only flows (stay-required inspections, OTA-only language) into the core engine.

---

## Decision 7 — Product terminology ("Report issue", not "Raise a ticket")

**Question.** Should the user-facing "Raise a flag" become "Raise a ticket"?

**Recommendation.** No — not "ticket". Use **"Report issue"** (or "Raise issue") as the user-facing action. "Ticket" implies an assigned work item, but a reported issue may become any of: maintenance ticket, inventory replacement request, cleaner callback / QC fail, deep-clean / soft-furnishing / fumigation / linen-wash request, owner request, guest/OTA evidence record, or record-only. Forcing "ticket" mislabels most of them.

**The three-layer language (use consistently everywhere).**
- **"Report issue" = the user-facing action** — what an inspector or cleaner taps.
- **Flag = the internal parent evidence/control record** — keep the `flags` table as-is for now; **do not rename tables.** One real-world problem = one flag.
- **Ticket / task / request = the downstream action** created from the issue (maintenance job, inventory movement, cleaner callback, owner request, etc.), each hanging off the parent flag.

Flow: inspector **reports an issue** → app creates the parent flag (evidence/control) → app asks or derives what action is needed → the appropriate downstream ticket/task/request is created.

**Unblocks.** A clear mental model for the Raise Flag redesign (Slice 1): the UI label becomes "Report issue", the category/accountability split sits underneath, and downstream-action selection comes after.

**Avoid.** Renaming the `flags` table now (churn for no gain); using "ticket" as the umbrella term (it is only one of many downstream outcomes).

---

## Decision 8 — Apartment readiness model ("Today's inspections")

**Question.** How does the team see, at a glance, whether an apartment is ready for the next guest — without a misleading "green forever" status? *(Founder delegated the baseline; this is the lead recommendation, to be brainstormed further before build.)*

**Recommendation.** Readiness is a **derived, reservation/date-aware display state computed per turnover** — never a permanently stored "ready" flag. Baseline state set:

| State | Shown when | Tone |
|---|---|---|
| Ready for arrival | Final pre-arrival inspection marked ready for the current/upcoming check-in | Green |
| Inspection pending | Check-in due (today/soon) and no completed ready pre-arrival inspection yet | Amber (red only if overdue past check-in time) |
| Cleaner callback — QC failed | Pre-arrival failed QC (`ready_for_next_guest = false`, cleaning blocker) | Red/amber |
| Blocked — action needed | Open arrival-blocking item (safety flag, blocking maintenance, missing essential inventory) | Red |
| No check-in today | No check-in in the active window | Neutral — show "Last ready check: <date>" |
| Upcoming — inspection required | Future check-in scheduled, not yet inspected | Info |

**Derivation (compute it; do not store a status column — same pattern as the derived flag "Closed" state).** Source signals: the latest pre-arrival inspection's `ready_for_next_guest` + `ready_blocker_reason`; open arrival-blocking flags/issues; and the next reservation/check-in date. Readiness is **per-turnover** — once the guest checks in or the date passes, it resets; it never carries green into the next cycle.

**Reservation-date source (phasing).**
- *Phase 1 (interim, no PMS):* drive off a manual "next check-in" date plus the active turnover/pre-arrival pack; with no date, fall back to "No check-in today / Last ready check".
- *Phase 2:* the inbound PMS adapter (Decision 5) populates `stays` with check-in/out dates → full reservation-aware readiness across the portfolio.

**Arrival-blocking rule (baseline).** Readiness is blocked by: an open `safety` flag, an open maintenance flag/issue explicitly marked blocking, an unresolved QC fail, or a missing **essential** inventory item. Refine the "essential" set per company later.

**The apartment dashboard must show:** current readiness state, **last inspected date/time**, and **last ready check**. (Today the property card hardcodes "Last inspection: Never" — replace with the real derived values.)

**Guiding rule.** **Do not show urgent red when there is no imminent check-in.** Avoiding alarm fatigue is the difference between a status managers trust and one they mute.

**Unblocks.** A "Today's inspections / readiness" CX view managers rely on; gives the QC-fail loop a natural home.

**Avoid.** A stored `is_ready` boolean; permanent green; red status on apartments with no upcoming arrival.

---

## Decision 9 — UX non-negotiables ("Powerful system, simple surface")

**Principle (binding).** **Powerful system, simple surface.** The app may be sophisticated underneath — inspections, evidence, accountability, owners, cleaners, maintenance, Asana, PMS adapters — but every screen a real staff member touches must feel obvious. Complexity is the engineering's problem, never the user's. This is **not aspirational polish; it is a release constraint**, equal in weight to tenant isolation and evidence durability. (Consistent with the section limits in `APARTMENT_ACTION_CENTRE.md` and the 12 stupid-proof rules in `CLAUDE_PROJECT_SKILLSET.md`. Doubles as a candidate product tagline — "Powerful system, simple surface" / "Powerful system, managed simply.")

**The fifteen rules.**
1. Staff should not need training to understand the next action.
2. Plain English — never internal terms, enum names, or technical language.
3. Don't show every possible workflow option at once.
4. Progressive disclosure — surface the next relevant question/action only when needed.
5. Role-specific screens are simple and focused.
6. Mobile-first = big tap targets, minimal typing, clear buttons, no sideways overflow.
7. Every screen answers one question: "What do I need to do now?"
8. Sensible defaults — staff only make decisions they are qualified to make.
9. "Show more" / "view all" to prevent overwhelming lists (≈7 items per section before collapse).
10. Cleaners see a very simple checklist + issue-reporting flow — nothing else.
11. Inspectors see inspections, report-issue, evidence, and readiness actions.
12. Managers see exceptions, readiness, unresolved work, and decisions.
13. Owners see a calm, curated, view-only health/reporting portal — no internal staff noise.
14. It must not feel like Asana, Excel, or a database.
15. Every sophisticated workflow still feels like a guided, step-by-step assistant.

**Configurability vs simplicity (the load-bearing rule).** The app must be highly adaptable across companies and industries (STR, long-term rentals, construction) — but **adaptability lives in the admin/setup layer, not in the field user's face.** A cleaner or inspector never sees configuration; they see the one workflow their role needs, pre-shaped by setup. Power is configured once by admins; simplicity is delivered every day to staff.

**How this binds the build.** Every Session 9A slice ships only if it passes a "could a brand-new staff member use this under pressure, on a phone, with no training?" check. The brightest button on any screen is always the next action. If a flow cannot be made obvious, the founder is told before it ships.

**Avoid.** Power-user density; exposing taxonomy/accountability/config to field roles; one screen serving three roles at once; any list that grows unbounded.

---

## Summary — what to do with this memo

1. Review with the five advisors; mark each decision Accepted / Amended / Rejected.
2. On acceptance, the only near-term **data** work is the **taxonomy split + retention re-map + back-fill** (Decision 4). Everything else is direction, documentation, and incremental wiring — including Decision 7 (terminology = UI labels) and Decision 8 (readiness = a derived view, no stored column, no migration).
3. Then proceed to Session 9A **Slice 1 (Raise Flag redesign)**, which is the foundation the rest depends on.

**Pre-build gates (must be green before scaling further):** cross-tenant isolation test run + in CI; PITR confirmed enabled; the role split enforced server-side; the durable-evidence retention rules documented and the purge job written as retain-by-default; and **every shipped slice passes the Decision 9 check — usable by a new staff member, under pressure, on a phone, with no training.**
