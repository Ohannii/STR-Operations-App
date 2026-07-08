# ASANA_INTEGRATION_PLAN.md

**Type:** Architecture + phased rollout plan (planning doc — no app code, no writes to Asana)
**Author:** Drafted 2026-07-07
**Status:** DRAFT for founder review. Nothing here has been built or written to Asana. Read-only Asana inspection completed 2026-07-07.
**Companions:** `docs/PRE_9A_DECISION_MEMO.md`, `docs/FIVE_ADVISOR_SIGN_OFF_2026-06.md`, `CLAUDE_PROJECT_SKILLSET.md` (STR Ops Product Quality Standard).

---

## 1. Purpose

Give the STR Operations Platform a **safe, scalable, one-way handoff** from an app flag/issue to an Asana task, without ever making Asana the source of truth and without hard-coding Asana into the core. This document is the plan we approve **before** any schema, secret, or code work begins.

## 2. Guardrails (binding — from the decision memo + project rules)

1. **App is the source of truth.** Asana is an *optional outbound adapter*, never the brain.
2. **One-way first** (app → Asana). No inbound/two-way sync until one-way is stable.
3. **Test projects only, no live writes** during development. The live projects below are off-limits until an explicit production cutover (Phase 3).
4. **No migration, secret, `.env.local`, `service_role`, or deploy change without explicit approval.** This plan *identifies* those needs; it does not action them.
5. **Adapter, not hard-wire.** The design must let a future PMS / WhatsApp / other tracker plug in without a rewrite.
6. Every phase passes the **STR Ops Product Quality Standard** quality gate before it ships.

## 3. Current-state findings (grounded, read-only, 2026-07-07)

Workspace: **Arcis** (`1195313768891883`). Relevant team: **DropInn** (`1210265005465779`).

The live Asana projects that already mirror the app's operational model (these are the eventual **Phase 3** production targets — **do not touch before then**):

| App concept | Live Asana project | GID | ~Tasks |
|---|---|---|---|
| Incidents / guest damage / safety | **Incidents & Damages Reporting** | `1211426202387126` | 1,568 |
| Maintenance | **Maintenance Control** | `1208811122490679` | 920 |
| Inventory movements | **STR Operations – Movement log** | `1214135744922243` | 385 |
| Cleaning | **DropInn Cleaning Control** | `1210261184789949` | 3,426 |
| Linen / laundry | **DropInn Laundry Control** | `1210400089609247` | 1,737 |
| Owner-chargeable cost | **DropInn Owner Cost Control** | `1210658838000775` | 230 |
| HOA / building | **Body Corporate Fines and Incidents** | `1211520231182220` | 16 |
| WhatsApp intake (context) | **Incidents reporting via WhatsApp group** | `1211850424382285` | 279 |

**Implication:** these are real, heavily-used registers. Integration development must be sandboxed to a **new test project** so a mapping bug can never corrupt live operational data.

## 4. Architecture — generic outbound integration layer (adapter pattern)

Rather than "app calls Asana," we introduce a small, provider-agnostic layer so Asana is one implementation behind an interface.

**Two new persistent concepts (app-owned, in Supabase):**

- **`external_task_links`** — the durable 1:1 (or 1:many) mapping between an app record and its counterpart in an external system. Columns (indicative): `id`, `company_id`, `entity_type` (`flag` | `maintenance_job` | `inventory_movement` …), `entity_id`, `provider` (`asana` | …), `external_id` (Asana task GID), `external_url` (permalink), `external_project_id`, `status`, `last_synced_at`, `created_at`. Uniqueness on `(provider, entity_type, entity_id)` prevents double-creation.
- **`integration_outbox`** — a durable event queue. When something happens in the app that should reach an external system, we write a row here (transactionally with the app change) instead of calling Asana inline. Columns (indicative): `id`, `company_id`, `provider`, `event_type` (`flag.opened`, `flag.updated`, `flag.resolved` …), `entity_type`, `entity_id`, `payload` (jsonb snapshot), `status` (`pending` | `processing` | `done` | `dead`), `attempts`, `next_attempt_at`, `last_error`, `created_at`. This is the **outbox pattern** — it decouples the user action from the (slower, failure-prone) network call and gives us idempotency, retries, and an audit trail.

**Provider interface (code, later):** a `TaskProvider` with `createTask(mapped)`, `updateTask(externalId, mapped)`, `resolveTask(externalId)`. `AsanaProvider` implements it using the connector. A future `PmsProvider` / `WhatsAppProvider` implements the same interface — **no core changes** to add a provider.

**Worker:** a single processor (Supabase Edge Function on a schedule, or a small server route triggered by cron) drains `integration_outbox` → maps the payload → calls the provider → writes/updates `external_task_links` → marks the row `done` (or retries with backoff, or `dead` after N attempts).

Why this shape: it keeps the app fast (no blocking on Asana), safe (retryable, idempotent, auditable), and scalable (one queue serves many providers and 100+ properties / future multi-tenant clients).

## 5. Trigger & lifecycle (one-way)

The app already models the intent via the operational state **`asana_pending`** (new flags auto-receive it; guest-damage flags also get `guest_notify_pending`). We build on that rather than inventing a new trigger.

