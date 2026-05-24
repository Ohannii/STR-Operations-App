# TASK_LOG.md

## Current objective

**v1.0 Skeleton Milestone complete + documentation alignment (2026-05-24).** The empty Next.js skeleton was built, verified (`pnpm dev` and `pnpm build` pass), and merged to main via PR #1. It has no features, no auth, and no data — a verified toolchain baseline, not a product.

Documentation alignment is complete on branch `docs/v1-foundation-planning-alignment`: the naming distinction between the **v1.0 Skeleton Milestone** (complete) and **Product Stage v1.0** (the inspection/foundation product, not yet started) is now explicit across the planning docs. Key Replit prototype findings have been moved from referenced-by-number to explicitly documented in the correct files. Branch awaits review and merge.

**The next objective is the first Product Stage v1.0 build session:** Supabase staging connection. Use `prompts/SUPABASE_CONNECTION_PROMPT.md` (new) then `prompts/STAGED_BUILD_PROMPT.md`.

### Prototype findings incorporated (2026-05-14)

All 17 findings recorded and reflected in docs. Key ones:
- #1 Flag inherits apartment + inspection context; never re-asks property.
- #2 Saving a flag never submits the inspection (stays draft until explicit Submit).
- #3 After saving a flag: Continue / Go to Action Centre / Review flag.
- #5,#6 Inspection history states (In progress/Submitted/Reviewed/Closed) + full historical detail view.
- #7 Damage/maintenance note captured in the guided flow before save.
- #8 Action-needed picker options (reclean, deep clean, maintenance, guest notify, needs Asana, owner approval, monthly owner charge, record-only).
- #9 Child actions optional during inspection.
- #10,#16 Managers edit child-action statuses from the Action Centre; "maintenance required" visibly attaches a maintenance child.
- #11 Asana logging queue (global + per-apartment + print-friendly export + mark-as-logged), one task per parent flag.
- #12 Clear Submit Inspection button + completion summary.
- #13 Pre-arrival Evidence Pack one-tap button.
- #14,#15 Add flag any time from the Action Centre via quick-add buttons.
- #17 One parent flag holds all child actions; no scattered duplicates.

### Tooling setup (2026-05-14) — COMPLETE

- Windows; project at `C:\Users\annem\Projects\STR-Operations-App` (outside OneDrive).
- VS Code; Node v24.16.0; npm 11.13.0 (`npm.cmd`); pnpm 11.2.2 (`pnpm.cmd`); Git 2.51.0.
- PowerShell blocks `.ps1` — always use `.cmd`. Do not change execution policy unless needed.
- Private GitHub repo `https://github.com/Ohannii/STR-Operations-App`, `origin` connected, pushes working, tree clean.
- `.gitignore` verified (node_modules, .env/.env.*, build dirs, .vercel/.supabase, OS junk; allows .env.example).
- Tooling setup log committed.
- NOT done by design: no app code, no `pnpm install`, no Next.js project, no migrations, no Supabase/Vercel, no deploy.

### Founder gating approvals (2026-05-14)

1. ✅ Dropinn approval caps approved as documented (R1,000 / R2,000 / R2,000-month / R60,000-year, per property; internal ceiling R2,000; absolute block R10,000).
2. ✅ Annual audit — UI waits until v1.3; schema supports annual audit from v1.0.
3. ✅ Turnover inspection is the default workflow.
4. ✅ Four-stage plan v1.0 → v1.3 approved.
5. ✅ Parent flag/problem thread is the deduplication rule.

Recorded in `PRE_BUILD_READINESS_CHECKLIST.md`.

## Completed

### v1.0 Skeleton Milestone (2026-05-23) — COMPLETE

- Next.js 15 skeleton created with pnpm, TypeScript, Tailwind, App Router.
- `pnpm install`, `pnpm dev` (served at localhost:3000), and `pnpm build` all pass.
- Branch `build/v1-0-skeleton` merged to main via PR #1.
- No features, no auth, no database, no service connections. This was the toolchain verification milestone only.
- The dev server was stopped after verification — subsequent "refused to connect" screenshots were not failures.

### Documentation alignment — v1.0 naming + prototype findings (2026-05-24) — COMPLETE

Branch: `docs/v1-foundation-planning-alignment`. Seven files changed:

