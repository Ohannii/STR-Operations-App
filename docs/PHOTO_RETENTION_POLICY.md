# PHOTO_RETENTION_POLICY.md

## Plain-English overview

The product captures a lot of photos. The dominant flow is the **combined Turnover inspection** (post-stay + pre-arrival in one visit), so we no longer count pre-arrival and post-stay as two separate photo events. Best current **estimate**: ~300 turnovers/month × ~12 photos each ≈ 3,600/month, plus ~50 annual audits/year (~50 photos each ≈ 208/month), plus maintenance/issue/inventory photos — call it **~3,800–4,500 photos/month**. (The earlier "60,000+/month" figure assumed separate pre-arrival and post-stay inspections with 20 photos each; the turnover model roughly halves the routine inspection photo count.) **All photo and storage numbers in this document are estimates until confirmed by real use** (see `COST_TRACKER.md`).

Not all of those photos have the same value. A pre-arrival photo of a clean coffee table where nothing went wrong has near-zero evidence value after the stay ends. A post-stay photo of a cracked TV with a R5,000 owner-chargeable record attached is permanent evidence.

This document defines **how photos are classified, how long each class is kept, and what happens at the boundaries**.

The model has two goals:

1. **Keep what matters legally and operationally** — dispute evidence, chargeable evidence, audit evidence.
2. **Don't pay forever for trivia** — routine "all good" photos should age out or get compacted into report snapshots.

---

## The seven retention classes

| Class | What it covers | Default retention (hot storage) | After hot | Why this class exists |
|---|---|---|---|---|
| `routine_pre_arrival` | Standard pre-arrival inspection photos, no issues raised. | 90 days | Snapshot into the inspection report PDF/HTML, then delete raw. | Volume is high; once stay completes with no claim, raw images have low evidence value. |
| `routine_post_stay` | Post-stay inspection photos, no flags raised. | 90 days | Snapshot into the inspection report, then delete raw. | Same as above. |
| `dispute_evidence` | Photos attached to any flag that became a guest recovery task. | 5 years | Cold storage (archived). | OTA disputes can re-emerge; legal claims have long tails. |
| `owner_chargeable_evidence` | Photos attached to approved owner-chargeable accountability records. | 3 years | Cold storage. | Owner disputes the charge years later; evidence must survive. |
| `annual_audit_evidence` | Photos from the ~50 annual audits per year. | 7 years | Cold storage. | Annual audits are baseline documents; needed for long-tail contract reviews. |
| `maintenance_before_after` | Before/after photos on maintenance jobs. | 2 years | Cold storage. | Useful for warranty claims, recurring-issue analysis, owner reports. |
| `inventory_evidence` | Photos on inventory movements (missing / damaged / restocked). | 2 years | Cold storage. | Backs up the inventory ledger. |

"Hot storage" = Supabase Storage as we've planned it. "Cold storage" = the same bucket but flagged for archival (in v1.5 we add a separate cheaper bucket or move to Cloudflare R2; in v1.0–v1.3 cold = hot, only the field is recorded for future enforcement).

---

## How a photo is classified

The retention class is set **at capture time** by deriving it from the photo's link target:

| Photo linked to … | Default class |
|---|---|
| Pre-arrival inspection line item with no flag | `routine_pre_arrival` |
| Post-stay inspection line item with no flag | `routine_post_stay` |
| Annual audit inspection | `annual_audit_evidence` |
| Flag of type "guest damage" → guest recovery task | `dispute_evidence` |
| Accountability record where `chargeable_party = 'owner'` | `owner_chargeable_evidence` |
| Maintenance job (any) | `maintenance_before_after` |
| Inventory movement (any) | `inventory_evidence` |

A photo can be **promoted** to a higher-retention class but never demoted. For example: a pre-arrival photo starts as `routine_pre_arrival`; if a later guest dispute references that photo as evidence, the system promotes it to `dispute_evidence`. The audit trail records the promotion.

Promotion is one-way to protect evidence. If anyone tries to demote — say, to delete an inconvenient dispute photo by reclassifying it as "routine" — the action is rejected at the policy level.

---

## Snapshot, not delete

When a routine pre-arrival or post-stay inspection's hot retention expires (default 90 days), we don't simply delete the photos and lose them. Instead:

