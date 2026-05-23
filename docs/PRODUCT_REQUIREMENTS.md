# PRODUCT_REQUIREMENTS.md

## Product goals

1. Make inspections fast, structured, and reliable on mobile.
2. Create a trustworthy evidence record (photos + metadata + timestamps).
3. Track maintenance issues from inspection to completion with before/after proof.
4. Track inventory movement and assign accountability.
5. Support monthly owner-chargeable summaries built from structured data only.
6. **Be the operational source of truth that replaces messy Asana + WhatsApp ops chatter.**
7. **Ensure every cost is recovered from an accountable party — guest, OTA, company, or owner — with no leakage across the portfolio.**
8. **Respect each company's contract limits via configurable approval policies.**
9. Give managers portfolio-level visibility and performance metrics.
10. Be ready for SaaS multi-company use from day one.
11. Be usable by a small unskilled team — stupid-proof UX is a first-class principle, not polish.

## Core modules (full product, all phases)

1. Apartment / Property Management
2. **Apartment Action Centre** — the single home screen and central issue surface. There is no separate Issue Centre. See `APARTMENT_ACTION_CENTRE.md`.
3. Inspection System — **Turnover (combined post-stay + pre-arrival) is the primary flow**; pre-arrival-only, post-stay-only, monthly, annual audit, custom also supported. See `TURNOVER_INSPECTION_WORKFLOW.md`.
4. **Template & Inventory Model** — company-standard templates + per-property overrides + per-apartment inventory lists. See `TEMPLATE_AND_INVENTORY_MODEL.md`.
5. **Flag & Action System** — the flag is the parent record for every real-world problem; downstream records are children. See `FLAG_AND_ACTION_MODEL.md` and `DEDUPLICATION_AND_TASK_GROUPING_RULES.md`.
6. **Photo and Evidence System** — Evidence Camera Mode (camera-stays-open, multi-photo, optional notes) + retention classes. See `EVIDENCE_CAMERA_AND_PHOTO_NOTES.md`.
7. **Evidence Vault & WhatsApp workflow** — evidence is a search/filter view over the one photos table, not a separate store; WhatsApp notification lives inside the flag card. See `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`.
8. Inventory Accountability
9. Maintenance Tracking
10. **Guest Damage Recovery** — same-day workflow with copy-paste message generator
11. Accountability and Cost Recovery (with cascade chain: guest → OTA → company → owner)
12. **Approval Policy Engine** — configurable per-company / per-owner / per-property, **caps per property per month/year**, with an emergency over-limit override path.
13. Reporting and Exports (inspection, weekly owner update, monthly summary, audit) — with "hide OK items" toggle and photo timestamps/notes.
14. Dashboards
15. Integrations — **Asana is optional outbound only; never a dependency, never a duplicate task surface.**
16. Optional AI Assistance (future)

---

## MVP v1 — staged delivery

**v1 ships in four sub-releases (v1.0 → v1.3) rather than one big push.** Each sub-release is independently deployable to the founder's staging environment and testable in a real apartment.

**Re-staged after the operational logic test (2026-05-12):** pre-arrival inspection, Apartment Action Centre, flag taxonomy, approval policies, and photo retention classes were moved into v1.0's data model. Their UI is staged across v1.0–v1.3 but the schema must be right from day one.

