# PHOTO_AND_EVIDENCE_SYSTEM.md

## Plain-English overview

Photos are the most important data the app captures. If we lose them, blur them, or attach them to the wrong record, the whole product loses its value.

This document defines exactly how a photo flows from a phone camera to a verifiable record stored in the cloud, and how it links to the inspection, issue, or maintenance job it proves.

---

## Requirements recap

- 20+ photos per apartment per day is realistic.
- 100 apartments × 20 photos × 30 days ≈ **60,000 photos/month** at scale.
- Photos must link to one or more of: property, inspection, inspection line item, issue, maintenance job, inventory movement.
- Photos must support OTA evidence packs (Airbnb / Booking.com disputes).
- Cost must stay controlled.
- Sync must be reliable but transparent (the user always knows what's pending).
- The audit chain (who took it, when, on what device, attached to what) must be intact.

---

## Architecture overview

```
   Phone camera
        │
        ▼
   Capture in-app  ──►  Compress in browser (long edge ≤ 2000px, JPEG ~80%)
        │
        ▼
   Save locally to IndexedDB (Dexie) with a client_uuid
        │
        ▼
   Upload queue ──►  Supabase Storage  (bytes)
                     │
                     └──►  photos table   (metadata, FKs)
        │
        ▼
   Mark sync_status = synced; thumbnail generated on server later
```

The photo's **bytes** live in **Supabase Storage**.
The photo's **metadata** (who, when, what it's attached to) lives in the `photos` table in Postgres.

These are kept separate on purpose:

- It keeps the database small and fast.
- It lets us migrate storage providers later (e.g. to Cloudflare R2) without touching the database.
- RLS on metadata controls access. Signed URLs control byte access.

---

## Storage layout

Inside Supabase Storage we use **one bucket per environment** and partition by company:

```
bucket: photos-prod   (or photos-staging, photos-dev)

   companies/
       <company_id>/
           inspections/
               <inspection_id>/
                   <photo_id>.jpg
                   <photo_id>_thumb.jpg
           issues/
               <issue_id>/
                   <photo_id>.jpg
           maintenance/
               <job_id>/
                   before/<photo_id>.jpg
                   after/<photo_id>.jpg
           inventory/
               <movement_id>/<photo_id>.jpg
```

Why this layout:

- Easy to spot-check or migrate per-company without touching others.
- Object listing per inspection is one prefix scan.
- The bucket is **private** — clients always go through signed URLs, never direct public links.

---

## Photo metadata (the `photos` table)

(See `DATABASE_SCHEMA_PLAN.md` for the full list. Key fields summarised here.)

- `id` (uuid, the photo id used in the filename)
- `company_id`
- One of: `property_id`, `inspection_id`, `inspection_item_id`, `issue_id`, `maintenance_job_id`, `inventory_movement_id`, **`flag_id`**, **`guest_recovery_task_id`**, **`stay_id`** (the relevant one(s) are set; others are null)
- `entity_type` — `'inspection_item' | 'issue' | 'maintenance_before' | 'maintenance_after' | 'inventory' | 'property' | 'flag' | 'guest_recovery' | 'evidence'`
- **`retention_class`** — one of `'routine_pre_arrival'` | `'routine_post_stay'` | `'dispute_evidence'` | `'owner_chargeable_evidence'` | `'annual_audit_evidence'` | `'maintenance_before_after'` | `'inventory_evidence'`. Set at capture time based on photo source. See `PHOTO_RETENTION_POLICY.md` for the full classification rules and lifecycle. Promotion is one-way (routine → dispute possible; never the reverse).
- **`bytes_deleted_at`** — set when raw bytes are purged after the v1.5 snapshot-then-delete job; metadata row survives.
- `uploaded_by` (user id)
- `captured_at` (when the photo was taken on device)
- `uploaded_at` (when it arrived on the server)
- `storage_path` (bucket + key)
- `thumbnail_path` (optional, generated server-side later)
- `file_hash` (sha256 of the bytes — for dedup detection and tamper-evidence)
- `mime_type`, `width`, `height`, `size_bytes`
- `notes` (optional, e.g. "left side of kettle")
- `sync_status` — on the server, always `synced`; the queued state lives on-device