1. Generate (or confirm we already have) the inspection's HTML report including all photos as thumbnails inline.
2. Render that report to a **single PDF snapshot** stored as a separate object in the photos bucket under `companies/<id>/snapshots/<inspection_id>.pdf`.
3. Update the inspection record: `snapshot_path = <path>`, `snapshot_generated_at = now()`, `raw_photos_purged_at = now()`.
4. Delete the individual raw photo objects (bytes) but keep the `photos` table rows with `bytes_deleted_at = now()` so the metadata trail survives.
5. From now on, anyone who opens the inspection sees the snapshot PDF. The thumbnails still load (they're in the PDF). The full-resolution originals are gone.

This pattern keeps the evidence value (you can still show the inspection to an owner or auditor) while collapsing 20 separate ~300KB images into a single ~2MB PDF. Storage drops roughly 3-fold for the routine classes.

**Crucial:** the snapshot is only created for inspections where no flag was raised on any line item. If even one line item has a flag, the inspection is excluded from snapshotting until all linked flags are closed. This protects evidence-bearing photos.

---

## Retention timelines, by phase

| Capability | v1.0 | v1.1 | v1.2 | v1.3 | v1.5 |
|---|---|---|---|---|---|
| `retention_class` column on photos | ✅ stored at capture | ✅ | ✅ | ✅ | ✅ |
| Class assigned correctly on capture | ✅ | ✅ | ✅ | ✅ | ✅ |
| Class promotion (e.g. routine → dispute) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hot/cold split (separate buckets or providers) | ⬜ | ⬜ | ⬜ | ⬜ | ✅ |
| Snapshot-then-delete for routine classes | ⬜ | ⬜ | ⬜ | ⬜ | ✅ |
| Configurable retention per company | ⬜ | ⬜ | ⬜ | ⬜ | ✅ |

Why the field ships in v1.0 even though enforcement comes in v1.5: **adding a column to a populated table is cheap; backfilling a year of photos with the right class is painful**. We pay the small cost now and reap the benefit later.

---

## Per-photo storage cost projection

**Estimates only — confirm with real use.** Assumptions: ~300 turnovers/month (each producing a mix of routine pre-arrival baseline + post-stay photos) + ~50 annual audits/year + ~30 maintenance/issue/inventory events/month. ~12 photos per turnover, ~50 per annual audit, ~5 per maintenance/inventory event. ~300KB per compressed photo.

| Month | Class | Photos (estimate) | Bytes/photo | Monthly bytes | Hot storage cost (Supabase ~$0.021/GB/mo) |
|---|---|---|---|---|---|
| Per month | routine (pre-arrival + post-stay, from turnovers) | ~300 × 12 ≈ 3,600 | 300KB | ~1.08GB | ~$0.023 |
| Per month | annual_audit_evidence | ~50 audits/yr ≈ 4/mo × 50 ≈ 200 | 300KB | ~0.06GB | ~$0.001 |
| Per month | maintenance / inventory | ~30 × 5 = 150 | 300KB | ~0.045GB | ~$0.001 |
| Per month | dispute / chargeable | ~10 × 5 = 50 | 300KB | ~0.015GB | ~$0.0003 |
| Per year | All hot storage if no snapshotting | — | — | ~15GB | ~$3.80/year |
| Per year | All hot storage WITH snapshotting at 90 days | — | — | ~5GB | ~$1.30/year |

At one customer's scale, storage cost is small. At 10 customers, hot storage with no snapshotting is roughly ~$40/year — still small. The snapshotting policy matters less for cost than for **searchability and bucket clutter**. (All figures estimates; see `COST_TRACKER.md`.)

The bigger cost vector is **bandwidth** — when someone opens a 12-photo inspection, that's a few MB egressing. Snapshotting collapses many photo requests into one PDF request, which is also a UX win on slow connections.

---

## Edge cases

| Situation | Behaviour |
|---|---|
| A flag is raised after the inspection's 90-day mark, before snapshot | Inspection is excluded from snapshotting (it now has a linked flag). |
| Snapshot was generated, then a guest dispute emerges referencing one of the (purged) photos | The snapshot PDF is the evidence. Original full-resolution images are no longer available. This is acceptable for routine classes and is the trade-off; if the customer needs full-res forever, they can opt out per-company in v1.5. |
| Customer wants to opt out of snapshotting entirely | Configurable per-company in v1.5 (`retention_policy_id`). Default in v1.0–v1.3 is "snapshot off but classes tagged" so nothing destructive happens. |
| Photo upload fails after class is assigned | The class is on the photo row; bytes failing to upload doesn't change class. Retry uses the same class. |
| Photo is part of two records (e.g., attached to both inspection and issue) | The higher-retention class wins. Linked-record table tracks all attachments. |
| Photo is hard-deleted (Super Admin only) | Audited; the deletion event records the class so we know what level of evidence was destroyed. |

---

## Owner-facing implications

Owners see:

- Their monthly summary photos (always — these are `owner_chargeable_evidence`, retained 3 years).
- Their property's inspection reports (always, via the snapshot if old, raw photos if recent).
- They do **not** see routine pre-arrival raw photos for old inspections — they see the snapshot. The information is preserved; the storage is not duplicated.

---

## Operational implications for the team

1. **Field team doesn't choose retention class.** It's auto-derived. They never see the column.
2. **Managers see the class** in admin views, mostly for diagnostic and dispute purposes.
3. **Company Admin can configure retention defaults** in v1.5 if they want longer / shorter retention than the standard.
4. **Super Admin can override** for legal hold scenarios (e.g., "this property is in litigation — retain everything indefinitely until further notice"). Audited.

---

## What is NOT in v1.0

- The actual snapshot-then-delete job (v1.5).
- The hot/cold separation in storage (v1.5).
- Per-company retention overrides (v1.5).
- Cloudflare R2 migration (only if cost requires).
- Photo deletion UI for managers (not allowed — only Super Admin, audited).

What ships in v1.0: the `retention_class` field, the auto-derivation rule at capture, and the promotion-only enforcement. That's enough to make the v1.5 enforcement painless when the time comes.

---

## Why this matters

Without retention classes, we pay for storing the same routine "everything's fine" photos forever, and the bucket eventually becomes unsearchable noise. With them, the product captures more evidence than competing tools while spending less to store it.

Just as importantly: when an owner asks "what's the policy on how long you keep photos of my property?" — we have a real answer, not a shrug.
