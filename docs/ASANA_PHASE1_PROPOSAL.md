# ASANA_PHASE1_PROPOSAL.md

**Type:** Phase 1 build proposal (test-boundary only). Contains the exact setup, formats, schema, and approvals for the flag → Asana one-way handoff.
**Author:** Drafted 2026-07-07
**Status:** Test project CREATED (private). No app code, no migration, no secret, no deploy yet — all gated on your approval in §11.
**Parent plan:** `docs/ASANA_INTEGRATION_PLAN.md`

---

## Business goal (restated)

When a staff member raises a flag/issue in the app, an Asana task is created **automatically** — no manual double-entry. The app saves the issue first (instant, reliable) and pushes to Asana in the background. To the user it feels automatic: *issue raised → Asana task appears.*

## Guardrail compliance (this proposal)

- Writes go **only** to the new private test project below. **No** live project is touched — not Incidents & Damages Reporting, Maintenance Control, Cleaning Control, Owner Cost Control, or any existing operational project.
- No production cutover. Importing Asana history is allowed later but is **not** part of Phase 1 and changes no live project.
- No `.env.local` change without your explicit approval. No `service_role`.

---

## 1. Exact Asana test project setup  ✅ created

| | |
|---|---|
| **Name** | Drop-Inn STR — Integration Test (BETA) |
| **Project GID** | `1216372108028101` |
| **Link** | https://app.asana.com/1/1195313768891883/project/1216372108028101 |
| **Workspace** | Arcis (`1195313768891883`) |
| **Team** | DropInn (`1210265005465779`) |
| **Privacy** | **Private** — owned by you; the team cannot see it |
| **Default view** | List |

**Sections (task routing targets):**

| App category group | Section | Section GID |
|---|---|---|
| Guest damage / incidents / guest-caused | Guest Damage & Incidents | `1216372209433460` |
| Maintenance / appliance / furniture | Maintenance | `1216372035584080` |
| Inventory missing/damaged / linen | Inventory & Linen | `1216372171871349` |
| Cleaning | Cleaning | `1216372209283198` |
| Safety (urgent) | Safety (Urgent) | `1216372209385431` |
| Notes / follow-up / observations | Notes & Follow-up | `1216379954794985` |
| Anything unmapped | Unsorted / Other | `1216372171983792` |

(There is also a "Start here" section with a single READ ME task explaining the sandbox. Everything here is disposable; the project is safe to archive or delete.)

## 2. Exact task naming format

```
[{Category group}] {property short-name} — {short summary}
```

- **Category group** = the section label (Maintenance, Guest Damage & Incidents, …).
- **property short-name** = the apartment's short/display name.
- **short summary** = the first line of the flag description, trimmed to ~70 chars.

Example: `[Maintenance] Ballito Villa 204 — Leaking tap under kitchen sink`

## 3. Exact task description / body format

Plain, scannable, with a link straight back to the app issue (so Asana is a convenience view, not the record):

```
Reported in the Drop-Inn STR app.

Property:        Ballito Villa 204
Category:        Maintenance (Broken thing)
Severity:        High
Accountability:  Needs triage
Reported by:     Quraisha R.
Reported at:     2026-07-07 14:32 (SAST)
Status:          Open

Description:
Leaking tap under kitchen sink, water pooling in cupboard.

Open in app: https://<app-domain>/properties/{propertyId}/flags/{flagId}

— Auto-created by the STR app (BETA). Do not edit the "Open in app" link.
```

Photos are **not** attached in Phase 1 (added in Phase 2 as time-limited signed links).

## 4. Fields included from the app

From the existing `flags` record (no model change): flag id, property name + id, category (display label), severity, accountability (`chargeable_party_decision` display), description, reporter name, `raised_at` (shown in SAST), status, and the **app permalink**. Safety-urgent flags also get an Asana **due date** of today. Nothing sensitive beyond what a task needs; evidence stays in the app.

## 5. How the app stores the Asana link

A new app-owned table **`external_task_links`** is the canonical record of "this flag ↔ this Asana task." For convenience, an additive nullable column `asana_task_url` on `flags` lets the issue page show a "View in Asana" button without a join. The app remains the source of truth; the link is just a pointer.

## 6. How duplicate prevention works (three layers)

1. **Unique constraint** `external_task_links (provider, entity_type, entity_id)` — the database physically cannot store two Asana tasks for the same flag.
2. **Check-before-create** — the worker looks up the link first; if one exists it *updates* the task instead of creating a new one.
3. **Outbox idempotency** — each queued event carries a dedupe key; re-processing a retried event never creates a second task.

Net effect: even if the worker runs twice, Asana is down mid-call, or a flag is edited repeatedly, exactly **one** task exists per flag.