```
Flag created ──▶ state: asana_pending ──▶ (transaction) write integration_outbox row (event flag.opened)
                                                        │
                                          worker drains outbox
                                                        │
                                  AsanaProvider.createTask(mapped) ──▶ Asana task (TEST project in Ph1/2)
                                                        │
                     write external_task_links(flag ↔ task GID + permalink)
                                                        │
                 clear asana_pending ──▶ state: asana_synced (+ store permalink on the flag for the UI)
```

Subsequent flag edits/resolution enqueue `flag.updated` / `flag.resolved` events; the worker updates or completes the linked task. If Asana is unreachable, the outbox retries — the field user never sees an error and no data is lost.

## 6. Field mapping (flag → Asana task)

| Asana field | Source |
|---|---|
| Task **name** | `"[{Category}] {property short-name} — {one-line summary}"` |
| **notes / html_notes** | Description, severity, accountability, reporter, timestamp, **permalink back to the app issue** |
| **Section** (Phase 1 test project) | Category group (Damage / Maintenance / Inventory / Cleaning / Safety / Note) |
| **Due date** | Set only for `safety_urgent` (same-day) initially |
| **Custom fields** (Phase 2+) | Severity, Accountability, Property — mapped to Asana custom-field GIDs once we read the target project's field schema |
| **Attachments** (Phase 2+) | Evidence photos as signed links first, native attachments later |

**Project routing** (which Asana project a flag lands in): **Phase 1/2 → one test project, sectioned by category.** **Phase 3 → per-category routing** to the live projects in §3, driven by config (below), not hard-coded.

## 7. Configuration & multi-tenancy

All environment- and company-specific values live in config, never in code branches:

- **Environment**: `test` (Phase 1/2) vs `production` (Phase 3) selects the target workspace/project GIDs.
- **Per-company mapping**: `company_id → {provider, project routing}` so the same engine serves DropInn today and future PMS clients without forking. (The app is already designed for 100+ properties / future clients.)
- **Feature flag / kill switch**: integration can be turned off instantly without a deploy; when off, `asana_pending` simply stays pending (no data loss).

## 8. Security & secrets

- Asana auth (PAT or OAuth) is **server-side only**, stored in Supabase/Vercel secrets — **never** committed, never in the client bundle, and **not added to `.env.local` without explicit approval**.
- The worker runs with least privilege; no `service_role` use without explicit approval.
- Outbound payloads carry only what the task needs; evidence is shared as time-limited signed URLs, not public links.

## 9. Phased rollout

| Phase | Goal | Key work | Gate to exit |
|---|---|---|---|
| **0 — Scoping (this doc)** | Agree architecture & guardrails | Read-only Asana inspection ✅, this plan | Founder approves the plan |
| **1 — Sandbox build** | One-way push to a **test** project, behind a flag | Migration for `external_task_links` + `integration_outbox` (**approval-gated**); `AsanaProvider`; worker; map flag→task; create **new** test project | Green build/lint; a flag created in staging appears as a task in the **test** project; link + permalink stored; no live project touched |
| **2 — Staging validation** | Prove reliability | Enable auto-push on `asana_pending` in staging; test idempotency, retries, dead-letter, updates/resolution; custom-field mapping | Repeated runs create no duplicates; failures retry cleanly; mapping reviewed |
| **3 — Production cutover** | Push to the **live** projects (§3) | Per-category routing config; kill switch; staged enablement (start with one low-volume category, e.g. HOA, before Incidents) | Explicit approval; monitored first-day; rollback rehearsed |
| **4 — Later (optional)** | Richer integration | Two-way status (Asana → app), native attachments, additional providers (WhatsApp/PMS) | Separate plan + approval |

## 10. What needs explicit approval BEFORE any code (Phase 1)

1. **A migration** to create `external_task_links` + `integration_outbox` (new tables; additive, no change to existing data). — *gated by the project's "no migrations without approval" rule.*
2. **An Asana credential** stored as a server secret. — *gated by the secrets / `.env.local` rule.*
3. **Creating one new TEST Asana project** (e.g. "Drop-Inn STR — Integration Test", DropInn team). This is a *write* to Asana, so I will propose it and let you approve before I create it.
4. Agreement on the **worker mechanism** (Supabase Edge Function vs. cron-triggered route).

None of these are done yet. Phase 1 does not start until you approve them.

## 11. Open decisions for Anni

- **Auth**: personal access token (fast) vs OAuth app (cleaner long-term, more setup). Recommendation: PAT for Phase 1 test, OAuth before Phase 3 production.
- **Worker**: Supabase Edge Function (keeps it near the DB, no extra infra) vs Vercel cron route. Recommendation: Edge Function.
- **First production category** (Phase 3): recommend starting with a **low-volume** register (e.g. Body Corporate, 16 tasks) to prove production safety before touching the 1,568-task Incidents register.
- **Do we route by category to multiple live projects on day one, or push everything to Incidents & Damages first?** Recommendation: single project first, add routing once stable.

## 12. Non-goals (explicitly out of scope for now)

Two-way sync; editing/closing existing live Asana tasks; importing Asana history into the app; touching any live project before Phase 3; any change to the category/accountability model; any deploy. The app remains fully functional with the integration turned off.