| Stage | Headline outcome | Key scope |
|---|---|---|
| **v1.0** — Inspection loop + foundation | An inspector can do a full **Turnover inspection** (combined post-stay + pre-arrival) with fast multi-photo capture, offline. The Action Centre shows what needs attention. The schema is ready for everything that follows. | Auth + tenancy, properties, **Turnover + pre-arrival-only + post-stay-only + annual-audit templates seeded**, **per-property inventory lists**, **Mark-All-OK + mandatory-individual + record-only observations**, full mobile inspection workflow, **Evidence Camera Mode** (camera-stays-open, multi-photo, photo strip, optional notes) + sync with **retention class on every photo**, offline drafts, HTML inspection report with **"hide OK items"**, audit trail, **flag taxonomy in schema** (11 categories seeded) with **flag-as-parent + duplicate-prevention discipline**, **basic Apartment Action Centre** (portfolio + property views, grouped one-card-per-problem), **Evidence Vault search** over the photos table, **`approval_policies` table seeded with Dropinn defaults (per-property caps)**, **`stays` entity with outgoing/incoming links**, **annual-audit template kind in schema**, roles: Company Admin + Inspector. |
| **v1.1** — Maintenance + Guest recovery loop | Inspectors raise issues; coordinators assign maintenance; techs fix with before/after photos; managers verify. Guest damage flagged on a post-stay creates a same-day recovery task with deadline + copy-paste message templates. | Issues, maintenance jobs, before/after photos, verify step, **`guest_recovery_tasks` + `recovery_attempts` tables**, **message template generator**, **deadline dashboard on Action Centre**, **cost recovery cascade fields** on accountability, roles: Maintenance Coordinator + Maintenance Tech, status audit trail. |
| **v1.2** — Accountability + Policy enforcement loop | Damaged or missing items become approved accountability records. Approval policy caps are actively enforced — over-limit charges are routed to "pending owner approval" with copy-paste templates. Emergency/safety over-limit work can proceed via an audited override. | Inventory items, inventory movements, accountability records, **approval policy enforcement UI** (Dropinn per-property caps go live), **`approval_decisions` table writes**, **pending-owner-approval flow with evidence upload**, **emergency over-limit override path** (required reason + audit + post-event review), **per-property monthly/annual spend widgets on Action Centre**, Inventory Manager + Operations Manager roles. |
| **v1.3** — Owner communication + audit loop | A manager generates and sends a clean, printable HTML monthly owner summary AND a weekly owner status update. Annual audit template available. | **Weekly owner status updates** (draft → sent), **monthly owner summary** (draft → sent), **annual audit template** seeded, Property Owner Viewer role, **owner-facing dashboard**, basic performance dashboards, property readiness view, **photo retention class enforcement** (the snapshot-then-delete job for routine classes ships here OR pushes to v1.5; field stays in v1.0). |

Anything not in these four stages is **v1.5 or later** (see lower sections).

### Detailed workflow & model docs (read alongside this file)

This file is the high-level requirements and staging map. The detailed specifications live in dedicated docs, all consistent with the consolidated schema in `DATABASE_SCHEMA_PLAN.md`:

- `TURNOVER_INSPECTION_WORKFLOW.md` — the primary combined inspection flow.
- `TEMPLATE_AND_INVENTORY_MODEL.md` — company templates, property overrides, per-apartment inventory.
- `EVIDENCE_CAMERA_AND_PHOTO_NOTES.md` — fast multi-photo capture + optional notes.
- `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md` — evidence search + WhatsApp notification from the flag card.
- `DEDUPLICATION_AND_TASK_GROUPING_RULES.md` — flag-as-parent, one card per problem.
- `APARTMENT_ACTION_CENTRE.md` — the single home/issue surface.
- `FLAG_AND_ACTION_MODEL.md` — the 11-category taxonomy and conversion paths.
- `APPROVAL_LIMITS_AND_CONTRACT_RULES.md` — per-property caps + emergency override.
- `GUEST_DAMAGE_RECOVERY_WORKFLOW.md` — same-day recovery + cost cascade.
- `PHOTO_RETENTION_POLICY.md` — the seven retention classes.

### Hard product anchors (do not violate without an explicit founder decision)

1. The Apartment Action Centre is the only home/issue surface. No separate Issue Centre.
2. One real-world problem = one parent flag = one Action Centre card. Downstream records nest under it.
3. Evidence Vault / Evidence Drawer / Photo Gallery are filtered views over one `photos` table, not separate stores.
4. Asana is optional outbound only. The app is always the source of truth. Asana is never required and never the place tasks are duplicated.
5. WhatsApp notification happens from the flag card; no separate guest-recovery module is needed to send it.
6. Inspectors never make money/chargeability decisions; managers triage.

---

## v1.0 — Inspection loop + foundation (detailed scope)

### Authentication and tenancy

- Email + password login (Supabase Auth).
- Password reset via email.
- One user can belong to one company in MVP (multi-company membership comes later).
- Company Admin can invite a single user (the inspector) — full user management UI ships in v1.3.
- Every tenant-bound record carries `company_id`.
- Row-Level Security (RLS) enforces company isolation on every table from day one.

### Properties

