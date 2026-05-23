# PRE_BUILD_READINESS_CHECKLIST.md

## Purpose

This is the gate between planning and building. Tooling setup and code do not start until every item on this list is ticked.

The point is not bureaucracy — it's that we've now spent three sessions catching gaps that would have cost weeks if found mid-build. One more 30-minute pass before code starts is cheap insurance.

---

## Planning completeness

- [x] Planning blueprint has 20+ documents covering tenancy, properties, inspections, photos, flags, accountability, approvals, recovery, owner communication, Action Centre, retention, templates, evidence camera, deduplication.
- [x] All 10 prompts in `prompts/` exist (`PROMPT_0_CLAUDE_PREP.md`, `SESSION_START.md`, `SESSION_HANDOFF.md`, `SESSION_CLOSE.md`, `SESSION_RESUME.md`, `BUG_FIX_PROMPT.md`, `ARCHITECTURE_REVIEW_PROMPT.md`, `PRE_DEPLOYMENT_PROMPT.md`, `POST_DEPLOYMENT_VALIDATION_PROMPT.md`, `STAGED_BUILD_PROMPT.md`).
- [x] `prompts/STAGED_BUILD_PROMPT.md` exists (added in this session — see `prompts/` folder).
- [x] `docs/SEED_DATA_PLAN.md` exists (added in this session).
- [x] `docs/COST_TRACKER.md` exists (added in this session).
- [x] `docs/FIELD_TEST_PROTOCOL.md` exists (added in this session).

## Architectural anchors locked

- [x] One home screen: the Apartment Action Centre. No Issue Centre, no Maintenance Centre, no separate Evidence Vault top-level surface.
- [x] One parent record per real-world problem: the `flags` table. Downstream records (issues, maintenance jobs, inventory movements, recovery tasks, accountability records) are children with `parent_flag_id`.
- [x] One photo table. Evidence Vault / Evidence Drawer / Photo Gallery are filtered views, not separate stores.
- [x] One outbound integration model: Asana is optional outbound only. The app is the source of truth.
- [x] One UX principle for field roles: stupid-proof — defaults, plain language, big buttons, one happy path.

## Data model consolidated

- [x] `DATABASE_SCHEMA_PLAN.md` rewritten as final clean table definitions (not patch notes). This is a hard prerequisite for migration creation.
- [x] Every parent-child link (`parent_flag_id`) declared with FK and indexed.
- [x] All photo FKs to optional parents (`flag_id`, `stay_id`, `guest_recovery_task_id`, etc.) declared as nullable.
- [x] Audit table is append-only and covers every state change worth investigating.
- [x] All multi-tenant tables carry `company_id` and the RLS pattern is consistent.
- [x] Annual audit template kind is recognised in v1.0 schema (UI deferred to v1.3 — founder approved 2026-05-14).
- [x] Approval policy ceilings and caps modelled as **per property** by default (founder approved 2026-05-14).

## Workflow decisions locked

- [x] Turnover Inspection (combined post-stay + pre-arrival) is the primary inspection flow.
- [x] Pre-arrival-only and post-stay-only templates exist for edge cases.
- [x] Evidence Camera Mode (camera-stays-open, photo strip, optional notes) is the v1.0 photo capture pattern.
- [x] Photos optional-by-default; required only per template rule or per flag-type rule.
- [x] Mark-All-OK works at section level, respects `mandatory_individual` items.
- [x] Record-only observations exist as a distinct affordance that does not enter the Action Centre queue.
- [x] Per-property inventory list drives the inventory section of every turnover and annual audit.
- [x] Cost recovery cascade (guest → OTA → company → owner) modelled as a chain, not a flag.
- [x] Emergency over-limit maintenance path: manager can override approval cap with required reason; audit row prominent; post-event review required.

## Evidence and reporting

- [x] Every photo carries: `retention_class`, `captured_at`, `uploaded_by`, parent FKs.
- [x] Evidence Vault is a search view, not a separate module.
- [x] WhatsApp workflow lives inside the flag card.
- [x] Reports support "Hide OK items" toggle.
- [x] Reports show photo timestamps and notes when present.
- [x] Inspection HTML report meets the print-quality bar in `REPORTING_REQUIREMENTS.md`.

