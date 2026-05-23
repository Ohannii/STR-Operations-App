# EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md

## Plain-English overview

Two distinct staff pains feed this document:

1. *"Evidence loading to Asana is slow and painful."*
2. *"When guests dispute damages, it takes too long to scroll through WhatsApp to find photo proof."*

The fix is one idea, not two:

> Every photo already lives in the app, already tagged with property, inspection, flag, stay, timestamp, retention class, and inspector. Searching for evidence later is just **a filter over the photos table**. We do not build a separate "Evidence Vault" module. We build search and filtering, and we call any list of returned photos "the Evidence Vault" or "the Evidence Drawer" depending on context.

This document defines the search/filter views, the WhatsApp-ready notification flow, and the discipline that keeps it from becoming three parallel surfaces.

---

## What it is NOT

To be explicit, because this is exactly the failure mode the founder named:

- **It is not a separate "Evidence Vault" module with its own database.** It's a query over the existing `photos` table.
- **It is not a "Photo Gallery" feature alongside an "Evidence Drawer" feature alongside a "Vault" feature.** Those are different names for the same view at different zoom levels.
- **It is not a parallel place where evidence must be re-uploaded or re-organised.** Evidence is captured once at the source (inspection / flag / guest recovery task) and surfaces everywhere it's relevant.

If at any point a developer or designer proposes "let's also add an Evidence Vault upload screen" — push back. The upload screen is the Evidence Camera (`EVIDENCE_CAMERA_AND_PHOTO_NOTES.md`). The Vault is read-only retrieval.

---

## The data foundation (already in place)

Every photo row in the `photos` table already carries enough metadata to be findable later:

- `company_id`, `property_id`, `stay_id`, `inspection_id`, `inspection_item_id`, `flag_id`, `issue_id`, `maintenance_job_id`, `inventory_movement_id`, `guest_recovery_task_id`
- `entity_type` — what the photo primarily belongs to
- `retention_class` — the policy class
- `captured_at`, `uploaded_at`, `uploaded_by`
- `notes` (optional)
- `storage_path`, `thumbnail_path`

This means **every search the staff have ever wanted to do is just a `WHERE` clause**:

| User question | Query |
|---|---|
| "Show me all photos from Apartment 4B" | `WHERE property_id = ?` |
| "Show me photos from this guest's stay" | `WHERE stay_id = ?` |
| "Show me pre-arrival proof for this stay" | `WHERE stay_id = ? AND retention_class = 'routine_pre_arrival'` |
| "Show me the post-stay damage photos" | `WHERE stay_id = ? AND flag_id IS NOT NULL` |
| "Show me all evidence for this guest dispute" | `WHERE guest_recovery_task_id = ?` |
| "Show me all photos taken between 9 May and 12 May" | `WHERE captured_at BETWEEN ? AND ?` |
| "Show me all photos by Sipho (an inspector)" | `WHERE uploaded_by = ?` |

No new tables. No new modules. Just search.

---

## The Evidence Vault (the global search view)

Accessed via a search icon in the Action Centre header. One screen. One search bar. Filters down the side.

**Filters available:**

- Property (multi-select)
- Stay (when a property is selected; resolves to a date range)
- Inspection (when a stay is selected; pre-arrival / post-stay / annual audit)
- Flag (when a property is selected)
- Date range (free)
- Retention class (routine / dispute / chargeable / annual audit / maintenance / inventory)
- Inspector
- Has notes / no notes
- Has flag attached / no flag

**Default view (no filters set):**

Shows the last 30 days of `dispute_evidence` + `owner_chargeable_evidence` photos (the ones most often needed for retrieval), grouped by parent flag. Routine pre-arrival is hidden by default to prevent the view from drowning in baseline noise.

**Selection actions:**

A user can select one or many photos and:

- Open a single photo full-screen with all its metadata (timestamp, inspector, property, linked flag).
- Tap "Add to evidence pack" → starts assembling a copy-ready bundle.
- Tap "Open WhatsApp with these" → see WhatsApp workflow below.
- Tap "Download all" → ZIP of selected photos (v1.5).

The Vault is **read-mostly**. The only write actions are: add a note retroactively to a photo (audited), and promote a photo's retention class (one-way; never demote — see `PHOTO_RETENTION_POLICY.md`).

---

## The Evidence Drawer (the in-context view)

Inside a flag card, inside an inspection, inside a guest recovery task — there's a small "Photos" drawer that pulls the same data but pre-filtered.

It's the same underlying query (`WHERE flag_id = current_flag.id` or `WHERE inspection_id = current_inspection.id`); only the framing differs:

- On a **flag card**: "Photos for this problem" — all photos with `flag_id = current_flag.id` OR linked through children (issue / maintenance / recovery / accountability).
- On an **inspection**: "Photos in this inspection" — all photos with `inspection_id = current_inspection.id`.
- On a **guest recovery task**: "Evidence for this recovery" — photos with `guest_recovery_task_id = current_task.id` PLUS photos from the source flag (so the team sees the original damage photos AND the recovery message screenshots in one place).

