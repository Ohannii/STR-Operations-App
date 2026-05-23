# TESTING_CHECKLIST.md

## Planning validation checklist (completed)

- [x] Product brief is clear (`PROJECT_BRIEF.md`).
- [x] MVP scope is separated from later phases (`PRODUCT_REQUIREMENTS.md`).
- [x] **v1 is staged into v1.0 → v1.3 with per-stage acceptance criteria** (founder review 2026-05-12).
- [x] Mobile-first UX is defined (`INSPECTION_WORKFLOWS.md`, `PRODUCT_REQUIREMENTS.md`).
- [x] Offline strategy is defined (`INSPECTION_WORKFLOWS.md`, `TECHNICAL_ARCHITECTURE.md`).
- [x] Photo/evidence strategy is defined (`PHOTO_AND_EVIDENCE_SYSTEM.md`).
- [x] Role permissions are defined (`USER_ROLES_AND_PERMISSIONS.md`).
- [x] Multi-company data isolation is planned (`TECHNICAL_ARCHITECTURE.md`, `DATABASE_SCHEMA_PLAN.md`).
- [x] Inventory / accountability logic is defined (`INVENTORY_AND_MAINTENANCE_LOGIC.md`).
- [x] Maintenance workflow is defined (`INVENTORY_AND_MAINTENANCE_LOGIC.md`).
- [x] Reporting / export requirements are defined (`REPORTING_REQUIREMENTS.md`).
- [x] **HTML report presentation quality bar is defined** (founder review 2026-05-12).
- [x] Integration roadmap is realistic (`INTEGRATION_ROADMAP.md`).
- [x] AI features are optional and cost-aware (`AI_FEATURE_ROADMAP.md`).
- [x] Risks and bugs are anticipated (`KNOWN_ISSUES.md`).
- [x] Beginner workflow is documented (`NON_TECHNICAL_USER_GUIDE.md`).
- [x] Deployment safety is planned (`DEPLOYMENT_GUIDE.md`).
- [x] Memory files updated (`TASK_LOG.md`, `CHANGELOG.md`, `KNOWN_ISSUES.md`, this file).

## Founder review checklist (done in this session)

- [x] All six founder open questions resolved.
- [x] Blueprint reviewed for gaps, contradictions, over-complexity, missing safety, scope creep.
- [x] v1 split into staged sub-releases.
- [x] Approved rule change applied to `CLAUDE_PROJECT_SKILLSET.md`.
- [x] 5 additional improvements recommended but not auto-applied (listed in `TASK_LOG.md`).

## Founder physical-save checklist (next)

- [ ] All 11 updated files downloaded from this session and saved into the project folder, replacing previous versions.
- [ ] Founder has skim-read the 11 updated files.
- [ ] Founder has decided which of the 5 recommended improvements to accept.

---

## v1.0 milestone gate (inspection loop)

A v1.0 release cannot be promoted to staging until **all** of these pass:

### Project skeleton

- [ ] Empty Next.js app builds locally.
- [ ] App deploys to Vercel preview successfully.
- [ ] Preview URL loads on iPhone Safari, Android Chrome, Mac/Windows desktop.
- [ ] PWA install prompt appears on Android Chrome.
- [ ] PWA installs to iOS home screen.

### Authentication and tenancy

- [ ] A user can sign up.
- [ ] A user can sign in.
- [ ] A user can sign out.
- [ ] A user can reset their password.
- [ ] A Company Admin can invite one user (the inspector).
- [ ] A user cannot belong to another company without being invited.

### Multi-tenant isolation (CRITICAL — runs every v1.x release)

- [ ] User A in Company A cannot see Company B's properties (UI).
- [ ] User A in Company A cannot fetch Company B's properties via direct API call.
- [ ] User A in Company A cannot read Company B's photo URLs even if guessed.
- [ ] An anon API key cannot bypass RLS on any business table.
- [ ] The service-role key is never present in the client bundle (confirmed via build output inspection).

### Properties

- [ ] Company Admin can create a property.
- [ ] Company Admin can edit a property.
- [ ] Company Admin can archive a property (soft-delete; still queryable).
- [ ] An inspector assigned to a property sees it in their list.
- [ ] An inspector not assigned to a property does not see it.

### Inspection templates (v1.0 — seed only)

- [ ] A default Pre-arrival template auto-installs when a company is created.
- [ ] A default Post-stay template auto-installs when a company is created.

### Stays entity (new — v1.0)

- [ ] Starting a pre-arrival inspection optionally creates or attaches to a `stays` row.
- [ ] A post-stay inspection started for the same property + window attaches to the same `stays` row.
- [ ] The Property view in the Action Centre shows pre-arrival and post-stay side by side once both exist for the same stay.

