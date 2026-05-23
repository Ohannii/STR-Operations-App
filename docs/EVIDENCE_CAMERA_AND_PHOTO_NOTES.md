# EVIDENCE_CAMERA_AND_PHOTO_NOTES.md

## Plain-English overview

Photo capture is the highest-frequency physical action in the entire product. An inspector might take 30 photos in a single inspection. If each photo requires three taps and a note, the inspector quits. If photos are slow, the operation falls back to WhatsApp.

This document defines **Evidence Camera Mode** — open the camera once, fire off many photos in a row, attach all of them to the right place automatically, optionally add notes after. It is the single biggest UX bet in the v1.0 build.

The benchmark is RedRabbit. The bar is "match or exceed."

---

## What "Evidence Camera Mode" is

A camera-first capture surface that behaves like a real camera, not like an upload form:

1. Inspector taps **"Add evidence"** from any context: a line item, a flag, a recovery task, a section header, or the inspection's "extra photos" bucket.
2. The native camera UI opens immediately. No intermediate dialog.
3. Inspector takes a photo. The shutter fires; the photo is captured.
4. **The camera stays open.** Inspector takes the next photo. And the next. Burst-like.
5. A small **photo strip** at the bottom of the camera view shows thumbnails of each captured photo as they come in.
6. Inspector can swipe to delete any thumbnail before submitting (long-press → confirm).
7. When done, inspector taps **"Done"** or the back button.
8. The captured set is presented in a review screen. Optional notes can be added now (see "Photo notes" below).
9. Inspector taps **"Attach"**. All photos are linked to the right place automatically based on where the camera was opened from. No "select inspection" / "select line item" steps.

That's the whole interaction. The camera does what cameras do. The app handles the bookkeeping.

---

## Why this matters

Without Evidence Camera Mode:

- Inspector taps Add → wait for the camera to launch → take one photo → wait for the upload modal → confirm → return to the line item → tap Add again → camera launches again → take next photo → etc. This is 5+ taps per photo. At 30 photos, that's 150+ taps. Inspectors will not do this.
- The fallback is WhatsApp, where the camera also stays open. The team chooses WhatsApp every time.

With Evidence Camera Mode:

- 30 photos costs roughly 30 taps + 1 done tap. That's RedRabbit-level. That's WhatsApp-level. That's the threshold below which the team will actually use the product instead of WhatsApp.

---

## Multi-photo capture (the camera-stays-open behaviour)

The technical pattern in v1.0:

- Use the `<input type="file" accept="image/*" capture="environment" multiple>` element on Android (which supports multi-capture natively).
- On iOS Safari, which does not natively support multi-capture in the file input, use a custom camera component built on `getUserMedia()` with a manual shutter button. The component renders the live preview, captures frame-by-frame, and stacks captured frames in the photo strip. This is more dev work than the file input but is the only way to get the camera-stays-open behaviour on iOS Safari, which is the founder's primary device.

(Stack decision recorded: iOS custom camera component for v1.0 because PWA limits make it the only path.)

Frames are captured at the device's reasonable resolution and immediately compressed in a Web Worker (long edge ≤ 2000px, JPEG quality ~80). Each compressed photo lands in an in-memory queue. The queue persists to IndexedDB on background tick so a phone crash doesn't lose photos.

---

## Gallery multi-upload

For photos already on the device (e.g., the inspector took a photo of a receipt earlier):

- "Add from gallery" button in the same Evidence surface.
- Opens the native photo picker with multi-select enabled.
- Selected photos go straight into the same photo strip and the same review flow.
- Same link rules: they attach to whatever the surface was opened from.

EXIF GPS is stripped before upload (privacy + smaller files).
Photo `captured_at` uses the EXIF capture timestamp when available, falls back to upload timestamp.

---

## The photo strip

A horizontal strip across the bottom of the camera view, ~80px tall, showing thumbnails of every photo captured so far in this session.

