# OPERATIONS_LOGIC_TEST.md

## Purpose

This document is the project memory of the operational logic test conducted in the founder review phase, before any tooling setup or code. It captures: what was tested, what passed, what failed, what changed.

This is the source-of-record for *why* v1 is staged the way it is and *why* certain entities exist that wouldn't be obvious from the surface features.

---

## Test conducted

Date: 2026-05-12

A full end-to-end operational logic walkthrough against the planning blueprint, using the real-world context of the first customer (the founder's STR operation). The test deliberately ignored the planning docs' framing and re-derived requirements from the actual operational problem.

## Real-world context tested against

- Hundreds of apartments under management, expected to grow.
- ~300 pre-arrival inspections/month.
- ~50 annual audits/year.
- High daily operational chatter currently scattered across Asana, WhatsApp, spreadsheets, photo folders.
- Heavy reliance on WhatsApp for ops messages.
- Owner expectations: weekly heartbeat, monthly charge summary, clear evidence on disputes.
- Same-day guest damage recovery is critical.
- Small, unskilled team — UI must be "stupid-proof."
- Cost recovery cascade: every Rand of damage must end up paid by someone (guest → company → owner fallback).
- Company example: Dropinn cannot approve internally: inventory items > R1000, maintenance items > R2000, owner charges > R2000/month, owner charges > R60,000/year. Limits vary by company, owner, and property.

## Verdict

**Proceed with changes.** Foundation is good. Six critical structural gaps must be closed in v1.0's schema (even if their UI ships later). Specifically:

1. Approval policies table.
2. Cost recovery cascade on accountability.
3. Pre-arrival inspection promoted to v1.0 (was v1.3).
4. Flag taxonomy expanded (was OK/Damaged/Missing/Attention only).
5. Apartment Action Centre as the home surface.
6. Photo retention class on every photo.

## Coverage matrix

See response in session log. Full matrix preserved here:

| Operational need | Status before test | Action taken |
|---|---|---|
| Property management with owner / staff / history | ✅ Covered | None. |
| Apartment "needs attention" home surface | ❌ Missing | New doc `APARTMENT_ACTION_CENTRE.md`; ship basic version in v1.0. |
| Mobile camera + attach to line items | ✅ Covered | None. |
| Photos attach to issues / maintenance / inventory | ✅ Covered | None. |
| Offline capture + sync clarity | ✅ Covered | None. |
| Pre-arrival inspection as core workflow | ⚠️ Deferred to v1.3 | **Promoted to v1.0** alongside post-stay. |
| Pair pre-arrival ↔ post-stay | ❌ Missing | Add `stays` entity linking inspections. |
| Different retention per photo type | ❌ Missing | New doc `PHOTO_RETENTION_POLICY.md`; `retention_class` column on every photo from v1.0. |
| Same-day guest damage recovery | ❌ Missing | New doc `GUEST_DAMAGE_RECOVERY_WORKFLOW.md`; ship in v1.1. |
| Copy-paste message generator | ❌ Missing | Template-based, no API. v1.1. |
| Cost recovery cascade | ❌ Missing | Update `INVENTORY_AND_MAINTENANCE_LOGIC.md`; multi-attempt chain on accountability records. |
| Flag taxonomy (11+ types) | ❌ Missing | New doc `FLAG_AND_ACTION_MODEL.md`; `flag_categories` from v1.0. |
| Configurable approval limits | ❌ Missing | New doc `APPROVAL_LIMITS_AND_CONTRACT_RULES.md`; `approval_policies` table from v1.0. |
| Weekly owner status update | ❌ Missing | New doc `OWNER_COMMUNICATION_WORKFLOWS.md`; ship in v1.3. |
| Monthly owner charge summary | ✅ Covered | None. |
| Annual audit workflow | ❌ Missing | Add "Annual audit" as v1.0 seed template type. |
| Role visibility (tech, inspector, owner) | ✅ Covered | None. |
| App replaces Asana | ⚠️ Partial | Action Centre + flag taxonomy makes this real. |
| Stupid-proof UX | ⚠️ Implicit | Added as first-class principle in `CLAUDE_PROJECT_SKILLSET.md`. |

## Critical insights captured

### Insight 1 — the product's centre of gravity shifted

Before the test: the product was framed primarily as "post-stay damage evidence with an owner summary bolted on."

After the test: the product is **"an operational source of truth where pre-arrival evidence, post-stay recovery, and ongoing operational tracking all have equal status, and where every flag has a clear next action and every cost has a recovery cascade."**

That reframing is the reason for several of the structural changes.

### Insight 2 — schema decisions are roadmap decisions

We can defer UI freely. We cannot easily defer database structure. Anything that needs to exist in v1.0 data must be in the v1.0 schema, even if its UI doesn't ship until v1.2 or v1.3. The six critical gaps are all schema gaps: their UI can stage but their fields/tables cannot.

### Insight 3 — "stupid-proof" is a UI principle, not a comment

Small unskilled team means: default values everywhere, large tap targets, single happy path per task, no settings menus the team can mess up, status visible in plain language ("Waiting for owner to approve R1,200" — not "PENDING_OWNER_APPROVAL"). This is a first-class principle that affects every screen.

### Insight 4 — cost recovery is a chain, not a flag

Real-life cost recovery: try guest → guest refuses → claim from OTA → OTA denies → company tries internal absorption → if not, falls to owner. Each attempt has a timestamp, outcome, and evidence. A single `chargeable_party` enum collapses too many states.

### Insight 5 — pre-arrival is the highest-volume use case, not the smallest

~300 pre-arrival inspections/month vs ~30 post-stay damage incidents/month (estimate). The plan deferred the larger workflow. Reversed.

## Changes committed in this test

### New docs created

- `OPERATIONS_LOGIC_TEST.md` (this file)
- `FLAG_AND_ACTION_MODEL.md`
- `APPROVAL_LIMITS_AND_CONTRACT_RULES.md`
- `PHOTO_RETENTION_POLICY.md`
- `GUEST_DAMAGE_RECOVERY_WORKFLOW.md`
- `OWNER_COMMUNICATION_WORKFLOWS.md`
- `APARTMENT_ACTION_CENTRE.md`

### Updated docs

- `CLAUDE_PROJECT_SKILLSET.md` — stupid-proof UX principle added.
- `PRODUCT_REQUIREMENTS.md` — v1 re-staged; pre-arrival to v1.0; Action Centre to v1.0; approval policies/flag categories/photo retention class in v1.0 schema.
- `DATABASE_SCHEMA_PLAN.md` — new tables: `stays`, `flag_categories`, `flags`, `approval_policies`, `approval_decisions`, `guest_recovery_tasks`, `weekly_status_updates`. New columns: `photos.retention_class`, `accountability_records` cascade fields.
- `INVENTORY_AND_MAINTENANCE_LOGIC.md` — cost recovery cascade.
- `REPORTING_REQUIREMENTS.md` — weekly owner update.
- `PHOTO_AND_EVIDENCE_SYSTEM.md` — retention class field + lifecycle.
- `USER_ROLES_AND_PERMISSIONS.md` — policy override permissions.
- `INSPECTION_WORKFLOWS.md` — pre-arrival promoted; annual audit; stay pairing.
- `TASK_LOG.md`, `CHANGELOG.md`, `KNOWN_ISSUES.md`, `TESTING_CHECKLIST.md` — updated.

## What did not change

- Stack (Next.js + Supabase + Vercel + GitHub + Vercel + pnpm) — still approved.
- Multi-tenancy via `company_id` + RLS — still the model.
- Photo capture / compression / offline sync — still correct.
- AI policy (none in v1) — unchanged.
- Currency (ZAR single currency in MVP) — unchanged.
- First customer (founder's own operation) — unchanged.

## How to use this document

When Claude resumes work in a future session, this is the doc that answers "why is v1.0 the way it is?" The decisions here were not arbitrary; they came from a real test against real operational pain. Do not re-litigate them without a comparable real-world test.

If a future session proposes removing pre-arrival from v1.0, removing the Action Centre, removing the approval_policies table from v1.0 schema, or removing photo retention classes — push back. Those four are the structural floor.