Each drawer offers the same selection actions as the Vault: open, add to pack, send to WhatsApp, download.

---

## Pre-arrival proof retrieval (the most common search)

This is the dispute-defence use case. A guest claims they didn't damage something. The team needs to prove the apartment was clean and intact before arrival.

**Path:**

1. From the Apartment Action Centre, open the property's Property view.
2. Tap "Stay history" or scroll to the relevant stay.
3. Tap the stay → see its linked pre-arrival inspection.
4. Tap "Evidence" on that inspection → a drawer opens showing all pre-arrival photos for that stay.
5. Select the relevant ones → "Add to evidence pack" or "Open WhatsApp."

Time-to-find: under 30 seconds for someone familiar with the app. **Compared to scrolling WhatsApp for 10 minutes per dispute, this is the largest single time saving in the product.**

---

## Post-stay damage proof retrieval

**Path:**

1. From the flag card on the Action Centre (the parent flag for the damage).
2. The Evidence Drawer is already open inside the card.
3. All the damage photos taken at the post-stay inspection are right there.
4. Pre-arrival proof for the same stay is one tap away (the card shows "Pre-arrival evidence for this stay →").

Time-to-find: zero. The evidence is on the screen the manager is already looking at.

---

## Preparing an evidence pack

An evidence pack is a manager-curated bundle of photos + notes + flag context, ready to share via WhatsApp / email / OTA portal.

**Build:**

1. From any drawer or the Vault, select the relevant photos (multi-select).
2. Tap "Add to evidence pack."
3. The pack accumulates in a small floating tray (like a shopping cart).
4. Continue adding from other sources (e.g., add the pre-arrival photo, then add the post-stay damage photo, then add the WhatsApp screenshot of the guest's denial).
5. Tap the tray → see the assembled pack.
6. Optional: re-order, drop, add a covering note.
7. Pick output: "Copy as WhatsApp message" (text + image URLs), "Download as ZIP," "Open in OTA template" (Airbnb / Booking.com — uses the message templates from `GUEST_DAMAGE_RECOVERY_WORKFLOW.md`).

Evidence packs are **ephemeral by default** — they live in the user's session, not in the database. A "Save as snapshot" option (v1.5) preserves the pack as a `report_exports` row for legal use.

---

## WhatsApp-ready guest notification (the same-day flow)

The pain: *"Guest damage notification is slow because staff currently go between Asana, screenshots, evidence, and WhatsApp."*

The fix: the entire flow happens from the flag card. Nothing leaves the flag card except the actual sending action.

**Flow:**

1. Manager opens the flag card on the Action Centre (one tap from the home screen).
2. Card shows: photos already there, recovery task already there, message template already pre-filled with variables (guest name, property, item, estimated amount).
3. Manager taps **"Notify guest."**
4. A modal slides up with three things stacked:
   - The pre-filled message text (editable).
   - A photo strip showing the photos already attached to the flag, each pre-selected for inclusion.
   - Three buttons: **"Copy message"** • **"Open WhatsApp"** • **"Open Email"**.
5. Manager taps **"Open WhatsApp"** → deep-link to `https://wa.me/<guest_phone>?text=<encoded_message>`. The photos are not yet attached in WhatsApp because WhatsApp's URL scheme doesn't carry images — but the message includes a signed link to a web-rendered "evidence page" the guest opens (v1.5) OR the manager attaches the photos in WhatsApp from their device's gallery (v1.0–v1.3, manual but quick because the photos are also auto-saved to the device's gallery via Share Sheet — see below).
6. After sending, manager returns to the app, taps **"Mark sent."**
7. A second modal: "Attach proof that you sent it." Manager screenshots the WhatsApp conversation and uploads. The screenshot is captured as a photo with `guest_recovery_task_id = current_task.id`, `entity_type = 'recovery_message_proof'`, `retention_class = 'dispute_evidence'`. Audit row written.
8. The recovery task transitions to `guest_notified`. The flag card updates. Deadline timer starts visibly counting down.

**No leaving the flag card.** No Asana. No scrolling through WhatsApp later because the proof is back in the app.

### Why a signed evidence link is a v1.5 enhancement, not v1.0

v1.5 will generate a one-shot signed URL like `https://app.example.com/e/<token>` that renders the evidence page when the guest taps it: photos, captions, contact info, the manager's name. This is the cleanest version.

In v1.0–v1.3 we ship the simpler version: the manager copies the message, opens WhatsApp, attaches the photos manually from the device gallery (where the app has copied them via the Share Sheet API). It works, it's quick, and it doesn't require a public-facing rendering route to ship for v1.0.

---

## Copy message / Open WhatsApp / Mark as sent

Three buttons. One job. From the flag card or from the recovery task's drawer:

