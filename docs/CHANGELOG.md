# CHANGELOG.md

## 2026-05-28 — Regroup + docs catch-up

Docs PR that consolidates the planning state after five v1.0 product
build sessions shipped. Tight scope: TASK_LOG catch-up + revised
Sessions 6-12 roadmap, CHANGELOG entries for PRs #5-#10, new
`CHIP_VOCABULARY.md` (single source of truth for Session 6's
operational marks), `flag_operational_marks` table spec appended to
`DATABASE_SCHEMA_PLAN.md`, cost-and-scale rules locked into
`PHOTO_AND_EVIDENCE_SYSTEM.md` (pre-generated thumbnails, no
per-request transforms, TUS resumable uploads, retention policy,
separate storage backup, R2 migration path). Five files touched.
No code, no schema migration, no deploy.

Key roadmap pivot: Session 6 is operational marks/chips (not Evidence
Camera). The chip layer was the missing default UI surface; recovery
task work from Session 5 stays available as the rare formal-escalation
path but the visible CTA was demoted before merge. Architecture
decisions locked: stay Next.js web for v1.0 (native Expo post-v1.0),
Supabase Storage for v1.0 (R2 path open), inventory_items per-property
(no asset_catalog split yet).

---

## 2026-05-28 — Session 5: optional guest recovery + WhatsApp helper (PR #10)

Adds the optional formal guest recovery workflow:
- `guest_recovery_tasks` + `recovery_attempts` tables with SELECT,
  INSERT, UPDATE RLS for company members; partial-via-parent RLS for
  `recovery_attempts`.
- `create_recovery_task_from_flag()` SECURITY DEFINER RPC that
  atomically creates a minimal stays row + the recovery task and
  defaults the flag's `chargeable_party_decision = 'guest'` if not set.
- `/properties/[id]/flags/[flagId]/recovery/new` form.
- Inline recovery card on flag detail with status-dependent actions
  (Open WhatsApp / Mark notified / Mark paid / Mark refused / Close
  recovery task).
- WhatsApp deep-link helper (`buildWhatsAppUrl`, `buildRecoveryMessage`,
  `formatZAR`). Message wording is honest: "Evidence can be shared on
  request" — NOT "Photos attached" (Evidence Camera ships Session 8).
- Money bug fix: `step="any"` on number inputs + `Math.round(value * 100) / 100`
  in server actions + defensive rounding in `formatZAR()`. Defeats the
  browser FP-step-grid bug that turned typed "200" into stored 199.98.
- **Pre-merge demotion of the recovery section** (per regroup discussion):
  when no recovery task exists, the prominent card+button is replaced
  by a single small grey inline link. Chips (Session 6) become the
  daily-driver surface; recovery stays for rare formal-escalation cases.

---

## 2026-05-27 — Session 4: flag triage + activity log (PR #9)

- Flag detail page at `/properties/[id]/flags/[flagId]`: header card,
  triage form (status / severity / responsibility radio chips +
  close-reason textarea), reopen affordance for closed flags, vertical
  activity timeline (lifecycle events from `flags.*_at` columns +
  audit_events for notes / state changes / reopens), add-note form.
- Three server actions: `updateFlagAction` (status/severity/responsibility
  with paired audit event for the diff), `addFlagNoteAction` (writes
  a `flag_note` audit event), `reopenFlagAction` (clears closed_at +
  no_action_reason, status back to 'raised').
- Migration: UPDATE policy + grant on `flags`; SELECT + INSERT policies
  + grants on `audit_events` (with `actor_id = auth.uid()` anti-forgery
  guard). No DELETE anywhere.
- New `RadioChip` component for pill-style radio inputs (reused later
  on the raise-flag form too).
- Action Centre's open-flag cards are now clickable links to the
  detail page.

---

## 2026-05-26 — Session 3: Apartment Action Centre + flag raise + UI kit (PRs #7, #8)

- `/properties/[id]` Apartment Action Centre page: property header
  with status, six quick-add tiles (Maintenance / Damage / Inventory /
  Cleaning / Safety / Note), open flags list, inspection-history
  placeholder, "Coming for this apartment" mini-roadmap.
- `/properties/[id]/flags/new` guided form with category select
  (pre-selected from quick-add tile), severity chips, description
  textarea, photo-deferred info banner.
- Migration: SELECT + INSERT policies + grant on `flags` for company
  members (no UPDATE yet — that came in Session 4).
- Polish: operator-grade flag labels everywhere (Maintenance / Item
  missing / Item damaged / Guest damage / Cleaning / Safety / Note /
  etc.), replacing the "Broken thing" / "Guest broke it" playful
  labels. Tile-specific copy (Maintenance / Damage / Inventory /
  Cleaning / Safety / Note) for the quick-add tiles.
- UI kit established: Button + buttonClasses, Card / CardHeader /
  CardBody / CardFooter, Input / Label / Field, Badge (7 semantic
  tones), Alert (error / success / info), EmptyState, RadioChip (added
  Session 4). AppShell + AuthShell. Added `clsx` and `lucide-react`.
- Performance pass: `getUserContext` combines membership + company in
  one PostgREST embed; Action Centre runs property + flags queries in
  parallel; flags query embeds `flag_categories` via PostgREST so the
  follow-up `IN (ids)` lookup is gone. Net: Action Centre dropped from
  6 sequential phases to 3.