### Flag taxonomy (new — v1.0)

- [ ] On company creation, all 11 default `flag_categories` rows are seeded.
- [ ] Inspector can raise a flag from a line item and pick a type from the 11 categories.
- [ ] Each category renders with an icon + 3-word label, not its internal enum key.
- [ ] At least 3 different flag types (e.g. maintenance issue, inventory missing, condition note) can be raised on the same inspection.
- [ ] Each raised flag writes a `flags` row with the correct `flag_category_id` and `raised_by` user.
- [ ] Manager can re-classify a flag after submit; original type preserved in audit.
- [ ] Safety / urgent flag raises a manager notification (or visible badge in v1.0 thin form).

### Approval policies (new — v1.0 schema only)

- [ ] On company creation, the `companies.seed_policy_applied` flag flips to true.
- [ ] A `approval_policies` row exists with `scope_type = 'company'` and the Dropinn defaults (R1,000 / R2,000 / R2,000 monthly / R60,000 annual / internal ceiling R2,000 / absolute block R10,000).
- [ ] Company Admin can view the policy in the admin UI (read-only in v1.0).
- [ ] The policy is not used for enforcement in v1.0 (enforcement is a v1.2 test).

### Inspection workflow

- [ ] Inspector can start a **Turnover** inspection (combined post-stay + pre-arrival) from a property's Action Centre card in one tap.
- [ ] Inspector can start a **pre-arrival-only** inspection.
- [ ] Inspector can start a **post-stay-only** inspection.
- [ ] Turnover links the outgoing stay and (when known) incoming stay on the inspection record.
- [ ] Sections render one at a time.
- [ ] Status pills update.
- [ ] Notes save.
- [ ] Required-photo items block submit if no photo.
- [ ] Auto-save drafts every change.
- [ ] Resume in-progress inspection after closing the app.
- [ ] Final review summary is accurate, including all flags raised.
- [ ] Final review asks "ready for next guest?" and blocks "Ready" while a `safety_urgent` flag is open.
- [ ] Submit transitions the inspection to `submitted` and writes an audit event.
- [ ] Submit routes the inspector to the property's Action Centre (not back to a list).

### Turnover speed mechanics (new — v1.0)

- [ ] "Mark all OK" at section level sets all non-flagged, non-mandatory items to OK in one tap.
- [ ] "Mark all OK" is disabled / partial for a section containing `mandatory_individual` items, with a clear message.
- [ ] Mandatory-individual items (all safety + all appliances by default) must be tapped one by one.
- [ ] A bulk-OK action records `bulk_ok_at` / `bulk_ok_by` for audit.
- [ ] The Inventory section auto-populates from the property's `inventory_items`.
- [ ] "Add observation" records a `condition_note`/`no_action_record` that does NOT appear in the Action Centre open queue but IS in property history.
- [ ] A record-only observation can be promoted to an active flag later, with an audit row.
- [ ] An inspector can add a one-off check inside an in-progress inspection without changing the template.
- [ ] A clean turnover of a real apartment completes in 8–15 minutes on a real iPhone.

### Evidence Camera Mode (new — v1.0)

- [ ] Inspector can open the camera once and take 20 photos in a row without the camera closing between shots.
- [ ] 20 photos from one line item can be captured in under 60 seconds on a real iPhone.
- [ ] Captured photos appear immediately in the on-screen photo strip.
- [ ] Long-press on a strip thumbnail deletes it (with confirmation for older shots).
- [ ] Multi-upload from gallery works with multi-select.
- [ ] On "Attach", all photos link to the surface the camera was opened from, with the derived `retention_class`, with no per-photo tagging.
- [ ] Optional note can be added to a single photo.
- [ ] Optional note can be applied to multiple selected photos.
- [ ] Optional note can be applied to all photos in the proof set (same string on each row).
- [ ] No required-note prompt appears unless the line item or flag type requires it.
- [ ] `guest_damage` and `safety_urgent` flag types DO require a note before submit.
- [ ] EXIF GPS stripped from every uploaded photo.
- [ ] Photos captured offline show `queued`; auto-upload resumes on reconnect → `synced`.
- [ ] After a mid-session app crash, queued photos survive on restart.

### Deduplication / one-card-per-problem (new — v1.0)

