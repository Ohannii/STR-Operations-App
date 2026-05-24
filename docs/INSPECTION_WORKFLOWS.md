# INSPECTION_WORKFLOWS.md

## Inspection types (MVP)

> **The Turnover inspection (combined post-stay + pre-arrival in one visit) is the primary, highest-frequency flow.** Full detail in `TURNOVER_INSPECTION_WORKFLOW.md`. The split pre-arrival-only / post-stay-only types below exist for edge cases (apartment was vacant, or the two halves genuinely happen on different days).

| Kind                       | When it runs                                                  | Who runs it           | Photo emphasis             | Ships in |
| -------------------------- | ------------------------------------------------------------- | --------------------- | -------------------------- | -------- |
| **Turnover (combined)**    | Between guests — post-stay check of the departing guest **and** pre-arrival proof for the next guest, in one visit (~300/month, the dominant flow) | Inspector / Cleaner | Damage deltas, inventory, cleanliness, readiness, baseline proof | **v1.0** |
| Pre-arrival only           | Before a guest arrival when no post-stay is needed (apartment was vacant) | Inspector / Cleaner   | Setup state, inventory baseline, condition baseline | **v1.0** |
| Post-stay only             | After a checkout when pre-arrival is done separately (rare)    | Inspector             | Damage, missing inventory, deltas vs pre-arrival    | **v1.0** |
| Monthly                    | Periodic full audit                                            | Property Manager      | Wear, deep-clean items     | v1.3 (template seeded) |
| **Annual audit**           | Once per year per property (~50/year)                          | Property Manager / Ops Manager | Full baseline refresh; long-retention evidence | **schema v1.0 / UI v1.3** |
| Maintenance follow-up      | After a maintenance job is done                               | Inspector / Tech      | After photos               | v1.1 (via maintenance verify) |
| Custom                     | Company-defined                                                | Anyone with rights    | Defined per template       | v1.3 (template editor) |

### Why pre-arrival is in v1.0 (and not deferred to v1.3 as originally planned)

The operational logic test (see `OPERATIONS_LOGIC_TEST.md`) reset this. Pre-arrival is the **highest-volume use case in the operation** (~300/month vs ~30 post-stay damage incidents/month for the first customer). It is also the *only* way to prove inventory and condition existed before a guest arrival, which is the foundation of every guest recovery claim. A product that ships without pre-arrival in v1.0 cannot prove its evidence value.

Pre-arrival and post-stay share 95% of the same code (templates, line items, photos, flags, offline drafts). Shipping them together costs little more than shipping post-stay alone.

### Why annual audit ships as a seeded template in v1.3

Annual audits are infrequent (~50/year) but heavy-photo events that produce long-retention evidence. They use the standard inspection mechanics — the only difference is the template content (more thorough than a routine pre-arrival) and the photo retention class (`annual_audit_evidence`, kept 7 years). Adding the template is cheap; building a separate workflow for it would have been wasteful.

### Pairing a pre-arrival with its post-stay (the `stay` link)

Every guest visit produces a **pair**: one pre-arrival and (ideally) one post-stay inspection for the same property and same stay window. The `stays` entity links them.

- A pre-arrival inspection optionally creates or attaches to a `stays` row when started.
- The matching post-stay inspection attaches to the same `stays` row.
- The Property view in the Action Centre shows pre-arrival + post-stay side by side once both exist.
- Comparing line-by-line between paired inspections is a v1.5 enhancement; for v1.0 the link is structural (in the data) but the comparison UI is not built.

Why this matters: when a guest dispute happens 14 days after checkout, the OTA wants to see "what did this apartment look like before this guest arrived?" — that's the pre-arrival inspection for the linked stay. Without the link, finding the right pre-arrival means hunting through inspection history.

## Workflow principles

- **Mobile-first.** The inspection screen is designed for a phone held in one hand.
- **One section at a time.** No giant scrolling page.
- **Photos required only where it matters.** Don't make staff take 200 photos per inspection.
- **Notes are optional unless flagged required.** Free text slows people down.
- **Auto-save drafts** every time an item is changed (debounced ~500ms).
- **Offline-safe** — the entire workflow must work with no internet.
- **Progress always visible** — "Section 3 of 7", percentage, items remaining.
- **Sync state always visible** — clearly different from progress.
- **Final review screen** before submission, with a summary of red-flag items.
- **Submission writes an audit event** with `inspection.submitted`.

### Speed mechanics (so a busy turnover stays fast)

These are the features that turn a 30-minute generic inspection into a 10-minute apartment-specific one. Full spec in `TEMPLATE_AND_INVENTORY_MODEL.md`.