## 7. Database migration needed (additive, gated)

Two new tables + one nullable column. **Purely additive — no change to existing rows or the category/accountability model.** Indicative shape (final SQL written only after you approve):

```sql
-- external_task_links: flag <-> external system task
create table public.external_task_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  provider text not null default 'asana',
  entity_type text not null,            -- 'flag' (later: maintenance_job, ...)
  entity_id uuid not null,
  external_id text,                     -- Asana task GID
  external_url text,
  external_project_id text,
  status text not null default 'linked',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, entity_type, entity_id)
);

-- integration_outbox: durable event queue for outbound pushes
create table public.integration_outbox (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  provider text not null default 'asana',
  event_type text not null,             -- flag.opened | flag.updated | flag.resolved
  entity_type text not null,
  entity_id uuid not null,
  payload jsonb not null,
  status text not null default 'pending', -- pending|processing|done|dead
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  dedupe_key text,
  created_at timestamptz not null default now()
);

alter table public.flags add column asana_task_url text;  -- convenience pointer
```

Both tables get company-scoped RLS consistent with the rest of the schema. This migration is **not** authored or applied until §11 approval.

## 8. Where the Asana secret is stored

- The deployed worker authenticates with its **own** Asana credential — a **Personal Access Token** you generate (Asana → My Settings → Apps → Developer → *Personal access tokens*).
- It is stored as a **Supabase Edge Function secret** (`ASANA_ACCESS_TOKEN`) via `supabase secrets set`, server-side only.
- It is **never** committed, never in the client bundle, and **not** placed in `.env.local` (no `.env.local` change without your explicit approval). No `service_role` is used.

## 9. Feature flag / kill switch

Two switches, both instant and deploy-free:

- **Per-company setting** (`integration_settings`): `asana_enabled` (bool), `asana_project_id` (the test GID above), `asana_mode` = `test`. Flipping `asana_enabled` to false is the **kill switch** — flags simply stay `asana_pending`, nothing breaks, nothing is lost.
- **Global worker guard** (`INTEGRATION_WORKER_ENABLED`) so the whole outbound worker can be paused at once.

Phase 1 ships with `asana_mode = test` hard-pinned to the test project — it is not *possible* to write to a live project until Phase 3 config changes.

## 10. What happens if Asana is down

Nothing the user sees. The issue is already saved in the app. The outbox row stays `pending` and the worker retries with exponential backoff (≈1m → 5m → 30m → 2h …), up to a capped number of attempts; after that it is marked `dead` and surfaced in a small admin log for a human to retry. When Asana recovers, the backlog drains automatically. `asana_pending` stays visible until the task is confirmed created — so there's always an honest signal, never a silent loss.

## 11. What you need to approve before I create anything (code)

The test project is done. Before I write/deploy any Phase 1 code, I need your explicit go-ahead on:

1. **Author + apply the migration** in §7 (staging first). *(Gated by the "no migrations without approval" rule.)*
2. **The Asana credential**: you generate a Personal Access Token; approval to store it as a Supabase secret (not `.env.local`).
3. **Worker mechanism**: I recommend a **Supabase Edge Function** on a short schedule (keeps it near the DB, no extra infra). Approval to create + **deploy** it to staging. *(Deploy is gated.)*
4. **Turn the feature flag on in staging** for one test company.
5. **Auth choice confirmation**: PAT for the beta now, OAuth before any future production phase.

Until you approve these, Phase 1 does not start — only the (already-approved) test project exists.

## 12. Step-by-step: create the Asana test project manually (fallback)

Already created for you, but if you ever want to recreate or verify it yourself:

1. Asana → **+ New project → Blank project**.
2. Name: `Drop-Inn STR — Integration Test (BETA)`.
3. Team: **DropInn**.
4. Privacy: set to **Private to me** (top-right privacy dropdown) so the team can't see it.
5. Default view: **List**.
6. Add sections: Start here, Guest Damage & Incidents, Maintenance, Inventory & Linen, Cleaning, Safety (Urgent), Notes & Follow-up, Unsorted / Other.
7. Copy the project ID from the URL (`.../project/<ID>`) and send it to me — I'll wire the app to that ID instead.

## 13. What happens next / open decisions

- **You**: land 9C.1 locally (lint/build → commit → merge), then approve the §11 items when ready.
- **Me (on your approval)**: author the migration → build the outbound layer + Asana provider + Edge Function worker → wire to the test project → switch on in staging → we watch a real flag become a test task.
- **Open decisions** (my recommendations): worker = Edge Function; auth = PAT for beta; keep everything in one test project for Phase 1 (per-project routing waits for Phase 3). Tell me if you'd prefer otherwise.