### Retention class lifecycle

Briefly (see `PHOTO_RETENTION_POLICY.md` for the full policy):

- Every photo gets a `retention_class` at capture, derived from what the photo is linked to (e.g., a photo on a routine pre-arrival inspection line item with no flag gets `routine_pre_arrival`).
- A photo can be **promoted** to a higher-retention class but never demoted. Example: a `routine_pre_arrival` photo referenced as evidence in a later guest dispute is promoted to `dispute_evidence`. Audit row written.
- Routine classes are eligible for the snapshot-then-delete job in v1.5: raw photos purged at 90 days, the inspection's HTML report rendered to a single PDF snapshot for long-term reference. **Field ships in v1.0; enforcement ships in v1.5.**
- Routine-class snapshotting is blocked for inspections that have any linked flag still open — protects evidence-bearing photos.

---

## Capture flow (the inspector's experience)

> The capture **experience** is defined in detail in `EVIDENCE_CAMERA_AND_PHOTO_NOTES.md` (Evidence Camera Mode: open the camera once, take many photos in a row, photo strip preview, quick delete, optional notes per photo / selected photos / whole proof set, attach all at once). The steps below describe the **pipeline** underneath that experience — how a captured photo becomes a synced row. The two are consistent: Evidence Camera Mode produces a batch of blobs, and each blob flows through the pipeline below.

1. Inspector enters Evidence Camera Mode from a line item, flag, section, or recovery task. The camera opens and **stays open** for multiple shots.
2. Each captured frame's full-resolution blob goes into a Web Worker.
3. **In the worker:** the photo is resized so its long edge is ≤ 2000px and re-encoded as JPEG at ~80% quality. EXIF GPS is stripped. (Worker keeps the UI responsive.)
4. The compressed blob is stored in IndexedDB with a new `client_uuid` and appears in the on-screen photo strip.
5. A row is added to the **upload queue** (also in IndexedDB).
6. On "Attach", every photo in the batch is linked to the surface the camera was opened from (line item / flag / section / recovery task) and tagged with the derived `retention_class` — no per-photo tagging by the inspector.
7. The upload worker drains the queue when online:
   - For each item: get a signed upload URL from a server function, PUT the bytes to Supabase Storage.
   - On success, insert a row into `photos` via a server endpoint that also verifies the user is allowed to attach a photo to that record.
   - Mark the local item `sync_status = synced` and remove from the queue.
8. The photo indicator switches to **"synced"** (a small filled checkmark).

Why this design:

- **The user never waits for an upload.** Capture is instant; the camera stays open.
- **The user always sees state.** No invisible failure. Per-photo queued/uploading/synced/failed.
- **Compression happens once, on the device.** We never upload 12-megapixel originals.
- **Retries are automatic** with exponential backoff. After N failures we surface "Failed — tap to retry."
- **The server controls what attaches to what.** The client cannot lie about which inspection a photo belongs to.
- **Bookkeeping is automatic.** Because the camera was opened from a known context, the photo lands where it belongs with no Asana-style tagging admin.

### Where captured photos are seen afterwards

A photo captured once is surfaced everywhere it's relevant — it is **not** re-uploaded to a separate "evidence" store. The Evidence Vault and Evidence Drawer are **filtered views over this same `photos` table**, never separate databases. See `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md`.

---

## Compression policy

| Setting | Value | Why |
|---|---|---|
| Max long edge | 2000px | Plenty for evidence, big enough for zoom, ~10× smaller than originals. |
| JPEG quality | ~80% | Good visual quality; ~5–10× smaller than 95%. |
| Strip EXIF GPS | Yes | Privacy + reduces metadata-leak risk. |
| Strip other EXIF | No | Keep capture date/orientation; useful for evidence. |
| Target file size | < 400KB typical | Fits comfortably on 3G uploads. |

These values are tunable. The compression module exposes them as constants, not magic numbers scattered through the code.