- Create, edit, archive (soft-delete) properties.
- Property fields: name, address, unit reference, bedrooms, owner reference (light record, no full owner UI in v1.0), notes, status, **assigned manager**.
- Assign a property to one or more inspectors.
- Property archive flag — no hard delete in MVP.

### Stays (new entity in v1.0)

- A `stays` row groups a pre-arrival inspection with its matching post-stay inspection for the same guest visit.
- Fields: property, expected_arrival, expected_checkout, actual_arrival, actual_checkout, guest_first_name (optional), guest_phone (optional), ota_reference (optional, e.g. Airbnb reservation code), status.
- Created when a pre-arrival inspection is started; updated when post-stay inspection is started or completed.
- No PMS integration in v1.0 — fields are filled manually by managers.

### Inspection templates

- **Seed data on company creation:** **two** default templates — pre-arrival and post-stay (annual audit added in v1.3).
- Read-only template editing in v1.0; template editing UI ships in v1.3.

### Inspection workflow (mobile)

- Choose property, choose template, start inspection.
- If pre-arrival or post-stay, optionally link to a `stay` (creates one if needed).
- One section at a time on screen.
- Capture photos directly from camera or gallery.
- Mark line item status: OK / Damaged / Missing / Needs Attention.
- **Add a flag** with a typed category (icon + 3-word label) — see `FLAG_AND_ACTION_MODEL.md`.
- Free-text notes per item.
- Auto-save draft locally as user works.
- Resume in-progress inspection.
- Final review screen.
- Submit inspection → status becomes "submitted" → audit event recorded.

### Flag system (v1.0 — capture + classify only)

- 11-category taxonomy seeded into `flag_categories`.
- Inspectors raise flags from line items or stand-alone.
- Flag carries: type, severity, description, photos, linked inspection item.
- **Classification, conversion, and closure are managers' jobs.** Inspectors raise; managers triage.
- Conversion paths (flag → issue / movement / recovery / accountability) are wired progressively in v1.1, v1.2.

### Apartment Action Centre (v1.0 thin version)

- Portfolio view: list of properties with open-flag count and status pill.
- Property view: header + Open Flags + Open Work (= submitted inspections + flagged items pending) + Coming Up (= inspections due in next 7 days).
- Role-aware: Company Admin / Ops Manager / Inspector home variants.
- Refresh on focus; no pull-to-refresh required.
- Empty states are calm and reassuring.

### Photo capture

- Inline photo capture per line item.
- Multiple photos per line item.
- Client-side compression before upload (long edge ≤ 2000px, JPEG quality ~80).
- Upload to Supabase Storage, metadata to Postgres.
- **`retention_class` set at capture time** based on photo source (routine_pre_arrival / routine_post_stay / etc.) — see `PHOTO_RETENTION_POLICY.md`.
- Each photo linked to: company, property, inspection, line item (and optionally stay).
- Visible per-photo sync status (queued / uploading / synced / failed).
- Retry on failed uploads with exponential backoff.

### Offline drafts

- Inspections drafted offline save to IndexedDB on the device.
- Photos taken offline queue locally and upload when connectivity returns.
- Clear sync banner shows: "X items waiting to sync."
- Conflict prompt if same inspection edited on two devices.

### Inspection report (HTML only)

- Per-inspection view: property, inspector, template, timestamps, section-by-section results, photos with thumbnails, **all flags raised with their category and current status**.
- Item-level: status, notes, photos, flags.
- Must meet the presentation quality bar in `REPORTING_REQUIREMENTS.md` (clean, professional, printable, structured).

### Approval policies (v1.0 — schema and seeding only)

- `approval_policies` table created and seeded with the **Dropinn default** for any new company:
  - `single_inventory_item_cap` = R1,000
  - `single_maintenance_item_cap` = R2,000
  - `single_owner_chargeable_cap` = R2,000
  - `monthly_owner_total_cap` = R2,000
  - `annual_owner_total_cap` = R60,000
  - `internal_ceiling` = R2,000
  - `absolute_block_above` = R10,000
- Company Admin can view; no editing UI in v1.0 (added v1.2).
- **No enforcement yet** — enforcement ships in v1.2 when accountability records flow.

### Audit trail

- Every inspection state change (created → submitted) writes a row to `audit_events`.
- Photo upload events written.
- Flag raise / classify / convert / close events written.
- No user can delete from `audit_events` via UI or API.

### Roles and permissions (v1.0 subset)