- **Section-level "Mark all OK".** One tap sets every non-flagged, non-mandatory item in a section to OK. Confirmation shows "Marked N OK; M still need individual check." Bulk-OK is recorded in audit (`bulk_ok_at`, `bulk_ok_by`) so indiscriminate bulk-OK can be spotted.
- **Mandatory one-by-one checks.** Items with `mandatory_individual = true` (all safety + all appliances by default) cannot be bulk-OK'd. The Mark-All-OK button is disabled for a section until those are addressed individually.
- **Issue-only photos and notes.** Photo and note requirements default to `if_flagged` — capture is required only when the inspector flags a problem, never for OK items.
- **Record-only observations.** "Add observation" (distinct from "Add flag") records a `condition_note` / `no_action_record` flag set straight to `no_action`. It appears in apartment history but **never** in the Action Centre open queue. It can be promoted to an active flag later (audited).
- **Per-apartment inventory.** The inventory section auto-populates from the property's `inventory_items`, so each apartment is checked against its own real list, not a generic one.
- **One-off audit items.** An inspector/manager can add a single extra check inside an in-progress inspection without editing the template.

### Capture mechanics

- **Evidence Camera Mode** is the photo capture pattern: open camera once, take many photos in a row, photo strip preview, quick delete, attach all at once. Optional notes (per photo / selected photos / whole proof set) added after capture. Full spec in `EVIDENCE_CAMERA_AND_PHOTO_NOTES.md`.
- Photos auto-attach to the line item / section / inspection they were opened from — no per-photo tagging admin.

### Flag discipline (so the Action Centre stays clean)

- A flag is the **parent record** for a problem. Converting it to an issue / job / movement / recovery / accountability creates a **child** linked by `parent_flag_id`. The Action Centre shows **one card per problem**, not one per child. See `DEDUPLICATION_AND_TASK_GROUPING_RULES.md`.
- The inspector raises and (lightly) types flags; the **manager triages** classification, conversion, and any money/chargeability decision. Inspectors never see cost fields.

---

## State machine: inspection

```
                   ┌──────────────────────────────────────────────────┐
                   ▼                                                  │
   [created] ─► [draft] ─► [submitted] ─► [reviewed] ─► [archived]    │
                  ▲             │                                     │
                  └─────────────┘  (reopen — Ops Mgr or higher; 🔑)   │
                                                                      │
   any state above can be soft-deleted (deleted_at set) by Admin/GM ──┘
```

States and what they mean:

- **draft** — being filled in by an inspector. Can be edited freely by the owner of the draft. Auto-saved.
- **submitted** — the inspector has confirmed the inspection is complete. Photos must all be uploaded (or queued) before submit succeeds.
- **reviewed** — a manager has reviewed and acknowledged the inspection. Owner-chargeable approvals happen at or before this point.
- **archived** — the inspection is older than ~90 days (configurable later) and moved out of the active list, still queryable.

Reopen rules:
- Going from **submitted → draft** requires an Ops Manager or higher and writes an audit event.
- Once **reviewed**, only Company Admin can reopen (also audited).

---

## Inspector flow (happy path, mobile)