- `docs/PRODUCT_REQUIREMENTS.md` — added v1.0 naming disambiguation note (Skeleton Milestone vs Product Stage v1.0) at the staging table.
- `docs/FLAG_AND_ACTION_MODEL.md` — added explicit "Evidence core is append-only after submission" section (was only a plan in `KNOWN_ISSUES.md`).
- `docs/INSPECTION_WORKFLOWS.md` — added Pre-arrival Evidence Pack button reference to inspector confirmation screen (prototype finding #13).
- `prompts/SUPABASE_CONNECTION_PROMPT.md` — new file; the prompt for the Supabase staging connection session.
- `docs/KNOWN_ISSUES.md` — updated Active Issues with skeleton milestone state note.
- `docs/APARTMENT_ACTION_CENTRE.md` — added Section 7 "Inspection history" to the Property view (prototype findings #5, #6); now explicitly links inspection history from the apartment dashboard and documents the paired pre-arrival/post-stay display for evidence comparison.
- `docs/TASK_LOG.md` — this file.
- `docs/CHANGELOG.md` — new entry (see that file).

### This session — evidence-camera + turnover + dedup refinement (2026-05-14)

Ten new docs created and verified complete:
- `docs/DEDUPLICATION_AND_TASK_GROUPING_RULES.md` — flag-as-parent; one card per problem; work-strip nesting; Asana copy-paste one-task-per-flag.
- `docs/EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md` — Vault as a filtered view over the one photos table (not a separate module); WhatsApp notify inside the flag card; screenshot proof.
- `docs/EVIDENCE_CAMERA_AND_PHOTO_NOTES.md` — camera-stays-open, photo strip, multi-upload, optional notes (per photo / selected / proof set), RedRabbit benchmark.
- `docs/TEMPLATE_AND_INVENTORY_MODEL.md` — three-layer template model, per-property inventory, Mark-All-OK, mandatory-individual, record-only observations, one-off items.
- `docs/TURNOVER_INSPECTION_WORKFLOW.md` — combined post-stay + pre-arrival; junior-inspector mode; auto-spawn rules; feeds Action Centre.
- `docs/PRE_BUILD_READINESS_CHECKLIST.md` — the gate between planning and building.
- `docs/SEED_DATA_PLAN.md` — what auto-exists on company creation.
- `docs/COST_TRACKER.md` — service costs; currently $0.
- `docs/FIELD_TEST_PROTOCOL.md` — real-apartment test at each stage gate.
- `prompts/STAGED_BUILD_PROMPT.md` — per-stage scope enforcement.

Fifteen existing docs updated:
- `CLAUDE_PROJECT_SKILLSET.md` — 5-minute end-of-session ritual added.
- `DATABASE_SCHEMA_PLAN.md` — **rewritten as final consolidated clean definitions (not patch notes)**; flag-as-parent (children carry `parent_flag_id`, no `linked_*` on flags); `inspections` has outgoing/incoming stay FKs; all photo FKs nullable; `retention_class` on photos; approval policy + emergency override fields; per-property caps.
- `PRODUCT_REQUIREMENTS.md` — turnover primary; evidence camera in v1.0; dedup discipline; emergency override; hard product anchors; per-property caps.
- `INSPECTION_WORKFLOWS.md` — turnover primary flow; speed/capture/flag mechanics; cross-refs.
- `PHOTO_AND_EVIDENCE_SYSTEM.md` — Evidence Camera Mode pipeline; vault-as-view.
- `PHOTO_RETENTION_POLICY.md` — turnover-based volume estimate (~3,800/mo, not 6,000); numbers marked as estimates.
- `REPORTING_REQUIREMENTS.md` — "hide OK items" toggle; photo timestamps + proof-set note rendering.
- `FLAG_AND_ACTION_MODEL.md` — reversed FK relationship; dedup cross-reference.
- `APARTMENT_ACTION_CENTRE.md` — one-card-per-problem; work strip; standalone work section.
- `GUEST_DAMAGE_RECOVERY_WORKFLOW.md` — WhatsApp lives in the flag card; `recovery_message_proof`; `parent_flag_id`.
- `INTEGRATION_ROADMAP.md` — Asana optional outbound; one task per parent flag; one-way only.
- `USER_ROLES_AND_PERMISSIONS.md` — template-editor vs property-override permissions; emergency override permissions + post-event review.
- `TESTING_CHECKLIST.md` — tests for turnover, Mark-All-OK, Evidence Camera (20 photos/60s), dedup acceptance, Vault search, WhatsApp deep-link, emergency override, per-property caps.
- `TASK_LOG.md` — this file.
- `CHANGELOG.md` + `KNOWN_ISSUES.md` — updated (see those files).

### Original planning blueprint (sessions before 2026-05-12)
- Full planning blueprint drafted across 13 doc files + 4 memory files = 17 files total.

### Founder review session (2026-05-12)
- All six founder open questions resolved (currency = ZAR, first customer = own STR operation, no domain yet, no AI in v1, HTML reports must be print-quality, stack approved).
- Blueprint reviewed for gaps, contradictions, over-complexity, missing safety, scope creep.
- v1 split into staged sub-releases v1.0 → v1.3.
- 11 files updated.
- Save-as-you-go rule added to `CLAUDE_PROJECT_SKILLSET.md`.


### Operational logic test session (2026-05-12 → 2026-05-13)
Founder applied an end-to-end operational test with new context:
- ~300 pre-arrival inspections/month, ~50 annual audits/year.
- Heavy operational use of Asana + WhatsApp (currently messy).
- Dropinn-style contract limits (R1,000 / R2,000 / R2,000 monthly / R60,000 annual).
- Cost recovery cascade: every Rand of damage must end up paid by someone (guest → OTA → company → owner).
- Small unskilled team — UI must be "stupid-proof."

**Verdict: PROCEED WITH CHANGES.** Foundation solid. Six critical structural gaps closed.

**Seven new docs created and saved:**
1. `docs/OPERATIONS_LOGIC_TEST.md`
2. `docs/FLAG_AND_ACTION_MODEL.md`
3. `docs/APPROVAL_LIMITS_AND_CONTRACT_RULES.md`
4. `docs/PHOTO_RETENTION_POLICY.md`
5. `docs/GUEST_DAMAGE_RECOVERY_WORKFLOW.md`
6. `docs/OWNER_COMMUNICATION_WORKFLOWS.md`
7. `docs/APARTMENT_ACTION_CENTRE.md`

**Nine existing docs updated:**
1. `CLAUDE_PROJECT_SKILLSET.md` — added stupid-proof UX as first-class principle (12 rules).
2. `docs/PRODUCT_REQUIREMENTS.md` — fully rewritten; goals rewritten for operational-source-of-truth framing; v1 re-staged.
3. `docs/DATABASE_SCHEMA_PLAN.md` — added new tables: `stays`, `flag_categories`, `flags`, `approval_policies`, `approval_decisions`, `guest_recovery_tasks`, `recovery_attempts`, `weekly_status_updates`. Added columns to `photos` (`retention_class`, `bytes_deleted_at`, plus new FKs), `accountability_records` (cascade fields), `inspections` (`stay_id`), `companies` (`seed_policy_applied`).
4. `docs/INVENTORY_AND_MAINTENANCE_LOGIC.md` — added "Part 1.5 — Cost recovery cascade" with no-leakage rule, transition table, three worked examples; expanded accountability record fields.
5. `docs/REPORTING_REQUIREMENTS.md` — added weekly owner status update as report type 2.5.
6. `docs/PHOTO_AND_EVIDENCE_SYSTEM.md` — added `retention_class` field, new FK columns, retention lifecycle summary with cross-reference.
7. `docs/USER_ROLES_AND_PERMISSIONS.md` — added approval policies and overrides permissions matrix; added weekly update permissions.
8. `docs/INSPECTION_WORKFLOWS.md` — promoted pre-arrival to v1.0; added annual audit as v1.3 seeded template; added stay-pairing notes; documented volumes.
9. `docs/TASK_LOG.md` — this file.

**Memory files updated:**
- `docs/CHANGELOG.md`
- `docs/KNOWN_ISSUES.md`
- `docs/TESTING_CHECKLIST.md`

## Key decisions locked in this test

- **Schema decisions are roadmap decisions**: anything needing v1.0 data must be in v1.0 schema even if its UI ships later.
- **Adapter pattern reaffirmed**: Asana stays optional outbound; the app is source of truth.
- **No WhatsApp API integration needed for MVP** — copy-paste with `wa.me` deep-link is sufficient.
- **Dropinn approval defaults seeded** as the South African STR market default (R1,000 / R2,000 / R2,000 monthly / R60,000 annual / internal ceiling R2,000 / absolute block R10,000).
- **Three approval ceilings**, not one: `internal_approvable_below` / `internal_ceiling` / `absolute_block_above`.
- **Photo retention promotion is one-way** (routine → dispute possible; dispute → routine blocked at policy level).
- **Cost recovery is a chain** (multiple `recovery_attempts` rows per task), not a single field.
- **Pre-arrival is highest-volume use case**, not the smallest — must ship in v1.0.

## v1 re-staged

| Stage | Headline |
|---|---|
| **v1.0** Inspection loop + foundation | Pre-arrival + post-stay ship together. Basic Action Centre ships. Full flag taxonomy in schema. `approval_policies` seeded. `stays` entity. `retention_class` on every photo. |
| **v1.1** Maintenance + Guest recovery | Issues + maintenance + before/after + verify. NEW: `guest_recovery_tasks` + `recovery_attempts` + copy-paste message templates + deadline dashboard + cost recovery cascade fields. |
| **v1.2** Accountability + Policy enforcement | Inventory + accountability + active enforcement of approval caps. Pending-owner-approval flow + per-property monthly/annual spend widgets. |
| **v1.3** Owner communication + audit | Weekly owner update (new) + monthly summary + annual audit template + owner-facing dashboard. |

## In progress

None — the documentation alignment is complete and awaiting commit/PR merge.

## Next actions (in order)

1. ✅ **DONE (2026-05-14)**: Pre-build gating decisions approved (Dropinn caps; annual-audit UI v1.3; turnover default; four-stage plan; flag-as-parent dedup).
2. ✅ **DONE (2026-05-14)**: Tooling setup complete (Node, pnpm, Git, VS Code, GitHub, `pnpm dev` verified).
3. ✅ **DONE (2026-05-23)**: v1.0 Skeleton Milestone built and merged to main (empty Next.js shell; `pnpm build` passes).
4. ✅ **DONE (2026-05-24)**: Documentation alignment — skeleton/stage naming resolved; key prototype findings explicitly documented; `prompts/SUPABASE_CONNECTION_PROMPT.md` created.
5. **Next**: Review and merge branch `docs/v1-foundation-planning-alignment`. Then open a new session, read `prompts/SUPABASE_CONNECTION_PROMPT.md`, and connect the skeleton to a new **staging** Supabase project. Connection + health check only — no schema, no auth, no features.
6. After Supabase staging is connected and verified: run v1.0 schema migrations on staging using `prompts/STAGED_BUILD_PROMPT.md` (stage = v1.0).
7. Only after schema + RLS verified on staging: begin Product Stage v1.0 feature build (auth, inspection workflow, flag capture).

## Recommended improvements — ALL FIVE NOW APPLIED (2026-05-14)

The five improvements recommended in the original review session have all been created/applied this session:

1. ✅ `prompts/STAGED_BUILD_PROMPT.md` — created.
2. ✅ `docs/SEED_DATA_PLAN.md` — created.
3. ✅ 5-minute end-of-session ritual — added to `CLAUDE_PROJECT_SKILLSET.md`.
4. ✅ `docs/COST_TRACKER.md` — created.
5. ✅ `docs/FIELD_TEST_PROTOCOL.md` — created.

No outstanding recommended-but-unapplied improvements remain.

## Blockers

None.

## Handoff note for the next session

Planning is complete. Tooling is complete. The v1.0 Skeleton Milestone is merged to main. Documentation alignment is done on branch `docs/v1-foundation-planning-alignment` — merge that branch first, then start the Supabase connection session.

**The next safe step is:** merge the doc alignment branch, then open a new session with `prompts/SUPABASE_CONNECTION_PROMPT.md` and connect the skeleton to a staging Supabase project. Do not skip to schema migrations in the same session as the connection setup — keep them separate so each session has one clear goal. Use `prompts/STAGED_BUILD_PROMPT.md` for every build session once the connection is verified.

## Outstanding decisions for the founder

None. All five pre-build gating decisions were approved on 2026-05-14 (recorded above and in `PRE_BUILD_READINESS_CHECKLIST.md`). Everything is locked. The next step is the Supabase staging connection session.