- Company Admin (full).
- Inspector (assigned-property scope; raises flags; submits inspections).
- Other roles defined in schema but not exercised in v1.0 UI.

### v1.0 acceptance criteria

The v1.0 stage is done when **all** of the following pass on a real iPhone in a real Durban apartment:

1. A Company Admin can create a property and assign an inspector.
2. The inspector can sign in and see only assigned properties.
3. The inspector can complete a **pre-arrival** inspection of 30 line items with 15 photos in under 12 minutes.
4. The inspector can complete a **post-stay** inspection on the same property, linked to the same stay.
5. The inspection can be started offline (airplane mode), continued offline, and submitted when reconnected — without losing data or photos.
6. The inspector can raise at least 3 different types of flag (e.g., maintenance issue, inventory missing, condition note) on the same inspection.
7. After submit, the Company Admin can view the inspection report in HTML.
8. The Apartment Action Centre shows the property as "Needs attention" with the correct open-flag count.
9. A second Company Admin in a different test company cannot see this company's data (cross-tenant test).
10. The audit trail shows submit, photo upload, and flag-raise events with actor and timestamp.
11. Every photo on disk has a `retention_class` value set.
12. The `approval_policies` table contains the Dropinn-default row for this company.

---

## v1.1 — Maintenance loop + Guest recovery loop (detailed scope)

### Issues

- Create an issue from a flag (typed "maintenance issue" or "safety/urgent").
- Or create a standalone issue.
- Issue fields: title, description, property, priority (low/med/high), status, source flag (optional), source inspection (optional), assignee (optional), photos.
- Issue statuses: Open → In Progress → Resolved → Verified.

### Maintenance jobs

- A maintenance job is an issue that has been assigned and tracked.
- Maintenance assignee (technician).
- Estimated cost, actual cost.
- Before photos (from inspection), after photos (captured by tech).
- Status transitions logged to audit.

### Guest damage recovery (new in v1.1)

- A flag of type "guest damage" on a post-stay inspection auto-creates a `guest_recovery_tasks` row.
- Default deadline: checkout + 24 hours.
- Manager can send a copy-paste message via picked template (variables auto-filled).
- Manager records the response with screenshot evidence.
- State machine: new → guest_notified → guest_resolved | ota_attempted → ota_resolved | fallback_decision → closed (with `final_chargeable_party` set).
- See `GUEST_DAMAGE_RECOVERY_WORKFLOW.md` for full detail.

### Cost recovery cascade (new fields in v1.1)

- `accountability_records` extended with cascade tracking — see `INVENTORY_AND_MAINTENANCE_LOGIC.md`.
- Every accountability record's final `chargeable_party` reflects who actually paid after the cascade resolved.
- No silent leakage — every record is closed with an explicit outcome.

### Action Centre additions in v1.1

- "Today's recovery deadlines" widget (red/orange/amber colour coding).
- Open work section now also shows in-progress maintenance jobs.

### Roles added at v1.1

- Maintenance Coordinator.
- Maintenance Technician.

### v1.1 acceptance criteria

1. Manager can convert a flagged inspection item to an issue in one tap.
2. Coordinator can create a maintenance job, assign a tech, set estimated cost.
3. Tech sees only their assigned jobs on their phone.
4. Tech cannot mark a job `done` without at least one "after" photo.
5. Manager can verify a `done` job; tech cannot self-verify.
6. A "guest damage" flag auto-creates a `guest_recovery_tasks` row with the right deadline.
7. Manager can pick a message template, see variables filled, and copy to clipboard.
8. Manager can record a response with an outcome and screenshot evidence.
9. The recovery task can move through the full state machine to closed with a final_chargeable_party set.
10. Every state change writes an audit event.
11. The Action Centre's "Today's recovery deadlines" widget correctly shows colour-coded tasks.

---

## v1.2 — Accountability + Policy enforcement loop (detailed scope)

### Inventory items

- Per-property catalogue of expected items.
- Fields: name, expected quantity, unit, is_active, category (optional, used for category-cap matching).

### Inventory movements

- Recorded movements: missing / damaged / restocked / returned / replaced.
- Linked to inspection items where relevant.
- Linked to source flag where relevant.
- Photos attach via `photos.inventory_movement_id`.

### Accountability records