- Newest photo on the right (the eye expects burst capture there).
- Tap a thumbnail → full-screen preview of that photo with delete button.
- Long-press a thumbnail → quick delete with confirmation.
- Strip shows a count: "8 photos."
- Strip scrolls horizontally when there are more than fit on screen.

---

## Quick delete before submit

Mistakes happen — wrong angle, blurred, accidental shot of the floor.

Quick delete:

1. Long-press a thumbnail in the strip OR open the preview.
2. Tap delete (trash icon).
3. Confirmation only if the photo has been captured for more than 30 seconds (recent ones delete instantly to keep the burst flow fast).
4. Photo is removed from the queue; thumbnail strip updates.

After "Attach" is tapped, the photos are committed to the database. Post-commit deletion follows the standard photo-deletion rules in `PHOTO_AND_EVIDENCE_SYSTEM.md` (audited; only Super Admin in MVP).

---

## Optional photo notes

Notes are **optional by default**. The inspector can add a note to:

- **One photo** — tap a thumbnail in the review screen → text field.
- **Multiple selected photos** — tap "Select" in the review screen, tap photos to select them, tap "Add note" → text field. Note is applied to each selected photo (same text on each row in the database; no shared parent row needed).
- **All photos in the current set (a "proof set" note)** — tap "Note for all photos" at the top of the review screen. The note is stored as a single string and applied to every photo row in this set. The UI shows "Same note on N photos."

Why proof-set notes rather than a parent "proof set" entity:
- Simpler data model. Each photo carries its own `notes` column. No new tables needed.
- A "proof set" note is just the same string written into many rows.
- Reports render it cleanly by detecting "all consecutive photos with the same note in this inspection" and showing the note once with "(applies to next N photos)" indicator.

(See `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md` for the report rendering.)

---

## When notes are required (instead of optional)

Default: notes are **optional**. The inspector can submit a photo with no note and nothing complains.

Notes become **required** in three cases, and the UI blocks submit until a note is provided:

1. **The template item requires a note.** Templates define `required_note: bool` per line item. Used for high-evidence items like "Safe lock check — describe condition."
2. **The photo is attached to a flagged item where the flag type requires explanation.** Currently: `guest_damage` flag type requires a note describing what the damage is and where it is. `safety_urgent` requires a note describing the hazard. Other flag types do not.
3. **The flag was raised but no flag-level description was provided.** The note on the first photo doubles as the flag's description.

When a note is required, the UI shows a small red "Note required" label and disables Submit until the note has at least 3 characters. No silent rejection.

---

## Proof photos without notes (the common case)

Most proof photos do not need notes. A pre-arrival photo of a tidy bed does not need text. A post-stay photo of a clean kettle does not need text.

The inspector experience for this happy path:

1. Tap "Add evidence" from a line item.
2. Take 5 photos (camera stays open the whole time).
3. Tap Done.
4. Review screen shows the 5 thumbnails.
5. Tap Attach.

That's it. No text. No prompts. 5 photos in roughly 15 seconds.

---

## Flag/issue photos with notes when required

For evidence-bearing photos on flags or issues, the workflow gains one optional step:

1. Tap "Add evidence" from a flag card or a flagged line item.
2. Take the photos.
3. Tap Done → review screen.
4. If the flag type requires a note (guest_damage / safety_urgent), the field is highlighted.
5. Inspector types a short description: "Crack across the centre of the TV screen, front face." Saves on each photo OR as a proof-set note for all of them.
6. Tap Attach.

The note becomes the flag's description if the flag didn't already have one.