- [ ] One broken-TV problem (flag + recovery task + maintenance job + accountability) shows as ONE Action Centre card, not four.
- [ ] The card shows child records in a work strip with their statuses.
- [ ] Tapping a child chip opens its focused view; closing returns to the card.
- [ ] Searching for "TV" returns one parent result, not several.
- [ ] Resolving all children prompts/auto-closes the parent flag.
- [ ] Re-opening a child re-opens the parent flag.
- [ ] A standalone scheduled job (no parent flag) appears as its own card and is NOT treated as a duplicate.
- [ ] Generated Asana copy-paste text contains one task per parent flag, children listed as a checklist inside it.

### Evidence Vault search (new — v1.0)

- [ ] From the Action Centre, an inspector can find pre-arrival proof for a specific stay in under 30 seconds.
- [ ] From a flag card, related dispute evidence is visible with zero navigation (Evidence Drawer).
- [ ] Vault filters work: property, stay, inspection, flag, date range, retention class, inspector.
- [ ] The Vault is a view over the one `photos` table — no separate upload path exists.
- [ ] Selecting photos and tapping "Open WhatsApp" produces a `wa.me` deep-link with the message text encoded.

### Apartment Action Centre (new — v1.0 thin version)

- [ ] On login, a Company Admin lands on the Portfolio view by default.
- [ ] Each property row shows: name, thumbnail, status pill, open-problem count.
- [ ] Sort puts properties with the most open items at the top.
- [ ] Tapping a property opens the Property view.
- [ ] Property view shows: header, Open problems (one card per flag), Standalone work, Coming Up (next 7 days of inspections).
- [ ] Empty sections show calm empty states, not blank tables.
- [ ] An Inspector home variant shows their assigned inspections today + their own raised flags only (no portfolio view, no financials).
- [ ] Refresh-on-focus works (returning from a detail screen updates the counts).

### Photos

- [ ] Capture photo via camera works on iPhone Safari.
- [ ] Capture photo via camera works on Android Chrome.
- [ ] Photos compress before upload (size < 500KB typical).
- [ ] Photo sync state visible per photo: queued / uploading / synced / failed.
- [ ] Photo upload retries on failure with backoff.
- [ ] Photo bytes go to Supabase Storage at the correct path.
- [ ] Photo metadata row created in `photos` table with correct FKs.
- [ ] **Every photo row has a `retention_class` value set, derived from its source (routine_pre_arrival / routine_post_stay / inventory_evidence / etc.).**
- [ ] EXIF GPS is stripped before upload.
- [ ] A user cannot upload a photo larger than the server limit (rejected with clear error).

### Offline behaviour

- [ ] Inspection in progress survives airplane mode for 10 minutes.
- [ ] Photos captured offline queue locally.
- [ ] On reconnect, drafts and photos sync without user action.
- [ ] Sync banner shows correct counts during and after sync.
- [ ] Same inspection cannot be submitted twice (idempotent by `client_uuid`).

### Inspection report (v1.0) — print-quality

- [ ] Inspection report renders correctly in browser.
- [ ] Report passes the validation checklist in `REPORTING_REQUIREMENTS.md`:
  - [ ] No raw UUIDs or developer text.
  - [ ] Generous whitespace, plain typography.
  - [ ] Header includes company, property, inspector, timestamps.
  - [ ] Footer includes generated-at and "Generated from structured data" line.
  - [ ] Browser Print → Save as PDF produces a clean A4 document.
  - [ ] `@media print` hides nav, sidebars, edit controls.
  - [ ] Page breaks fall between sections, not inside a line item.
  - [ ] Photos appropriately sized in print (no full-resolution overflow).
  - [ ] Prints acceptably in black-and-white (no info-by-colour-only).

### Audit

- [ ] Every inspection submit writes an `audit_events` row.
- [ ] Photo uploads write `audit_events` rows.
- [ ] No user can delete from `audit_events` via UI or API.

### v1.0 real-apartment field test

- [ ] At least one real **pre-arrival** inspection has been completed in a real Durban apartment on the founder's iPhone with normal (not perfect) signal.
- [ ] At least one real **post-stay** inspection has been completed in the same apartment for the same `stays` row.
- [ ] At least 3 different flag types were raised during the field test (e.g., maintenance issue, inventory missing, condition note).
- [ ] The Apartment Action Centre correctly showed the property as "Needs attention" with the right open-flag count after the post-stay inspection.
- [ ] No data was lost.
- [ ] All photos eventually appeared as `synced` and have a `retention_class` set.
- [ ] The resulting inspection reports are shareable with a (hypothetical) owner without embarrassment.

---

## v1.1 milestone gate (maintenance loop)

### Issues

- [ ] Inspector can flag an item that creates an issue draft.
- [ ] Manager can convert a flagged item to a formal issue.
- [ ] Issue status transitions are audited.
- [ ] Photos attach to issues correctly.