- Link a movement (or issue, or inspection item, or recovery task) to a chargeable party.
- `chargeable_party`: none / guest / owner / company / contractor.
- **Approval policy enforcement** is now live:
  - Single-item cap, monthly cap, annual cap, category cap all checked.
  - Charges over `internal_ceiling` enter `pending_owner_approval` automatically.
  - Manager picks owner-message template, copies, sends manually.
  - Records owner response with screenshot.
  - Approval finalises only after owner sign-off.
- Photos mandatory for any non-zero chargeable record.
- Approval, unapproval, edits all write audit events.
- See `APPROVAL_LIMITS_AND_CONTRACT_RULES.md`.

### Policy editing UI (v1.2)

- Company Admin can edit company-level caps.
- GM can add owner-level overrides.
- GM can add property-level overrides.
- Policy changes are date-versioned and audited.

### Action Centre additions in v1.2

- "Pending approvals" section per property + portfolio summary.
- This-month owner spend bar (green/amber/red) per property.
- "Awaiting owner — N days" surfaces for pending-owner-approval items aged >7 days.

### Roles added at v1.2

- Inventory Manager.
- Operations Manager (approval gate; can record owner responses).

### v1.2 acceptance criteria

1. Inspector can flag a missing item with a photo during inspection (already in v1.0).
2. Manager can create an accountability record linked to the movement.
3. Approval cannot complete without a linked photo.
4. A charge above the single-item cap correctly enters `pending_owner_approval` instead of being silently approved.
5. The system generates a copy-paste owner-approval message with the right variables filled in.
6. Manager records owner approval with a screenshot.
7. The monthly cap is correctly computed from approved-this-month totals; a new charge that would breach it is escalated.
8. The annual cap is correctly computed from a rolling 12-month window.
9. The audit trail shows the full approval chain (raise → policy hit → owner asked → owner approved → final approval).
10. Approved owner records are visible in the relevant property's history.
11. Action Centre this-month spend bars match the underlying totals.

---

## v1.3 — Owner communication + audit loop (detailed scope)

### Inspection template editor