**Note timing for damage/maintenance flags (prototype finding #7):** when the flag is a damage or maintenance type, the descriptive note is captured **inside the guided flag workflow, before the flag is saved** — while the inspector is still looking at the problem. This is more reliable than capturing photos now and hoping someone writes the note later. The photo notes described in this document and the flag's own description work together: the first photo's note (or proof-set note) doubles as the flag description when no separate description was typed.

---

## Pre-arrival Evidence Pack (prototype finding #13)

A frequent, high-value retrieval is "give me timestamped proof the apartment was fine before this guest." The **Pre-arrival Evidence Pack** button (on the Apartment Action Centre property header — see `APARTMENT_ACTION_CENTRE.md`) assembles the relevant baseline photos in one tap:

- It is built from the existing `photos` table, filtered to `retention_class = 'routine_pre_arrival'` for the chosen property/stay — **not** a separate store and **not** a re-upload.
- Output is a timestamped, print/share-ready proof set (the same rendering used by the Evidence Vault's "evidence pack" — see `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`).
- This is the capture side's pay-off: because Evidence Camera Mode made baseline capture fast and frictionless during every turnover, the proof is already there when a dispute arrives weeks later.

---

## Photo timestamps and metadata

Every photo carries:

- `captured_at` — when the shutter fired (from EXIF, or device clock at capture time).
- `uploaded_at` — when the server received it.
- `uploaded_by` — inspector's user id.
- `inspection_id`, `inspection_item_id`, `flag_id`, `guest_recovery_task_id`, `stay_id`, `property_id` — whichever apply, based on the surface the camera was opened from.
- `retention_class` — derived from where the camera was opened (see `PHOTO_RETENTION_POLICY.md`).
- `notes` — optional, as above.
- `entity_type` — short string for which entity the photo "primarily" belongs to.
- `file_hash` (sha256) — for tamper-evidence and dedup detection.
- `width`, `height`, `mime_type`, `size_bytes`.

These are all already in the schema (see `DATABASE_SCHEMA_PLAN.md`).

---

## Photo sync status (visible to the inspector)

Captures-while-offline is normal. The inspector must always know whether their photos are safe.

States, shown per photo:

| State | UI indicator | Meaning |
|---|---|---|
| `queued` | grey clock icon | Captured locally, not yet uploaded. Lives in IndexedDB. |
| `uploading` | spinning arrow | Currently transferring bytes. |
| `synced` | green check | On the server, metadata row written. |
| `failed` | red exclamation | Last upload attempt failed; will retry. Tappable for manual retry. |

Top-level banner on the Action Centre and inspection screens: "8 photos waiting to sync." When zero, banner is hidden.

Sync runs whenever the app is foregrounded AND connectivity is detected. Background sync is unreliable on iOS PWA, so we don't promise it. We don't *need* it — sync resumes whenever the inspector opens the app.

---

## Photo retention class — derived automatically

The inspector never picks a retention class. It is derived from the surface the camera was opened from:

| Camera opened from… | Retention class |
|---|---|
| Pre-arrival inspection line item, no flag yet | `routine_pre_arrival` |
| Post-stay inspection line item, no flag yet | `routine_post_stay` |
| Pre-arrival or post-stay inspection line item with a flag | promoted to `dispute_evidence` if flag type is `guest_damage`, else `inventory_evidence` or `maintenance_before_after` based on flag type |
| Annual audit inspection | `annual_audit_evidence` |
| Flag card (any flag type) | derived from flag type |
| Guest recovery task | `dispute_evidence` |
| Maintenance job | `maintenance_before_after` |
| Inventory movement | `inventory_evidence` |

If a photo's parent flag is later re-classified, the photo's retention class can be **promoted** (one-way; never demoted). See `PHOTO_RETENTION_POLICY.md`.

---

## Where the photos appear afterwards

A photo captured in Evidence Camera Mode is immediately visible:

- On the line item / flag card / recovery task it was attached to.
- In the inspection's photo set.
- In the Evidence Drawer of the parent flag (if attached via a flag).
- In the property's Evidence Vault (queryable).
- In any report covering the time window or entity.

It is captured **once**, surfaced **everywhere** it matters. No re-uploading. No "also save this to Evidence."

(See `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`.)

---

## How this avoids repetitive Asana-style admin

The Asana workflow staff are currently using:

1. Take a photo in WhatsApp / camera roll.
2. Open Asana.
3. Find the right task (or create one).
4. Upload photo.
5. Write a description because there's no context.
6. Tag the right teammate.
7. Send WhatsApp message saying "I tagged you in Asana."

That is seven steps per photo, much of it bookkeeping.

The Evidence Camera workflow:

1. Open camera from the relevant flag / item.
2. Take photo.
3. (Tap Done if you took several.)

The bookkeeping is **automatic** because the camera was opened from a known context. The system already knows the property, the inspection, the line item, the inspector, and the timestamp. The photo lands where it belongs without any tagging effort.

This is the single largest workflow improvement in the product.

---

## RedRabbit benchmark comparison

RedRabbit is a respected property inspection app. Our team needs to match or exceed its evidence-capture ergonomics. Where we match and where we exceed:

| Capability | RedRabbit | This app |
|---|---|---|
| Open camera once, take many photos | ✓ | ✓ |
| Photo strip preview before commit | ✓ | ✓ |
| Quick delete in capture session | ✓ | ✓ |
| Optional photo notes | ✓ | ✓ |
| Note per photo OR shared across set | ~ (note per photo only) | ✓ (per photo, multi-selected, or proof-set) |
| Photo attaches to checklist line item automatically | ✓ | ✓ |
| Photo attaches to a *problem thread* (parent flag) | ✗ (no equivalent concept) | ✓ (the parent-flag model) |
| Generate maintenance ticket from inspection | ✓ | ✓ (via flag → maintenance job) |
| Generate guest recovery task from inspection | ✗ | ✓ |
| Generate owner-chargeable record with approval cap enforcement | ✗ | ✓ |
| Search evidence by stay / dispute / OTA claim | ~ (basic) | ✓ (Evidence Vault with rich filters) |
| WhatsApp deep-link with pre-filled message | ✗ | ✓ |
| Configurable photo retention by class | ✗ | ✓ |
| Offline capture with sync resume | ✓ | ✓ |

Where RedRabbit wins: probably mature small details we don't know about yet. The risk is overestimating our parity. Real field test in v1.0 against an inspector who has used RedRabbit before is the cheapest way to find out.

Where we must clearly win: search and the parent-flag thread. That's the operational source-of-truth thesis. RedRabbit is an inspection tool; we are an operations platform that uses inspections as evidence.

---

## Acceptance tests for v1.0

Evidence Camera Mode is acceptable for v1.0 when:

1. An inspector can capture 20 photos from one line item in under 60 seconds on a real iPhone, on real signal.
2. The camera stays open between shots — no return to the app screen between captures.
3. Captured photos appear in the photo strip immediately.
4. Long-press deletes a photo with confirmation.
5. Tapping Done returns to a review screen showing all photos.
6. Tapping Attach saves all photos with correct `inspection_item_id`, `retention_class`, `captured_at`.
7. No required-note prompt appears unless the line item or flag type requires one.
8. Adding a note to "all photos" stores the same note string on each row.
9. Photos uploaded offline appear with status `queued`; auto-upload resumes on reconnect; status transitions to `synced`.
10. After a phone crash mid-session, restarting the app preserves the queued photos.
11. EXIF GPS is stripped from every uploaded photo.
12. From the inspection's photo set, an inspector can find a specific photo from any of their last 5 inspections in under 15 seconds.

---

## What is NOT in v1.0

- **Annotation drawing on photos** (red circles around damage, arrows). v1.5.
- **In-app cropping** beyond rotation. v1.5.
- **Live OCR / damage detection** (AI). v2+ and only as drafting hints, never authoritative — see `AI_FEATURE_ROADMAP.md`.
- **Signed external evidence pages** for guest viewing without WhatsApp. v1.5.
- **Burst mode at 5 frames per second** (we capture as fast as the user can tap, which is sufficient).
- **Video evidence.** Out of scope for MVP entirely.

---

## Why this matters

If photo capture is anything less than camera-fast, the team falls back to WhatsApp and the product is dead in the water for inspections. This is the workflow that determines whether the product replaces the team's current habits or adds a new chore on top of them.

The whole evidence model upstream of this — flags, retention classes, Evidence Vault, OTA evidence packs, owner reports — is only useful if the photos actually get captured in the first place. Evidence Camera Mode is the gate.