| Button | What it does |
|---|---|
| **Copy message** | Copies the rendered text to clipboard. Manager can paste anywhere. Logged: `attempt_method = 'manual_copy'`. |
| **Open WhatsApp** | Deep-links to `wa.me/<phone>?text=<encoded>` if guest phone is on the stay. If not on the stay, opens WhatsApp with text only and the manager pastes a phone number. Logged: `attempt_method = 'whatsapp_deeplink'`. |
| **Mark as sent** | Prompts for a screenshot of the sent message (optional but strongly nudged). Writes a `recovery_attempts` row with `message_sent_at = now()` and the screenshot path. |

All three are non-blocking — the manager can use one, two, or all three depending on context.

---

## Screenshot / proof of sent message

Capturing the screenshot is the bridge that turns "I sent it on WhatsApp" into "here is auditable proof I sent it on WhatsApp."

The screenshot is:

- Captured as a photo via the standard photo upload flow (so it benefits from sync, compression, retention).
- Linked: `guest_recovery_task_id`, `entity_type = 'recovery_message_proof'`, `retention_class = 'dispute_evidence'`.
- Surfaced in the recovery task's drawer alongside the original damage photos.
- Visible in any later OTA evidence pack.
- Visible to the auditor role.

If the guest later denies receiving the message, the screenshot is the answer. The team never has to scroll WhatsApp again.

---

## Searchable evidence — the queries staff care about

The Vault search must support these by-feel queries with the right filter combination:

| Staff intent | Filters |
|---|---|
| "I need pre-arrival proof for apartment 4B for last week's guest" | Property + stay (or date range) + retention class = routine_pre_arrival |
| "I need every photo of the cracked TV in the kitchen" | Flag = the TV flag |
| "I need all the dispute evidence we have on this guest" | Stay (or guest name search → resolves to stay) + retention class = dispute_evidence |
| "Show me everything I (Sipho) photographed last Tuesday" | Inspector + date range |
| "Give me a year of annual audit photos for owner reporting" | Property + retention class = annual_audit_evidence + date range |
| "Show me all photos for an OTA claim on stay 12345" | Stay = 12345 + flag is not null |

These all work with one filter screen, one query.

---

## How photos appear in reports

Photos in reports are also just queries over the same table.

- Inspection report: `WHERE inspection_id = ?` — appears with line items.
- Owner monthly summary: `WHERE parent_flag.linked_accountability.chargeable_party = 'owner' AND month = ?` — appears with charge lines.
- OTA evidence pack (v1.5+): `WHERE guest_recovery_task_id = ?` — appears with the cover narrative.
- Weekly owner update: top 6 `dispute_evidence` or `owner_chargeable_evidence` photos for the week.

Every report uses the same photo table. No "snapshot for the report" duplicate storage.

(See `REPORTING_REQUIREMENTS.md` for full report specs.)

---

## Hide empty checklist items in cleaner reports

A pre-arrival inspection of a 50-item template where 47 items are "OK" produces a report with 50 rows. The 47 OKs are noise; the manager (and owner) wants to see the 3 issues clearly.

**Reports have a "Hide OK items" toggle** that suppresses any line item with `status = 'OK'` and no flags. The header still shows "47 of 50 items OK; 3 needing attention" so nothing is silently hidden.

The toggle is on by default for owner-facing reports and off by default for internal audit reports. Configurable per export.

---

## Photo timestamps in reports

Every photo in every report shows its `captured_at` timestamp underneath. Format: "12 May 2026, 14:23" (localised). For dispute evidence this is non-negotiable — the timestamp is the single most important piece of evidence value the photo carries.

If the photo has a note, the note appears below the timestamp in a smaller font.

If multiple photos share a note (a proof-set note), the note appears once above the first photo of the set with "(applies to next N photos)" indicator.

---

## Acceptance tests

Specific tests that prove the Vault and WhatsApp workflow work (also in `TESTING_CHECKLIST.md`):

1. From the Action Centre home, an inspector can find pre-arrival proof for a specific stay in under 30 seconds.
2. From a flag card, an inspector can find related dispute evidence with zero navigation.
3. Selecting 5 photos from the Vault and tapping "Open WhatsApp" produces a deep-link with the rendered message text encoded.
4. Marking a recovery message "sent" requires (or strongly nudges) a screenshot upload.
5. The screenshot upload appears in the recovery task's drawer alongside the original damage photos.
6. Searching for "TV" in the Vault returns one parent flag with all its photos grouped underneath, not several rows.
7. Generating an inspection report with "Hide OK items" toggled on produces a clean report with only flagged items and a summary count.
8. Photo timestamps appear under every photo in every report.

---

## Why this matters

The competing app for this use case is WhatsApp + a folder of screenshots. WhatsApp wins on capture speed; it loses brutally on retrieval. By using the existing `photos` table as the evidence corpus and giving it good search, the app wins on **both** capture and retrieval — and the team stops paying the WhatsApp scrolling tax.

This is also where the Asana-replacement thesis gets its real teeth. Asana stores notes; it doesn't store evidence well. The app stores evidence natively and surfaces it under the same problem card where action is being taken. That's the operational source-of-truth promise made concrete.