## Approval policy

- [x] `approval_policies` table seeded with Dropinn defaults on company creation.
- [x] Caps are **per property per month / per year** (clarified).
- [x] Three ceilings model: `internal_approvable_below` / `internal_ceiling` / `absolute_block_above`.
- [x] Emergency override path requires written reason and audited prominently.
- [x] Owner approval responses captured with screenshot evidence.

## Permissions

- [x] Roles defined for v1.0–v1.3.
- [x] Inspectors never see cost or chargeable fields.
- [x] Managers triage flags; inspectors raise them.
- [x] Owner viewer sees only their property's sent records.
- [x] Approval policy edits restricted to Company Admin (company-level) and GM (owner/property overrides), all audited.

## Memory and operational discipline

- [x] `TASK_LOG.md` current.
- [x] `CHANGELOG.md` carries every session.
- [x] `KNOWN_ISSUES.md` carries every risk identified, with priority and reassess trigger.
- [x] `TESTING_CHECKLIST.md` carries acceptance tests for each milestone gate.
- [x] Save-as-you-go rule in `CLAUDE_PROJECT_SKILLSET.md`.
- [x] 5-minute end-of-session ritual added to `CLAUDE_PROJECT_SKILLSET.md`.

## Founder gating decisions — ALL FIVE APPROVED (2026-05-14)

These were the decisions required before v1.0 schema is migrated to a database. The founder has reviewed and **approved all five**. They are now locked; changing any of them later requires a deliberate, recorded decision.

1. ✅ **APPROVED — Dropinn approval caps as documented.** R1,000 single inventory item / R2,000 single maintenance item / R2,000 owner charges per property per month / R60,000 owner charges per property per year, with internal ceiling R2,000 and absolute block R10,000. Seeded as the default policy on company creation (`SEED_DATA_PLAN.md`, `APPROVAL_LIMITS_AND_CONTRACT_RULES.md`).
2. ✅ **APPROVED — Annual audit: UI waits until v1.3, schema supports it from v1.0.** The `annual_audit` template kind and all supporting fields exist in the consolidated v1.0 schema; the run-an-annual-audit UI ships in v1.3. No schema retrofit needed later.
3. ✅ **APPROVED — Turnover inspection is the default workflow.** The combined post-stay + pre-arrival Turnover template is the default seeded template for new companies (`TURNOVER_INSPECTION_WORKFLOW.md`, `TEMPLATE_AND_INVENTORY_MODEL.md`). Pre-arrival-only and post-stay-only remain available for edge cases.
4. ✅ **APPROVED — Four-stage v1 plan (v1.0 → v1.3).** As defined in `PRODUCT_REQUIREMENTS.md`. No stage merges or reorders.
5. ✅ **APPROVED — Parent flag/problem thread is the deduplication rule.** One real-world problem = one `flags` row = one Action Centre card; downstream records are children carrying `parent_flag_id` (`DEDUPLICATION_AND_TASK_GROUPING_RULES.md`). This is the locked architectural foundation.

With these five approved, there are **no remaining gating decisions** before tooling setup.

## What "ready to start tooling" looks like

When every checkbox above is ticked AND the open decisions are resolved, the next session is:

> "I'm ready for the tooling setup for v1.0. Walk me through it step by step."

Tooling setup is: GitHub → VS Code → Node → pnpm → Supabase project → Vercel project. One tool at a time. No code in that session.

After tooling: a separate session creates the empty Next.js skeleton with a public landing page only. No auth, no features.

After skeleton: separate sessions per v1.0 module, in dependency order: auth → tenancy/RLS → properties → templates → inventory items → inspections → photos → flags → action centre → reports.

---

## Why this checklist exists

Three sessions of planning produced 26 documents. That's not normal — it's a sign the problem is complex and worth getting right before code. The pre-build checklist is the moment to slow down once more, read the artefacts back to ourselves, and confirm nothing important is unresolved.

A 30-minute pass through this list before tooling is cheaper than a one-day mid-build rework.