---

## Thumbnails

- Generated **server-side** by an Edge Function on first request, then cached.
- Stored alongside the original (`<photo_id>_thumb.jpg`, ~400px long edge, JPEG 70%).
- The client uses thumbnails for list views, originals only when a photo is opened.
- Galleries lazy-load.

Generating thumbnails server-side (rather than on the phone) means we never block the inspector while they're working.

---

## Access control (RLS + signed URLs)

Reading a photo is a two-step check:

1. **Metadata RLS check** on the `photos` table: the user's role + company match the photo's `company_id` and they have permission to see the linked entity (inspection / issue / etc.).
2. **Signed URL** from Supabase Storage with a short TTL (e.g. 60 minutes). The client never receives a permanent public URL.

The bucket itself has policies on `storage.objects` that mirror the database RLS — even a leaked anon key cannot bypass them.

---

## Audit trail for photos

Every photo gets a single creation row in `audit_events`:

- `action = 'photo.uploaded'`
- `entity_type = 'photo'`, `entity_id = photos.id`
- `metadata = { storage_path, file_hash, captured_at, attached_to }`

Photo deletions write `'photo.deleted'` and include who deleted it. Photos are **soft-deleted** in MVP (`deleted_at` set) so the audit chain is preserved.

Hard deletion is a Super Admin action, audited, and reserved for legitimate cases (e.g. accidental PII, legal request).

---

## Cost control

Supabase Storage at the time of planning costs roughly:

- Storage: ~$0.021/GB/month
- Bandwidth (egress): ~$0.09/GB

Worked example for one mid-sized customer (100 properties, 20 photos/property/day, ~300KB each):

- Per day: 100 × 20 × 300KB = ~600MB
- Per month: ~18GB
- Per year: ~216GB
- Annual storage cost: ~$54

That's manageable. The cost vectors to watch:

| Risk | Mitigation |
|---|---|
| Inspectors uploading uncompressed photos | Client compression is mandatory; uploads of >5MB are rejected by the server. |
| Egress on report generation | Thumbnails for galleries; original only on click; cache on CDN. |
| Backups / accidental retention forever | Retention policy: archive photos > 24 months to cold storage (v1.5). |
| Test data in production bucket | Separate buckets per environment; never write to prod from dev. |

If a single company exceeds ~$50/month in photo storage we revisit (e.g. switch to Cloudflare R2, ~$0.015/GB and free egress). Decision deferred until we have real numbers.

---

## OTA evidence pack (later — v1.5 / v2)

When Airbnb or Booking.com requires evidence for a damage claim, we generate a pack:

- Cover sheet: property name, dates, guest reference, summary of claim
- For each line item / issue / movement:
  - Photos with timestamps
  - Inspector name and submit time
  - Manager approval (if accountability was approved)
  - Audit trail excerpt
- Exported as a single PDF + a ZIP of original photos

This is mostly a query + templating job. The data model supports it natively because every photo already carries the chain of who, when, what.

---

## Things we are NOT doing in MVP

- AI photo-quality checks (blurry / too dark) — deferred to AI roadmap.
- Side-by-side comparison of consecutive inspections' photos — manual in MVP.
- Annotation / drawing on photos — defer to v1.5 only if customers ask.
- Video.
- Photo geotagging (privacy-sensitive; the device EXIF GPS is stripped on capture).
- Watermarking with timestamps — the timestamp is in metadata; we don't bake it into pixels in MVP.

---

## Open questions to revisit

1. Do we store the **original** as well as the compressed copy? — **No in MVP.** Originals can be 5–12MB each. Storage cost outweighs the rare need.
2. Do we offer "high-quality mode" for legal disputes? — **Optional toggle per inspection** at v1.5.
3. Do we add image hashing for tamper-evidence beyond `file_hash`? — Already covered by `file_hash`. Anything stronger (e.g. content-addressable storage, signed manifests) deferred unless a customer asks.
4. Do we let owners download photos directly? — Owner viewer can see photos in the monthly summary. Bulk download is a manager action only in MVP.