1. **Open the app** — already logged in, lands on "My day".
2. **Pick a property** — list shows assigned properties first, sorted by next-due inspection.
3. **Pick a template** — Turnover (default) / Pre-arrival / Post-stay / Monthly / Custom.
4. **Tap "Start inspection"** — a new draft is created (server if online, local-only if offline). From this point, **every flag raised inside the inspection automatically inherits this property + inspection + stay context** — the inspector is never asked to pick the apartment again (prototype finding #1).
5. **Section screen** — title at top, list of line items, big "Next section" button at the bottom.
6. **For each item:**
   - Tap a status pill (OK / Damaged / Missing / Attention).
   - If `required_photo`, the "Add photo" button is highlighted and submit is blocked until at least one photo is attached.
   - If `required_note`, the note field shows a "Required" marker.
   - Photos compress in the background; a small spinner indicates queueing.
7. **Raising a flag mid-inspection (guided flag workflow):**
   - Tap "Flag a problem" on a line item (or the section's general "Add flag").
   - Confirm or change the pre-selected flag type.
   - For damage/maintenance types, **the note is captured during the guided flow, before the flag is saved** (prototype finding #7) — and a photo is prompted per the item/flag-type rules.
   - Optionally pick "action needed" options (multi-select; optional — see `FLAG_AND_ACTION_MODEL.md`). An inspector who doesn't know what's needed picks nothing; a manager triages later.
   - Tap **"Save flag."**
8. **Saving a flag does NOT submit the inspection (prototype finding #2).** The inspection stays in `draft` / in-progress. Saving a flag only writes the flag; it never advances the inspection's state.
9. **After saving a flag, the inspector sees clear next actions (prototype finding #3):**
   - **Continue inspection** (returns to where they were — the default, biggest button)
   - **Go to Apartment Action Centre** (for this property)
   - **Review saved flag** (opens the flag just created)
10. **Continue any time.** An in-progress inspection can always be resumed until it is explicitly submitted (prototype finding #4). Closing the app, taking a call, going offline — the draft persists and reopens where it was left.
11. **Move through sections** until "Finish" appears.
12. **Final review screen (prototype finding #12):**
   - Completion summary: total items, OK / Damaged / Missing / Attention, flags raised, photos attached, photos pending upload.
   - Any item with a problem is listed with a thumbnail; tap to jump back and fix.
   - The "ready for next guest?" question (turnover/pre-arrival).
   - A clear, single **"Submit Inspection"** button.
13. **Submit** — only this button moves the inspection to `submitted`. If required photos/notes are present, state advances and an audit event is written.
14. **Confirmation screen** — "Inspection submitted. X items will continue syncing in the background." Clear sync banner. The inspector is routed to the property's Apartment Action Centre.
   - For **turnover and pre-arrival inspections**, the confirmation screen also surfaces a **"Generate Evidence Pack"** button (prototype finding #13). One tap assembles the timestamped baseline photos into a shareable pre-arrival evidence pack — the proof of apartment condition before the next guest arrives. Full spec in `EVIDENCE_CAMERA_AND_PHOTO_NOTES.md` and `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`.

---

## Manager review flow

1. Manager opens "Inspections" list, filtered to `submitted` and assigned properties (or all, for Ops/GM).
2. Taps an inspection → sees the inspection summary, section-by-section, with photos.
3. Items flagged `damaged`, `missing`, or `attention` can be:
   - Turned into an **issue** (one tap; pre-fills title, property, photos).
   - Marked **owner-chargeable** (with approval = manager's user id; audited).
4. Tap **"Mark reviewed"** → state moves to `reviewed`, audit event written.

---

## Inspection history (prototype findings #5, #6)

Inspection history is browsable per property and distinguishes four states clearly:

- **In progress** (draft) — started, not yet submitted. Resumable.
- **Submitted** — inspector finished; awaiting manager review.
- **Reviewed** — a manager has acknowledged it.
- **Closed** — fully done, including any child actions resolved (a derived/displayed state; see note below).

Opening any historical inspection by date shows the complete record:

- All checklist items with their OK / Damaged / Missing / Attention status.
- Notes per item.
- All flags raised, grouped under their parent (never duplicated).
- Evidence photos with timestamps and any notes.
- Child actions linked to each flag (maintenance, Asana, guest notification, owner charge, review) with their current status.
- Submit / review status and the relevant timestamps (started, submitted, reviewed).
- The inspector who performed it (and reviewer, if reviewed).

Implementation note: `inspections.status` in the schema is `draft | submitted | reviewed`. "In progress" is the display label for `draft`. "Closed" is a **display state** derived from "reviewed AND all linked flags/child actions resolved" — it is not a separate stored status in v1.0 (avoids a redundant column). If real use shows a need for an explicit stored `closed`, it's a one-line schema addition later; flagged in `KNOWN_ISSUES.md`.

---

## Offline behaviour

- Drafts are stored in IndexedDB with a local `client_uuid`.
- On submit, the app posts the draft to the server. If offline, the post is **queued** in a local outbox and retried.
- Photos always have two states: `local` and `synced`. The UI shows both.
- The sync banner shows:
  - Total items queued (drafts + photos)
  - "Syncing now" / "Waiting for connection"
  - A tap-to-expand list of what's pending
- **Conflict rule (MVP):** if a draft already exists on the server with the same `client_uuid`, the server keeps the most recent version by `updated_at`. We **never** silently overwrite a `submitted` inspection with a `draft`. Instead the app shows a conflict screen and asks the user to choose.

---

## Validation rules at submit time

- All `required_photo` items have at least one photo attached.
- All `required_note` items have a non-empty note.
- The inspection has at least one section completed (no empty submissions).
- All photos are either `synced` or `queued` (queued is fine — the submit completes once they upload).

If any validation fails, the inspector sees a clear, actionable message: *"3 required photos missing. Tap to jump."*

---

## Edge cases and how we handle them

| Case                                                            | Behaviour                                                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Inspector closes the app mid-inspection                         | Draft is auto-saved. Reopens exactly where they left off.                                          |
| Phone runs out of battery                                       | Same. Last debounced save is persisted in IndexedDB.                                               |
| Two inspectors start a "Pre-arrival" for the same property      | Two separate drafts exist. Manager sees both and can decide which to keep.                         |
| Inspector edits a submitted inspection                          | Not allowed in MVP. Must request a reopen (Ops Mgr 🔑).                                            |
| Template is edited while a draft is in progress                 | Drafts use the snapshot taken at start. Existing drafts are unaffected.                            |
| Photo upload fails after retries                                | The photo stays `queued` with a `failed` substate; user is alerted; they can retry or remove.      |
| Inspector takes a photo of the wrong item                       | They can remove it before submit. After submit, only Manager+ can remove (with audit).             |
| Inspector loses signal entirely all day                         | Everything works offline. On reconnect, all drafts and photos sync in order.                       |
| The property no longer exists when the draft is finally synced  | The submit fails with a clear "Property archived" error. The inspector can transfer to a new prop. |

---

## What we are NOT doing in MVP

- Voice-to-text inspection notes.
- Barcode / QR scanning of inventory.
- Geolocation stamping (privacy-sensitive; deferred to v1.5+ with explicit consent).
- Auto-detecting damage from photos with AI.
- Inspector scoring / gamification.
- Comparing this inspection's photos with previous inspections' photos automatically (manual side-by-side is fine for MVP).