### Maintenance

- [ ] Coordinator can create a maintenance job from an issue.
- [ ] Tech sees only their assigned jobs.
- [ ] Tech cannot mark a job `done` without an "after" photo.
- [ ] Manager can verify a `done` job; tech cannot self-verify.
- [ ] Cost changes after `verified` are blocked except for Company Admin.

### Guest damage recovery (new — v1.1)

- [ ] A flag of type "guest damage" on a post-stay inspection auto-creates a `guest_recovery_tasks` row.
- [ ] The recovery task's `deadline_at` defaults to checkout + 24h.
- [ ] The Action Centre's "Today's recovery deadlines" widget shows the task with a colour-coded badge (green / amber / orange / red as appropriate).
- [ ] Manager can pick a message template; variables are filled correctly from the task and property.
- [ ] "Copy" button copies the rendered message to clipboard.
- [ ] "Open WhatsApp" deep-links to `wa.me/<phone>?text=<encoded>` when a guest phone is on the stay record.
- [ ] Manager can mark "sent" with a screenshot evidence upload.
- [ ] Manager can record a response with an outcome from the enum (paid_full / paid_partial / refused / no_response / denied).
- [ ] The recovery task can move through the full state machine to `closed` with a `final_chargeable_party` set.
- [ ] Closing with `final_chargeable_party = 'owner'` correctly creates an `accountability_record` linked to the recovery task.
- [ ] Every state change writes an audit event.

### Cost recovery cascade (new — v1.1)

- [ ] Every `accountability_record` reaches a `closed` state with `final_chargeable_party` set; no records left in unresolved states indefinitely.
- [ ] Records in `not_attempted` for > 7 days surface on the Action Centre as "stale".
- [ ] Records in `guest_attempted` past their deadline surface as overdue.
- [ ] Records in `ota_attempted` for > 30 days surface as "OTA stale — decide fallback".
- [ ] An `absorbed_reason` text field is required to close a record as `chargeable_party = 'company'`.
- [ ] The "leakage check" report flags any record older than 60 days without `final_chargeable_party` set.

### v1.1 real-apartment field test

- [ ] At least one maintenance job has been raised from a real inspection, assigned, done with after photos, and verified by the manager.
- [ ] At least one guest damage recovery task has been completed end-to-end, including a real copy-paste WhatsApp send and recorded response.

---

## v1.2 milestone gate (accountability loop)

### Inventory and accountability

- [ ] Inspector can record a missing inventory item with photo.
- [ ] Ops Manager can approve a chargeable record; audit event written.
- [ ] Approval cannot happen without a linked photo.
- [ ] Edits to an approved record require unapproval first; audited.

### Approval policy enforcement (new — v1.2)

- [ ] A charge ≤ the single-item cap is approved directly by a manager.
- [ ] A charge > the single-item cap is automatically routed to `pending_owner_approval`, not silently approved.
- [ ] The system shows the manager a pre-filled copy-paste message with the right variables (guest name, property, amount, photos).
- [ ] Manager can mark "sent" and record the owner response with screenshot evidence.
- [ ] Manager can record `owner_approved` or `owner_rejected`; the accountability record state updates accordingly.
- [ ] The audit trail shows the full chain: raised → cap hit → owner asked → owner answered → final approval.
- [ ] A second charge in the same month that would push the running total over the monthly cap correctly enters `pending_owner_approval`, regardless of its individual size.
- [ ] The annual cap calculation uses a rolling 12-month window and trips correctly.
- [ ] A property-level override correctly takes precedence over the company-level policy.
- [ ] An owner-level override correctly takes precedence over the company-level policy for that owner's properties.
- [ ] A property-level override correctly takes precedence over an owner-level override.
- [ ] A charge above `absolute_block_above` cannot be approved without GM or Company Admin override.
- [ ] A one-off cap override writes a prominent audit row including the actor's written reason.
- [ ] Monthly and annual caps are computed **per property** (not per company).
- [ ] **Emergency over-limit maintenance:** Ops Manager (or above) can mark a safety/urgent job to proceed before approval; the job records `emergency_override = true`, a required `emergency_override_reason`, and the actor + timestamp.
- [ ] An emergency override creates an `approval_decisions` row with `decision = 'emergency_override'`.
- [ ] An emergency override surfaces on the Action Centre "Pending approvals" for post-event review by GM / Company Admin.
- [ ] An emergency override cannot be invoked by an Inspector or Maintenance Tech.

### Action Centre additions (v1.2)