---

## 2026-05-26 — Table grants for the authenticated role (PR #7)

Fixes the "permission denied for table" bug surfaced by the Session 2
first smoke test. Supabase does not auto-grant DML privileges to
`anon` / `authenticated` on tables created in `public`. The two-gate
principle: Postgres GRANT first, then RLS.

Added: schema USAGE on public to anon/authenticated; SELECT on `roles`
and `flag_categories` to anon/authenticated (matching the public-read
RLS policies); SELECT on `companies` / `profiles` / `company_memberships`
/ `property_assignments` / `property_owner_links` to authenticated;
SELECT + INSERT on `properties` to authenticated. No DELETE anywhere.
No role narrowing beyond company member. Other tables stay denied
until their UIs ship.

---

## 2026-05-25 — Session 2: first visible app screens + Session 1 follow-ups (PR #7)

Five files of foundation + the auth-and-onboarding screens:
- `src/lib/supabase/middleware.ts` + `src/proxy.ts` (Next.js 16
  renamed `middleware.ts` to `proxy.ts`): session refresh on every
  request + cheap redirect rules (logged-out → /login; logged-in on
  auth pages → /dashboard). DOES NOT check the company at the proxy
  layer to keep it fast; pages handle "no company → /onboard".
- `src/lib/auth/get-user-context.ts`: bundles user + profile +
  membership + company into one helper.
- `/login`, `/signup`, `/auth/callback` (PKCE for email confirmation),
  `/auth/signout`, `/onboard` (calls `create_company_with_admin` RPC),
  `/dashboard` (property list scoped by RLS), `/properties/new`
  (property creation form).
- Bug fix mid-session: `getUserContext().maybeSingle()` was returning
  null + PGRST116 error when accidental double-submit created two
  memberships, causing an infinite loop between /dashboard and /onboard.
  Replaced with `.order(created_at asc).limit(1)`; added app-side
  idempotency check in `createCompanyAction`; made empty error
  strings render visibly so silent failures stop being silent.

---

## 2026-05-25 — Session 1: schema foundation + auth wiring + RLS (PRs #5, #6)

Two PRs, six migrations applied to staging:
- **PR #5 — Schema foundation.** 32 tables across five migrations
  (extensions / core schema / indexes / system seeds / RLS enable).
  All business tables have `company_id`, RLS enabled, no policies yet
  (deny-by-default). Indexing plan applied. System seeds: 11 roles
  + 11 flag categories with `UNIQUE NULLS NOT DISTINCT (company_id, key)`
  on flag_categories (caught during pre-merge review — regular UNIQUE
  treats NULL as distinct and would let duplicates through). Idempotent
  `ON CONFLICT DO NOTHING` on both seed inserts.
- **PR #6 — Auth wiring + minimum dashboard RLS.** `handle_new_user()`
  trigger on `auth.users` mirrors signups to `profiles`.
  `create_company_with_admin()` SECURITY DEFINER RPC solves the
  membership bootstrap deadlock (creates company + admin membership +
  default approval policy atomically). `is_company_member()` helper
  function for RLS policies (avoids recursion). 13 RLS policies for
  the minimum dashboard read+write path.

---

### Session goal

Connect the Next.js skeleton to a live Supabase staging project and verify the connection is reachable. Documentation and connection only — no schema, no migrations, no auth, no data, no Vercel.

### What was done

- Created Supabase staging project `str-ops-staging` (eu-west-2 / West Europe London, Free plan).
- Installed `@supabase/supabase-js 2.106.1` and `@supabase/ssr 0.10.3`.
- Created `src/lib/supabase/client.ts` — browser-side Supabase client (safe to use in Client Components; uses anon key + RLS enforcement).
- Created `src/lib/supabase/server.ts` — server-side Supabase client (async cookies from `next/headers`; use in Server Components, Server Actions, Route Handlers).
- Created `src/app/api/health/route.ts` — temporary health-check route calling `getUser()` to verify live Supabase reachability. Returns `{ status: "ok" }` when the project is reachable. To be removed before production.
- Created `.env.example` — committed variable-name template with safety notes. No secrets. `.env.local` exists locally only; never staged, never committed.
- Updated `docs/COST_TRACKER.md` — Supabase row updated to **Live — staging**, `str-ops-staging` (eu-west-2) recorded, Connected Services section added, cost rule added.
- Fixed `package.json` name: `str-skeleton-temp` → `str-operations-app`.
- `pnpm build` passed (zero TypeScript errors). Health check confirmed: `{ "status": "ok" }`.

### Constraints honoured

- `.env.local` never committed. Supabase URL, anon key, and service_role key never pasted into chat or code.
- No service_role key used anywhere.
- No database tables. No migrations. No RLS policies. No Vercel. No deployment.
- No paid upgrade, plan change, billing change, add-on, or production Supabase project.

### Files changed (8)

`package.json`, `pnpm-lock.yaml`, `next-env.d.ts` (auto-updated), `src/lib/supabase/client.ts` (new), `src/lib/supabase/server.ts` (new), `src/app/api/health/route.ts` (new), `.env.example` (new), `docs/COST_TRACKER.md`.

### What does not yet exist