- Company Admin can create / edit / archive templates.
- Pre-arrival, post-stay, monthly, and **annual audit** templates seeded.
- Drafts use the template snapshot taken at start (template edits don't rewrite history).

### Weekly owner status updates (new in v1.3)

- One per (company, property, week).
- Manager generates from structured data (open issues, resolved this week, upcoming maintenance, pending owner approvals, notable inspection findings, manual occupancy note).
- Status workflow: `draft` → `sent`.
- Configurable per-property: on/off, day of week.
- See `OWNER_COMMUNICATION_WORKFLOWS.md`.

### Owner monthly summary

- One per (company, property, calendar month).
- Built from approved accountability records (chargeable_party = owner) + completed chargeable maintenance + chargeable inspection items.
- Status workflow: `draft` (manager edits) → `sent` (visible to Owner Viewer).
- HTML only in v1.3 — presentation quality per `REPORTING_REQUIREMENTS.md`.

### Owner Viewer dashboard (new in v1.3)

- Owner logs in, sees only their property/properties.
- Latest weekly update + latest monthly summary + pending approvals + last-30-days photo gallery (evidence class only — not routine photos).
- Cannot see other properties, staff names, audit log, routine inspection photos.

### Roles added at v1.3

- Property Owner Viewer.
- Property Manager (broader than Inspector, narrower than Ops Manager).

### Photo retention enforcement (optional — may push to v1.5)

- The job that snapshots routine inspections and purges raw photos after 90 days runs in v1.3 if time permits; pushes to v1.5 otherwise. The `retention_class` field is already on every photo from v1.0, so this is a non-breaking add.

### Basic dashboards

- "Today's inspections" list.
- "Open issues" list.
- "Recent activity" timeline.
- Property readiness view (status per property).
- Pending owner approvals across portfolio.

### v1.3 acceptance criteria

1. Manager can generate a weekly status update for any property from the past 7 days of real data.
2. Manager can generate a monthly summary for any property from real submitted data.
3. Re-generating either is idempotent (no duplicate lines).
4. Manager can exclude individual lines with a reason (audited).
5. After "Send", the document is visible to the Owner Viewer for that property only.
6. Owner Viewer cannot see other properties.
7. Once `sent`, the document is immutable.
8. The rendered HTML prints to a single tidy PDF via the browser's Print → Save as PDF (proof that v1.5 native PDF is straightforward).
9. The annual audit template is available and can be used for a real annual inspection.
10. Owner Viewer's photo gallery excludes routine pre-arrival and routine post-stay photos by default.

---

## Overall MVP acceptance criteria (end of v1.3)

The MVP is considered done when **all** of the following are true on real devices:

1. The founder's own STR operation has run for at least 30 consecutive days on the product.
2. An inspector can complete a 30-line-item inspection (pre-arrival or post-stay) with 15 photos on an iPhone in under 12 minutes.
3. An inspection started offline can be completed and submitted offline, and syncs reliably when connectivity returns.
4. No company can see another company's data (verified by deliberate testing as a different user).
5. A General Manager can see all inspections, issues, properties, flags, and pending approvals for their company via the Apartment Action Centre.
6. A Property Owner Viewer can see only their own properties' inspections, weekly updates, and monthly summaries.
7. A weekly owner status update can be produced from real submitted data and sent to the owner.
8. A monthly owner summary can be produced from real submitted data and sent to the owner.
9. At least one guest damage recovery task has been completed end-to-end, including a successful copy-paste WhatsApp/email send and recorded response.
10. At least one charge above an approval cap has been routed through `pending_owner_approval`, with the owner's response recorded and the charge finalised.
11. Every status change on a chargeable item is recorded in the audit trail.
12. The app loads and is usable on iPhone Safari, Android Chrome, Mac/Windows desktop browsers.
13. The founder, with Claude's help, can deploy a fix and roll it back without help from a developer.

---

## v1.5 (the polish-and-extend release)

Ship after v1.3 is stable in real use.

- PDF export for inspection reports, weekly updates, and owner monthly summaries.
- Native WhatsApp share links (signed time-limited URLs) for owner updates and guest messaging.
- Email notifications when a new owner-facing document is ready (transactional email via Resend).
- Recurring inspection scheduling (e.g., "monthly inspection every 1st of month").
- GM performance dashboard: inspection completion rates, average time per inspection, photo counts, issue resolution time.
- Maintenance SLA tracking (due date, breach flag) per `FLAG_AND_ACTION_MODEL.md` SLA defaults.
- Better conflict resolution UI for offline edits.
- Cleaner / Housekeeping role with simplified UI; cleaning task entity wired up.
- Multiple photo views per issue (timeline, gallery).
- Improved search across properties, inspections, issues.
- CSV exports for all major reports.
- Photo retention snapshot-then-delete job (if not in v1.3).
- Hot/cold storage separation (optionally R2 migration if cost demands).
- Per-company configurable approval policy templates ("South Africa STR default", etc.).
- Per-company configurable flag taxonomy extensions.

---

## Later phases (post-v1.5)

- OTA evidence pack export (specifically structured for Airbnb / Booking.com disputes). Note: the underlying data model is in place from v1.0; only the export presentation ships later.
- Hostaway integration (pull property list, sync stay dates → auto-fill `stays` table).
- WhatsApp Business API integration (send report links automatically, two-way replies).
- Asana / Slack integrations for issue notifications (**outbound only** — the app remains the source of truth).
- Multi-company membership (one user works for multiple PMCs).
- AI features (see `AI_FEATURE_ROADMAP.md`):
  - Inspection summary drafting.
  - Issue severity suggestion.
  - Maintenance category suggestion.
  - Flag type suggestion from photo (vision-assisted).
- Native mobile app (React Native / Expo) — only if PWA proves insufficient.
- Multi-language UI (Zulu, Afrikaans, Portuguese, French, Spanish, etc. depending on customer base).
- Predictive maintenance signals from recurring issues.
- Advanced portfolio analytics.

---

## Out of scope for MVP (explicit non-goals)

- Building our own channel manager.
- Calendar sync with Airbnb / Booking.com.
- Guest messaging API integration (copy-paste only in MVP).
- Pricing optimisation.
- Cleaning marketplace.
- Cleaning fee invoicing.
- Tax handling.
- Payroll.
- Bank reconciliation.
- AI-driven blame, billing, or dispute decisions.
- A separate desktop-only app.
- Native iOS / Android apps in v1.
- Real-time push notifications.
- Owner self-service approval app (owners reply via existing channels; manager records the response).