- [ ] "Pending approvals" section appears per property and as a portfolio summary.
- [ ] Per-property this-month owner spend bar correctly reflects approved totals.
- [ ] "Awaiting owner — N days" surfaces for items aged > 7 days.

### v1.2 real-apartment field test

- [ ] At least one approved accountability record exists with a real photo, real approval timestamp, and real auditor.
- [ ] At least one charge above the cap has been routed through `pending_owner_approval` with real owner response captured.

---

## v1.3 milestone gate (owner report loop)

### Templates (full editor)

- [ ] Admin can create a custom template.
- [ ] Pre-arrival, Post-stay, Monthly, and **Annual audit** templates exist as defaults.
- [ ] Editing a template does not retroactively change in-progress drafts.

### Weekly owner status updates (new — v1.3)

- [ ] Manager can generate a weekly update for a property from the past 7 days of real data.
- [ ] The update assembles from structured data without forcing the manager to write any text in the happy case.
- [ ] Manager can edit free-text notes and hide individual lines with a reason (audited).
- [ ] "Send" transitions the update from `draft` to `sent` and writes an audit row.
- [ ] Owner Viewer sees the sent update in the app, scoped to their property only.
- [ ] Auto-skip prompts for a week with zero activity.
- [ ] Property with weekly updates turned off shows no update in the owner's view.
- [ ] Pending owner approvals appear in the weekly update's "needs your sign-off" section.

### Reports

- [ ] Owner monthly summary can be generated from real data.
- [ ] Re-generating the same month is idempotent.
- [ ] Owner viewer sees only sent summaries for their linked properties.
- [ ] Owner viewer cannot see another property's summary.
- [ ] Once `sent`, a summary cannot be edited.
- [ ] Owner summary passes the print-quality validation checklist (same items as v1.0 inspection report, plus: total appears at the top in large type).

### Permissions

- [ ] Every role from the catalogue used in v1.0–v1.3 has been exercised with a real test user.
- [ ] Owner Viewer login flow tested end-to-end.
- [ ] Owner Viewer's photo gallery excludes routine pre-arrival and routine post-stay photos by default.

### v1.3 real-apartment field test

- [ ] At least one real owner monthly summary has been generated from a month of real founder-operation data.
- [ ] At least one real weekly status update has been generated and sent.
- [ ] The summary was reviewable end-to-end on a phone without confusion.
- [ ] The summary printed cleanly on a real (home or office) printer.
- [ ] At least one annual audit inspection has been completed using the seeded annual audit template.

---

## Mobile usability spot-checks (every release)

- [ ] One-thumb operation works on iPhone for an entire inspection.
- [ ] All tap targets are at least 44×44px.
- [ ] No critical action is hidden behind a long press only.
- [ ] Text legible in bright daylight (sufficient contrast).
- [ ] Camera flow doesn't require leaving the app.

## Performance spot-checks (every release)

- [ ] First load < 3s on a mid-range phone on 3G.
- [ ] Photo capture → thumbnail < 1.5s.
- [ ] Offline draft save < 200ms.

---

## Pre-production safety (every production deploy)

- [ ] All checklist items for the current sub-release tick green on staging.
- [ ] At least one real inspection done on a real phone in a real apartment.
- [ ] Cross-tenant isolation tests pass with two real test accounts.
- [ ] Sentry receives a deliberately-thrown test error.
- [ ] Rollback rehearsed: deploy a known-good version, then deploy a "bad" one, then roll back.
- [ ] **No real founder-operation data exists in the staging Supabase project.**
- [ ] **No test data exists in the production Supabase project.**
- [ ] **Production service-role key has not been pasted into any chat or screenshot.**
- [ ] Backup taken (or PITR timestamp noted) before any production migration in this release.
- [ ] `CHANGELOG.md` reflects the release.
- [ ] `KNOWN_ISSUES.md` reviewed; no blockers.
- [ ] Founder confidence check: "If something goes wrong tomorrow, do I know what to do?"

## Post-deployment validation (use `prompts/POST_DEPLOYMENT_VALIDATION_PROMPT.md`)

- [ ] Production app loads on a fresh device.
- [ ] Login works for all expected roles.
- [ ] Dashboards render.
- [ ] Inspection draft save works.
- [ ] Photo upload works.
- [ ] Sync state is visible.
- [ ] Reports render correctly.
- [ ] Permissions are correct.
- [ ] No Sentry errors in first 24 hours that aren't already triaged.

---

## How to use this checklist

- Tick boxes as items pass.
- If a box won't tick, **stop** and address the issue before moving on.
- Update this file in every session that touches something testable.
- Before any production deploy, every relevant box for the current sub-release must be ticked.