Database schema, migrations, RLS policies, auth, any application features, Vercel connection, production Supabase project, real data.

### Next action

v1.0 schema foundation session — install Supabase CLI, `supabase init`, link to staging, write first SQL migrations for core tables. Use `prompts/STAGED_BUILD_PROMPT.md` (stage = v1.0). Staging only; production project must not be created until the v1.0 field test passes.

---

## 2026-05-24 — v1.0 Skeleton Milestone complete + documentation alignment

### Session goal

Two things were completed:

1. **v1.0 Skeleton Milestone** — the empty Next.js shell (PR #1, merged to main). `pnpm install`, `pnpm dev` (localhost:3000), and `pnpm build` all pass. No features, no auth, no database. The skeleton exists only to verify the toolchain; it is not a product. The dev server was stopped after verification — subsequent "refused to connect" screenshots were not failures.

2. **Documentation alignment** — docs updated to distinguish "v1.0 Skeleton Milestone" (complete) from "Product Stage v1.0" (Inspection loop + foundation, not yet started). Key Replit prototype findings that were previously referenced by number are now explicitly documented in the correct files.

**No app code changes beyond the skeleton. No service connections. No migrations. No deployment.**

### Terminology locked

- **"v1.0 Skeleton Milestone"** = the empty Next.js shell. Completed 2026-05-23.
- **"Product Stage v1.0"** = the inspection/foundation product stage. Not yet started. All v1.0 scope references in planning docs refer to this stage.

### Key prototype findings explicitly documented in this session

These findings were incorporated in a prior session but made explicit in the correct doc files here:

- **Evidence core append-only after submission** — rule written into `FLAG_AND_ACTION_MODEL.md` as its own section (was previously only a plan in `KNOWN_ISSUES.md`).
- **Pre-arrival Evidence Pack button** — added to the inspector confirmation screen in `INSPECTION_WORKFLOWS.md` (was previously only in `APARTMENT_ACTION_CENTRE.md` / `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`).
- **v1.0 naming disambiguation** — added to `PRODUCT_REQUIREMENTS.md` at the staging table.

### Files changed

`docs/PRODUCT_REQUIREMENTS.md`, `docs/FLAG_AND_ACTION_MODEL.md`, `docs/INSPECTION_WORKFLOWS.md`, `docs/APARTMENT_ACTION_CENTRE.md`, `prompts/SUPABASE_CONNECTION_PROMPT.md` (new), `docs/KNOWN_ISSUES.md`, `docs/TASK_LOG.md`, `docs/CHANGELOG.md` (this entry).

### Additional gap fixes (traceability review)

A post-edit traceability review against all 16 Replit prototype findings identified two partially-covered requirements:

- **Requirement #14 (previous inspections accessible from apartment dashboard)** — `APARTMENT_ACTION_CENTRE.md` Property view had no inspection history section. Added Section 7 "Inspection history" documenting the "Past inspections" element, the four display states, the paired pre-arrival/post-stay row for dispute evidence, and the cross-reference to `INSPECTION_WORKFLOWS.md`.
- **Requirement #16 (safety flags must not be hidden as record-only)** — `FLAG_AND_ACTION_MODEL.md` said safety flags "bypass normal triage" but did not explicitly state that the "record-only / no action" picker option is suppressed for `safety_urgent` flags. Added the rule in two places: the taxonomy notes (explicit rule with audit requirement) and the action-needed picker table row ("Record-only / no action" now notes it is suppressed for safety flags).

### What did not change

Stack, schema, roles, all product decisions, all founder-approved rules. No scope change. No code change beyond the skeleton already merged.

### Next action

Merge branch `docs/v1-foundation-planning-alignment`, then open a new session with `prompts/SUPABASE_CONNECTION_PROMPT.md` and connect the skeleton to a staging Supabase project.

---

## 2026-05-14 — Replit prototype findings incorporated (UX learning only)

### Session goal

A throwaway Replit prototype was built to test UX and workflow logic. **Its code is not used, not copied, and not production** — it served only as product/UX learning. Seventeen findings were incorporated into the official planning docs. No code, no build, no migrations, no service connections, no deployment in this session.

### What changed (by finding)

- **#1 Context inheritance** — flags raised during an inspection auto-inherit property + inspection + stay; the user is never re-asked which apartment. (`FLAG_AND_ACTION_MODEL.md`, `INSPECTION_WORKFLOWS.md`, `TURNOVER_INSPECTION_WORKFLOW.md`)
- **#2 Save ≠ submit** — saving a flag never advances the inspection; it stays draft/in-progress until an explicit Submit. (`INSPECTION_WORKFLOWS.md`, `TURNOVER_INSPECTION_WORKFLOW.md`)
- **#3 Post-save next actions** — Continue inspection / Go to Apartment Action Centre / Review saved flag. (`INSPECTION_WORKFLOWS.md`)
- **#4 Always resumable** — in-progress inspections resume until submitted. (`INSPECTION_WORKFLOWS.md`)
- **#5/#6 Inspection history** — states (In progress/Submitted/Reviewed/Closed) + full historical detail (items, OK, notes, flags, photos, child actions, status, timestamps, inspector). Note: Closed is a derived display state in v1.0. (`INSPECTION_WORKFLOWS.md`)
- **#7 Note in guided flow** — damage/maintenance note captured before the flag saves. (`INSPECTION_WORKFLOWS.md`, `EVIDENCE_CAMERA_AND_PHOTO_NOTES.md`)
- **#8 Action-needed picker** — reclean / deep clean / maintenance / guest notify / needs Asana / owner approval / monthly owner charge / record-only. (`FLAG_AND_ACTION_MODEL.md`)
- **#9 Picker optional** — inspectors can save a flag choosing nothing; managers triage later. (`FLAG_AND_ACTION_MODEL.md`)
- **#10/#16 Manager child-action editing** — statuses advanced from the Action Centre flag card; "maintenance required" visibly attaches a maintenance child. (`APARTMENT_ACTION_CENTRE.md`, `FLAG_AND_ACTION_MODEL.md`)
- **#11 Asana logging queue** — global + per-apartment views, print-friendly export, mark-as-logged; one task per parent flag, outbound only. (`APARTMENT_ACTION_CENTRE.md`, `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`)
- **#12 Submit button + summary** — single clear Submit Inspection with completion summary. (`INSPECTION_WORKFLOWS.md`)
- **#13 Pre-arrival Evidence Pack** — one-tap timestamped baseline proof. (`APARTMENT_ACTION_CENTRE.md`, `EVIDENCE_CAMERA_AND_PHOTO_NOTES.md`, `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`)
- **#14/#15 Add flag anywhere** — quick-add buttons on the Action Centre property header (damage/maintenance/inventory/cleanliness/record-only). (`APARTMENT_ACTION_CENTRE.md`)
- **#17 One parent holds all child actions** — evidence, Asana, guest notification, maintenance, owner charge, review all nest under one flag; no scattered duplicates. (`DEDUPLICATION_AND_TASK_GROUPING_RULES.md`)

### Files updated

`INSPECTION_WORKFLOWS.md`, `TURNOVER_INSPECTION_WORKFLOW.md`, `FLAG_AND_ACTION_MODEL.md`, `APARTMENT_ACTION_CENTRE.md`, `EVIDENCE_CAMERA_AND_PHOTO_NOTES.md`, `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`, `GUEST_DAMAGE_RECOVERY_WORKFLOW.md`, `DEDUPLICATION_AND_TASK_GROUPING_RULES.md`, `TESTING_CHECKLIST.md`, `TASK_LOG.md`, `CHANGELOG.md`, `KNOWN_ISSUES.md`.

### Claude's own logic test

A self-directed gap analysis was run on top of the 17 findings (see `KNOWN_ISSUES.md` for the new risks raised). Highlights: explicit handling needed for who-can-edit-a-submitted-inspection's flags; flags raised on a property mid-turnover by a second person; the meaning of "Closed"; offline behaviour of the Asana queue and Evidence Pack; and preventing inspectors from being able to bury a safety flag by choosing "record-only".

### Tooling note

Local tooling setup + GitHub verification were completed earlier the same day (see `TASK_LOG.md`). This session was documentation only.

---

## 2026-05-14 — Founder pre-build gating approvals

The founder reviewed the planning package and **approved all five pre-build gating decisions**. The planning phase is now fully locked; the next step is tooling setup.

1. ✅ Dropinn approval caps approved as documented (R1,000 single inventory / R2,000 single maintenance / R2,000 owner charges per property per month / R60,000 per property per year; internal ceiling R2,000; absolute block R10,000).
2. ✅ Annual audit — UI deferred to v1.3; schema supports annual audit from v1.0.
3. ✅ Turnover inspection is the default workflow.
4. ✅ Four-stage plan v1.0 → v1.3 approved.
5. ✅ Parent flag/problem thread is the deduplication rule.

Files updated to record the approvals: `PRE_BUILD_READINESS_CHECKLIST.md` (decisions converted from "open" to "approved"; related schema checkboxes ticked), `TASK_LOG.md` (objective + outstanding-decisions sections updated), `CHANGELOG.md` (this entry). No new requirements introduced; no scope change. **No code, tooling, migrations, service connections, or deployment.**

### Next action

Open a new session: *"I'm ready for the tooling setup for v1.0. Walk me through it step by step."*

---

## 2026-05-14 — Evidence-camera + turnover + deduplication refinement session

### Session goal

Final operational workflow and evidence-capture refinement before tooling. Driven by staff feedback (Asana evidence loading slow; WhatsApp scrolling for dispute proof painful; guest notification scattered across tools; team wants all issues in one place; team is WhatsApp-heavy) and new operational context (combined turnover inspections; per-property inventory variation; junior/unskilled inspectors; Mark-All-OK; Evidence Camera Mode; RedRabbit benchmark; duplicate-task prevention).

**No code. No tooling. No migrations. No service connections. No deploys.** Documentation only.

### Critical changes made

- **Turnover inspection is now the primary flow.** Combined post-stay + pre-arrival in one visit, one inspection record with `outgoing_stay_id` + `incoming_stay_id`. The split pre-arrival-only / post-stay-only templates remain for edge cases.
- **Evidence Camera Mode specified.** Camera-stays-open, photo strip, multi-capture, gallery multi-upload, quick delete, optional notes (per photo / selected photos / whole proof set), auto-attach to the originating surface, no per-photo tagging admin. iOS Safari requires a custom getUserMedia camera component (recorded as a known cost).
- **Deduplication / parent-flag discipline made explicit and load-bearing.** One real-world problem = one `flags` row = one Action Centre card. Downstream records (issues, maintenance jobs, inventory movements, guest recovery tasks, accountability records) are CHILDREN carrying `parent_flag_id`. The card shows a work strip of children, never duplicate rows.
- **Evidence Vault clarified as a filtered view over the one `photos` table** — not a separate module/store. Evidence Drawer (in-context) and Vault (global search) are the same data at different zoom levels.
- **WhatsApp guest notification lives inside the flag card.** Copy message / Open WhatsApp (`wa.me` deep-link) / Mark sent + screenshot proof (`entity_type = 'recovery_message_proof'`, `dispute_evidence` retention). No separate guest-recovery module to navigate to. No more scrolling WhatsApp for proof.
- **Template & inventory model specified.** Three layers: system defaults → company standard → property override → inspection snapshot. Per-apartment inventory lists. Mark-All-OK at section level; `mandatory_individual` items (safety + appliances) excluded from bulk; record-only observations that never hit the Action Centre queue; one-off in-inspection items. Template edits never alter historical inspections (snapshots).
- **Schema consolidated into final clean definitions (not patch notes).** `DATABASE_SCHEMA_PLAN.md` rewritten. Flag-as-parent relationship reversed (children carry `parent_flag_id`; no `linked_*` columns on `flags`). All photo FKs nullable. `retention_class` on every photo. Approval policy caps **per property per month/year**. Emergency over-limit maintenance fields on `maintenance_jobs` + `emergency_override` decision value.
- **Emergency over-limit maintenance path** added: safety/urgent work can proceed before approval with a required reason + audit row + post-event review by GM/Company Admin.
- **Reports**: "hide OK items" toggle (on by default for owner-facing); photo timestamps under every photo; proof-set note rendering.
- **Asana confirmed optional outbound only**: one task per parent flag (never per child), one-way, never a dependency. Manual copy-paste in transition; optional automated push v1.5+.
- **Annual audit template kind in schema from v1.0** (UI stays v1.3 unless founder accelerates).
- **Photo volume estimate corrected** to ~3,800/month (turnover combines two previously-separate flows); all photo/storage numbers explicitly marked estimates.

### Ten new docs created

`DEDUPLICATION_AND_TASK_GROUPING_RULES.md`, `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`, `EVIDENCE_CAMERA_AND_PHOTO_NOTES.md`, `TEMPLATE_AND_INVENTORY_MODEL.md`, `TURNOVER_INSPECTION_WORKFLOW.md`, `PRE_BUILD_READINESS_CHECKLIST.md`, `SEED_DATA_PLAN.md`, `COST_TRACKER.md`, `FIELD_TEST_PROTOCOL.md`, `prompts/STAGED_BUILD_PROMPT.md`.

### Fifteen existing docs updated

`CLAUDE_PROJECT_SKILLSET.md` (5-minute end-of-session ritual), `DATABASE_SCHEMA_PLAN.md` (consolidated final), `PRODUCT_REQUIREMENTS.md`, `INSPECTION_WORKFLOWS.md`, `PHOTO_AND_EVIDENCE_SYSTEM.md`, `PHOTO_RETENTION_POLICY.md`, `REPORTING_REQUIREMENTS.md`, `FLAG_AND_ACTION_MODEL.md`, `APARTMENT_ACTION_CENTRE.md`, `GUEST_DAMAGE_RECOVERY_WORKFLOW.md`, `INTEGRATION_ROADMAP.md`, `USER_ROLES_AND_PERMISSIONS.md`, `TESTING_CHECKLIST.md`, `TASK_LOG.md`, `CHANGELOG.md` (this entry), `KNOWN_ISSUES.md`.

### All five previously-recommended improvements applied

`STAGED_BUILD_PROMPT.md`, `SEED_DATA_PLAN.md`, 5-minute end-of-session ritual, `COST_TRACKER.md`, `FIELD_TEST_PROTOCOL.md` — all done.

### What did not change

Stack (Next.js + Supabase + Vercel + pnpm), multi-tenancy via `company_id` + RLS, ZAR single currency, no AI in v1, no WhatsApp/SMS API in v1, first customer = founder's own operation. All unchanged.

### Next action

Founder confirms the five gating decisions in `PRE_BUILD_READINESS_CHECKLIST.md`, then the tooling setup walkthrough begins (still no code).

---

## 2026-05-13 — Operational logic test session

### Session goal

Founder-driven end-to-end operational logic test of the planning blueprint, with new real-world context: cost recovery cascade ("every Rand must end up paid by someone"), stupid-proof UX requirement ("small unskilled team"), and Dropinn-style configurable contract approval limits.

**No code. No tooling. No deploys.** Purely a product / operations / data-model / risk test, with documentation deliverables.

### Verdict

**PROCEED WITH CHANGES.** Foundation is solid. Six structural gaps closed before any code is written.

### Six structural gaps closed

1. No configurable approval policies — added `approval_policies` table + Dropinn-default seeding + 4-level scope (company / owner / property / category) + three approval ceilings model.
2. No cost recovery cascade — added cascade chain to `accountability_records`; added `guest_recovery_tasks` + `recovery_attempts` tables; documented the no-leakage rule.
3. Pre-arrival inspection was deferred to v1.3 — promoted to v1.0 alongside post-stay (highest-volume use case in the operation).
4. Flag taxonomy was too thin (OK/Damaged/Missing/Attention) — expanded to 11-category taxonomy with state machine and conversion paths.
5. No Apartment Action Centre (the home screen that replaces Asana) — added as v1.0 deliverable.
6. Uniform photo retention — added 7 retention classes with auto-derivation at capture and one-way promotion.

### Decisions locked in this session

- Schema decisions are roadmap decisions: anything needing v1.0 data must be in v1.0 schema even if UI ships later.
- Pre-arrival ships in v1.0 alongside post-stay.
- Asana stays optional outbound only; the app is the source of truth.
- WhatsApp Business API is NOT required for MVP — copy-paste with `wa.me` deep-link is sufficient.
- Dropinn-style approval defaults are seeded for the South African STR market.
- Three approval ceilings: `internal_approvable_below` / `internal_ceiling` / `absolute_block_above`.
- Cost recovery is a chain (multiple attempts), not a single `chargeable_party` flag.
- Photo retention promotion is one-way.

### v1 re-staged

- **v1.0** Inspection loop + foundation — pre-arrival + post-stay, basic Action Centre, full schema for flags + approval policies + photo retention class + stays.
- **v1.1** Maintenance + Guest recovery — issues + jobs + verify + same-day guest recovery workflow + cost recovery cascade.
- **v1.2** Accountability + Policy enforcement — approval caps actively enforced + pending-owner-approval flow + per-property spend widgets.
- **v1.3** Owner communication + audit — weekly owner update + monthly summary + annual audit template + owner-facing dashboard.

### Seven new docs created

1. `docs/OPERATIONS_LOGIC_TEST.md`
2. `docs/FLAG_AND_ACTION_MODEL.md`
3. `docs/APPROVAL_LIMITS_AND_CONTRACT_RULES.md`
4. `docs/PHOTO_RETENTION_POLICY.md`
5. `docs/GUEST_DAMAGE_RECOVERY_WORKFLOW.md`
6. `docs/OWNER_COMMUNICATION_WORKFLOWS.md`
7. `docs/APARTMENT_ACTION_CENTRE.md`

### Nine existing docs updated

In project root:
- `CLAUDE_PROJECT_SKILLSET.md` — added stupid-proof UX as first-class principle (12 rules).

In `docs/`:
- `PRODUCT_REQUIREMENTS.md` — fully rewritten; product goals reframed for operational-source-of-truth; v1 re-staged with detailed per-stage scope and acceptance criteria.
- `DATABASE_SCHEMA_PLAN.md` — added new tables and new columns to existing tables.
- `INVENTORY_AND_MAINTENANCE_LOGIC.md` — added "Part 1.5 — Cost recovery cascade" with transition table, no-leakage rule, and three worked examples; expanded accountability record field list.
- `REPORTING_REQUIREMENTS.md` — added weekly owner status update as report type 2.5.
- `PHOTO_AND_EVIDENCE_SYSTEM.md` — added `retention_class` field, new FK columns (`flag_id`, `guest_recovery_task_id`, `stay_id`), retention lifecycle summary, cross-reference to retention policy doc.
- `USER_ROLES_AND_PERMISSIONS.md` — added approval policies and overrides permissions matrix; added weekly update permissions; documented why each role has the policy access it has.
- `INSPECTION_WORKFLOWS.md` — promoted pre-arrival to v1.0 (was v1.3); added annual audit as seeded template in v1.3; documented stay-pairing; added volumes context.
- `TASK_LOG.md` — fully refreshed to reflect operational test completion and next steps.

### Memory files updated

- `CHANGELOG.md` — this entry.
- `KNOWN_ISSUES.md` — resolved items removed; new risks added (Action Centre overwhelm, approval policy mis-seeding for non-ZA markets, copy-paste workflow discipline).
- `TESTING_CHECKLIST.md` — added test items for pre-arrival in v1.0, flag taxonomy at capture, approval policy seeding, retention class on every photo, basic Action Centre, stay-entity linking, guest recovery task creation, copy-paste message templates, approval policy enforcement at v1.2, weekly owner update at v1.3.

### What did not change

- Stack (Next.js + Supabase + Vercel + GitHub + pnpm) — still approved.
- Multi-tenancy via `company_id` + RLS — still the model.
- Photo capture / compression / offline sync — still correct.
- AI policy (none in v1) — unchanged.
- Currency (ZAR single currency in MVP) — unchanged.
- First customer (founder's own operation) — unchanged.

### Next action

Founder reviews and confirms the operational test conclusions. Then tooling setup walkthrough begins (still no code). Then v1.0 project skeleton.

---

## 2026-05-12 — Founder review session (refinement of the planning blueprint)

### Session goal

Founder review of the 17-file planning blueprint. Resolve open questions. Refine for gaps, contradictions, over-complexity, missing safety, scope creep. **No code. No deploys.**

### Decisions locked in this session

1. Currency for MVP = **ZAR (South African Rand)**, single currency per company.
2. First customer = **the founder's own short-term rental management operation.**
3. Domain name = **not needed yet**; Vercel preview URLs are fine until v1.0 cutover.
4. AI features in v1 = **none.** AI remains optional and deferred to v1.5+.
5. HTML-only reports in v1 = **yes, but with a hard quality bar**: clean, professional, printable, structured. PDF deferred to v1.5.
6. Stack = **approved.** Next.js (App Router) + Supabase + Vercel locked in.

### Approved rule change

Added to `CLAUDE_PROJECT_SKILLSET.md` under File management rules:
> "Save each completed file to disk as soon as it is finished. Never batch saves at the end of a session. This makes mid-session usage caps fully recoverable."

### Structural change: v1 staged into sub-releases

v1 has been split into four sub-releases. Cumulative scope unchanged; delivery is now incremental:

- **v1.0** — inspection loop (auth, properties, post-stay template, full mobile inspection, photos, offline, HTML inspection report, audit).
- **v1.1** — maintenance loop (issues, jobs, before/after photos, verify).
- **v1.2** — accountability loop (inventory, movements, accountability records, owner-chargeable approvals).
- **v1.3** — owner report loop (monthly summary, owner viewer role, basic dashboards, pre-arrival + monthly templates).

Each sub-release has its own acceptance criteria and is independently deployable to the founder's staging environment.

### Files updated in this session

In project root:
- `CLAUDE_PROJECT_SKILLSET.md` — save-as-you-go rule added.

In `docs/`:
- `PROJECT_BRIEF.md` — new "First customer" section; full "Active assumptions" lock-in with all founder decisions stamped; updated 12-month vision.
- `PRODUCT_REQUIREMENTS.md` — v1 staged into v1.0 → v1.3 with detailed scope and per-stage acceptance criteria; seed-template note added; softened generic "15-minute company onboarding" criterion to founder-relevant "30-day own-operation use"; OTA evidence pack timing clarified.
- `TECHNICAL_ARCHITECTURE.md` — stack table marked **founder-approved**; staging/production discipline paragraph added for the founder-as-first-customer pattern; three new resolved decisions (currency ZAR, no custom domain in build phase, no PDF in v1).
- `REPORTING_REQUIREMENTS.md` — major addition: "Presentation quality requirements (v1 HTML reports)" with Clean / Professional / Printable / Structured sub-sections and a per-report validation checklist; export-formats table now staged by sub-release; OTA evidence pack labelled clearly as v1.5/v2; currency open question closed.
- `DEPLOYMENT_GUIDE.md` — back-up-before-any-production-migration rule (now rule #3 in migration section); new "Red flag rule: Claude will never ask for your production service-role key" section; updated "when to call for help" list; build-phase note that custom domain is not required until v1.0 production cutover.
- `NON_TECHNICAL_USER_GUIDE.md` — new "You are the first customer" section; new "Claude will never ask for your production secrets" rule (item 6); staged v1 in the step-by-step plan; updated "current next step"; new failure-mode in the "something feels wrong" list (accidental test-data-in-prod or real-data-in-staging); new founder commitments (#6 staging/prod separation, #7 secret hygiene).
- `TASK_LOG.md` — founder review marked complete; six open questions all resolved; five new "recommended but not applied" improvements listed for separate founder approval; next action set to tooling setup.
- `CHANGELOG.md` — this entry.
- `KNOWN_ISSUES.md` — six resolved founder questions removed from open list; new risk added: "Founder-as-first-customer staging/production discipline"; lessons-learned section expanded.
- `TESTING_CHECKLIST.md` — new "Print-quality validation" section for v1 HTML reports; staged v1.0 / v1.1 / v1.2 / v1.3 milestone gates added; secret-hygiene line added to pre-production safety.

### Recommended improvements deferred for founder approval

1. New prompt file: `prompts/STAGED_BUILD_PROMPT.md` — one prompt per v1 sub-release that forces single-stage scope.
2. New doc: `docs/SEED_DATA_PLAN.md` — pre-installed templates, test data plan, first-user creation.
3. Explicit 5-minute end-of-session ritual checklist added to `CLAUDE_PROJECT_SKILLSET.md`.
4. New doc: `docs/COST_TRACKER.md` — running log of monthly spend per service.
5. New doc: `docs/FIELD_TEST_PROTOCOL.md` — exact protocol for the "real apartment, weak signal" field test required before each stage gate.

None of these are applied yet. They live in `TASK_LOG.md` until the founder approves.

### Risks introduced

None. No code created. No external services connected. No data created. Two new risks captured in `KNOWN_ISSUES.md` (test/prod boundary discipline + the temptation to skip a sub-release).

### Rollback note

If anything in the refinement is wrong, the documents are still pre-code. Any of the 11 updated files can be re-edited freely.

---

## 2026-05-12 — Planning session (parts 1 and 2)

### Session goal

Execute `PROMPT_0_CLAUDE_PREP.md` and produce the complete project planning blueprint. No code, no deploys.

### Files created or fully rewritten

In `docs/`:

- `PROJECT_BRIEF.md` — full vision, problem statement, primary users, MVP success outcome, non-goals, assumptions, 12-month definition of success.
- `PRODUCT_REQUIREMENTS.md` — product goals, core modules, MVP v1 scope (auth, properties, templates, inspection workflow, photos, offline, issues, maintenance, inventory, owner-chargeable flag, basic reports, dashboards, audit, roles), v1.5 scope, later-phase scope, MVP acceptance criteria, explicit non-goals.
- `TECHNICAL_ARCHITECTURE.md` — full stack choice (Next.js + Supabase + Vercel), architecture principles, folder structure, env vars, deployment topology, all previously-open decisions now resolved (PWA vs native, one-project-per-company, photo storage choice, Dexie vs raw IDB, TanStack Query vs SWR, App Router vs Pages Router, realtime, push, iOS background sync, search, monorepo), security model, performance budgets, observability, deferred reviews.
- `DATABASE_SCHEMA_PLAN.md` — conventions, entity groups, table-by-table MVP shape with key fields and FKs, RLS policy outline, indexing plan, migration strategy, deferred items.
- `USER_ROLES_AND_PERMISSIONS.md` — full role catalogue, permission principles, permission matrices for properties, templates, inspections, photos, issues, maintenance, inventory & accountability, reports, users/roles. Where the rules live in code. Explicit non-goals. Open questions.
- `INSPECTION_WORKFLOWS.md` — inspection types, workflow principles, full state machine, inspector happy path, manager review flow, offline behaviour, validation rules at submit, edge cases, explicit MVP non-goals.
- `INVENTORY_AND_MAINTENANCE_LOGIC.md` — inventory MVP fields and lifecycle (with approval gating), maintenance two-layer model (issue + job), state machines for both, hard rules, edge cases, cross-cutting accountability summary feeding owner monthly reports.
- `PHOTO_AND_EVIDENCE_SYSTEM.md` — capture-to-cloud flow, storage layout, photo metadata fields, capture UX, compression policy, thumbnails, access control (RLS + signed URLs), audit trail for photos, cost projection and mitigations, OTA evidence pack planning, MVP non-goals, open questions.
- `REPORTING_REQUIREMENTS.md` — eight report types, export formats by phase, principles, full owner-monthly-report build process, performance considerations, explicit MVP non-goals, open questions.
- `INTEGRATION_ROADMAP.md` — MVP approach (no integrations), phasing for Hostaway, WhatsApp, Email, Asana, Slack, Google Calendar, Airbnb/Booking, Guesty, Accounting; integration principles; per-integration checklist; explicit do-nots.
- `AI_FEATURE_ROADMAP.md` — assistive-not-authoritative principle, classification of 14 candidate features into must/useful-later/expensive/not-recommended buckets, cost control plan, privacy considerations, summary of what ships when.
- `DEPLOYMENT_GUIDE.md` — beginner-safe deployment plan with three environments (local/preview/production), pre-deploy checklist, step-by-step first deploy, migration rules, rollback playbook, backup notes, secrets hygiene, "when to call for help" list.
- `NON_TECHNICAL_USER_GUIDE.md` — operator's manual for the non-technical founder: how to work with Claude safely, prompt usage order, glossary, what to do when something feels wrong, founder commitments, current next step.

Memory files updated:
- `TASK_LOG.md`, `CHANGELOG.md` (this entry), `KNOWN_ISSUES.md`, `TESTING_CHECKLIST.md`.

### Decisions locked in this session

- Stack: **Next.js (App Router) + Tailwind + shadcn/ui + Supabase (Postgres + Auth + Storage + Edge Functions) + Vercel + GitHub + VS Code + pnpm + TypeScript strict**.
- Offline local DB: **Dexie / IndexedDB**.
- Data fetching: **TanStack Query**.
- Forms: **react-hook-form + zod**.
- Multi-tenancy: **one shared database, every business table carries `company_id`, RLS enforced**.
- Photo storage: **Supabase Storage in MVP**; revisit Cloudflare R2 only if cost demands.
- Image compression: **client-side, long edge 2000px, JPEG ~80%**.
- Realtime, push notifications, native app, AI features, PDF export: **all deferred** out of v1.
- Currency assumption: **ZAR**, single currency per company in MVP (pending founder confirmation — now confirmed).
- Owner monthly report = the headline deliverable; structured-data-only; manager-approved before owner sees it.
- AI features: **none in v1**. Drafting-only features arrive in v1.5. AI never decides accountability or money.

### Risks introduced

None. No code created. No external services connected. No data created.

### Rollback note

If any planning document is wrong or off-direction, it can be edited freely. There is no production system, no deployed code, no database, and no external integrations to roll back from. The "rollback" is simply revising the docs in a future session.

### Note about session continuity

This planning work spanned two sessions on the same day. The first session reached a usage cap after completing 6 of the 17 required deliverables; the second session resumed using the existing files on disk and the project memory documents, and completed the remaining 11. The handoff worked because the docs system was already in place — this is exactly the failure mode the doc-driven approach is designed for.

---

## 2026-05-12 — Initial setup (pre-planning)

### Session goal

Create the starter project structure.

### Files created

- `CLAUDE_PROJECT_SKILLSET.md` (project-level operating rules for Claude).
- `docs/*` placeholder files.
- `prompts/*` workflow prompts.

### Summary

Created the starter memory system and prompt package for controlled Claude planning.

### Risks introduced

None.

### Rollback note

Delete the starter files if needed. No production code or external services are affected.
