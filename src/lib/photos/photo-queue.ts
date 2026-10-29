'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import {
  attachEvidencePhoto,
  attachEvidencePhotosBatch,
  discardStagedPhotoIntent,
  requestPhotoUploadSlot,
  type UploadSlot,
} from '@/app/properties/[id]/photos/actions'
import { packCapture } from '@/lib/photos/pack-capture-store'
import { dbg, timed } from '@/lib/photos/photo-queue-debug'
import { mapBounded } from '@/lib/util/bounded-map'
import { withDeadline } from '@/lib/util/deadline'
import {
  isRetentionClass,
  PRE_ARRIVAL_RETENTION,
  type RetentionClass,
} from '@/lib/photos/retention'
import {
  claimQueuedPhoto,
  deleteQueuedPhoto,
  getQueuedPhoto,
  listQueuedForPack,
  listQueuedIdsForPack,
  patchQueuedPhoto,
  putQueuedPhoto,
  requestPersistentStorage,
  type QueuedPhotoRecord,
} from '@/lib/photos/photo-queue-db'
import {
  buildAttachInput,
  provenAttachPaths,
  claimForAttachDecision,
  claimForStagingDecision,
  claimForUploadDecision,
  describeQueue,
  MAX_AUTO_RETRY_ATTEMPTS,
  msUntilNextRetry,
  nextDiscardable,
  noteEditDecision,
  reclaimDecision,
  reclaimableRecords,
  releaseDecision,
  type NoteEdit,
  stageFailureDecision,
  stageFinalizeDecision,
  ATTACH_BATCH_SIZE,
  resolveBatchOutcomes,
  stageableRecords,
  summarizeQueue,
  UPLOAD_CONCURRENCY,
  uploadableRecords,
  type QueueSummary,
  type QueuedPhotoMeta,
} from '@/lib/photos/photo-queue-state'
import {
  bumpHighWater,
  clearNoteShadowIfIdentity,
  readNoteShadow,
  removeNoteShadow,
  removeHighWater,
  clearHighWaterIfSettled,
  readNoteShadows,
  shadowSatisfied,
  shadowScopeMatches,
  type NoteShadow,
} from '@/lib/photos/capture-note-shadow'
import { canonicalCaptionOrNull, captionTooLong } from '@/lib/photos/caption-canonical'

/**
 * Sequential upload worker for the durable photo queue (Outcome 3).
 *
 * Concurrency 1, by design: it narrows the partial-write window to a single
 * photo (the Unit 359 interruption left one complete pair and one half-written
 * original because four uploads were in flight at once).
 *
 * Per record, always with the SAME logical uuid so every step is idempotent:
 *   1. server intent   (create_prearrival_photo_intent, via the slot action)
 *   2. upload slot     (create-only signed URLs for the derived paths)
 *   3. PUT master      (409 = already there)
 *   4. PUT thumb       (409 = already there)
 *   5. attach          (attach_prearrival_photo — atomic, idempotent)
 *   6. delete the IndexedDB record ONLY after the server confirms
 *
 * Resume triggers: mount, pageshow (BFCache restore), visibilitychange →
 * visible (returning from a phone call), and online. No polling, no service
 * worker.
 */

type PackScope = {
  userId: string
  companyId: string
  propertyId: string
  packId: string
}

type PackQueueState = {
  records: QueuedPhotoMeta[]
  summary: QueueSummary
  online: boolean
  /** Set when the device cannot store photos at all — submission must block. */
  storageError: string | null
  /**
   * Set when at least one photo has been CONFIRMED attached since the last
   * refresh, meaning the server-rendered linked count is now stale. It is
   * acknowledged (cleared) BEFORE the refresh fires, so a remount or re-render
   * cannot retrigger it.
   */
  serverRefreshNeeded: boolean
  /** True while the sequential worker is actively draining this pack. */
  draining: boolean
  /**
   * True once IndexedDB has been read at least once for this pack. Consumers
   * that CORRELATE against the local queue (the orphan panel) must not draw
   * conclusions from an unhydrated, empty-by-default snapshot.
   */
  hydrated: boolean
  /**
   * Ids whose local record was deleted by the DISCARD path (confirmed server
   * cancellation), this session. The Done gate consumes this so a deletion
   * can never impersonate an attachment: record-gone counts as attached ONLY
   * when the id is not listed here.
   */
  discardedIds: string[]
}

const EMPTY_SUMMARY: QueueSummary = {
  total: 0,
  savedLocal: 0,
  queued: 0,
  uploading: 0,
  attaching: 0,
  failed: 0,
  retrying: 0,
  discarding: 0,
  blocking: false,
}

const EMPTY: PackQueueState = {
  records: [],
  summary: EMPTY_SUMMARY,
  online: true,
  storageError: null,
  serverRefreshNeeded: false,
  draining: false,
  hydrated: false,
  discardedIds: [],
}

const states = new Map<string, PackQueueState>()
const listeners = new Set<() => void>()
const running = new Set<string>()
const emit = () => {
  for (const l of listeners) l()
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false
}

/** Session ledger of ids deleted via the DISCARD path (per pack). Feeds
 *  PackQueueState.discardedIds so record-gone can never read as attached for
 *  a photo that was actually cancelled. */
const discardedLedger = new Map<string, Set<string>>()

function recordDiscarded(packId: string, photoId: string): void {
  let set = discardedLedger.get(packId)
  if (!set) {
    set = new Set()
    discardedLedger.set(packId, set)
  }
  set.add(photoId)
  setState(packId, { discardedIds: Array.from(set) })
}

function setState(packId: string, next: Partial<PackQueueState>): void {
  const prev = states.get(packId) ?? EMPTY
  const merged: PackQueueState = { ...prev, ...next }
  merged.summary = summarizeQueue(merged.records)
  states.set(packId, merged)
  emit()
}

/**
 * Metadata view of a record — the blobs are deliberately excluded so the UI
 * snapshot never holds image data in memory. Written out field by field so
 * TypeScript fails the build if QueuedPhotoMeta ever gains a field.
 */
function toMeta(r: QueuedPhotoRecord): QueuedPhotoMeta {
  return {
    id: r.id,
    userId: r.userId,
    companyId: r.companyId,
    propertyId: r.propertyId,
    packId: r.packId,
    capturedAt: r.capturedAt,
    note: r.note,
    width: r.width,
    height: r.height,
    sizeBytes: r.sizeBytes,
    state: r.state,
    // REGRESSION LESSON (21 Jul): these optional fields were silently dropped
    // here, so the UI snapshot NEVER saw bytesStaged/discardRequested — the
    // "Uploaded" checkmark could not appear and every badge stuck on
    // "Uploading". Optional fields hide from the field-by-field type check;
    // every QueuedPhotoMeta field must be copied EXPLICITLY, including
    // optional ones.
    bytesStaged: r.bytesStaged,
    masterPath: r.masterPath,
    thumbPath: r.thumbPath,
    retentionClass: r.retentionClass,
    intentRequested: r.intentRequested,
    discardRequested: r.discardRequested,
    discardReason: r.discardReason,
    leaseUntil: r.leaseUntil,
    lastError: r.lastError,
    attempts: r.attempts,
    lastAttemptAt: r.lastAttemptAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** Re-read the pack's records from IndexedDB into the store. */
export async function refreshQueue(packId: string): Promise<void> {
  try {
    const records = await listQueuedForPack(packId)
    setState(packId, {
      // Strip blobs out of the snapshot the UI subscribes to.
      records: records.map(toMeta),
      online: isOnline(),
      storageError: null,
      hydrated: true,
    })
  } catch (err) {
    setState(packId, {
      storageError:
        err instanceof Error ? err.message : 'Could not read photos saved on this device.',
      online: isOnline(),
    })
  }
}

/**
 * Persist a freshly captured photo BEFORE it is shown as captured and before
 * any network call. Throws if the device cannot store it — the caller must
 * surface a blocking error and must NOT treat the photo as safe.
 */
export async function enqueuePhoto(
  scope: PackScope,
  photo: {
    id: string
    master: Blob
    thumb: Blob
    width: number
    height: number
    sizeBytes: number
    capturedAt: string
    note: string | null
    /** true = ready to upload now; false = inspector may still edit the note. */
    release: boolean
  },
): Promise<void> {
  void requestPersistentStorage()
  const now = new Date().toISOString()
  const record: QueuedPhotoRecord = {
    ...scope,
    id: photo.id,
    master: photo.master,
    thumb: photo.thumb,
    width: photo.width,
    height: photo.height,
    sizeBytes: photo.sizeBytes,
    capturedAt: photo.capturedAt,
    note: photo.note,
    state: photo.release ? 'queued' : 'saved_local',
    lastError: null,
    attempts: 0,
    lastAttemptAt: null,
    createdAt: now,
    updatedAt: now,
  }
  await putQueuedPhoto(record) // throws on failure — caller blocks
  await refreshQueue(scope.packId)
}

/**
 * TOTAL release budget — COUNT-INDEPENDENT (audit, 23 Jul). Per-record 8s
 * deadlines in a sequential 25-photo release could still hold the modal for
 * ~200 seconds: the four-minute failure in a new shape. The whole release
 * now runs bounded-parallel under ONE fixed ceiling; whatever did not settle
 * inside it is reported in failedIds and stays durable for later retry (a
 * straggler claim that completes late simply becomes queued and the drain
 * attaches it — the notice can only ever overstate, never lose).
 */
const RELEASE_TOTAL_BUDGET_MS = 10_000
const RELEASE_CONCURRENCY = 5

/** Release saved-but-unqueued photos (and update notes) for upload.
 *  Returns the ids that could NOT be confirmed released within the budget so
 *  callers can surface an honest recovery notice instead of a silent partial
 *  release. Total latency is bounded by RELEASE_TOTAL_BUDGET_MS regardless
 *  of photo count.
 *
 *  CAPTION FAIL-CLOSED (rev 3, 23 Oct): caption shadows are reconciled FIRST
 *  and a photo whose newer shadow could not be PROVEN into its record is NOT
 *  released — it stays saved_local, keeps its shadow and is reported in
 *  failedIds. `editsById` carries the capture keeper's exact release EDIT
 *  (version + identity, already shadowed) for each caption in `notesById`.
 *  If a release caption cannot be proven newer than the durable one, that
 *  photo is NOT released and is reported (rev 4, fail closed).
 *
 *  EXACT INTENDED COVERAGE (rev 8): when `notesById` is supplied, its keys ARE
 *  the handoff. failedIds then covers EXACTLY every intended photo not proven
 *  handed off — including one missing from the device queue, and every one
 *  when the queue cannot be read — and unrelated saved_local records of the
 *  same pack are neither released nor reported. Without `notesById` (the
 *  PackQueuePanel recovery) every saved_local record of the pack is released
 *  as before. */
export async function releaseQueued(
  packId: string,
  notesById?: Record<string, string | null>,
  editsById?: Record<string, NoteEdit>,
): Promise<{ failedIds: string[] }> {
  const intended: string[] | null = notesById ? Object.keys(notesById) : null

  // ONE WRITE PER PHOTO (hotfix, one-tap attach). Each record carries its
  // photo blobs inline, so every claim rewrites the whole record and every
  // write is serialized with the background uploader. The release caption's
  // own shadow (written synchronously by prepareRelease) used to be applied
  // by a SEPARATE reconcile write before the release claim. It is now applied
  // INSIDE the release claim and proven by the same identity rule
  // (shadowSatisfied) — a photo whose record does not end up holding exactly
  // that edit stays failed, exactly as a blocked reconcile did.
  const carried = new Map<string, NoteEdit & { shadow: NoteShadow; note: string | null }>()
  if (notesById && editsById) {
    for (const id of intended ?? []) {
      const edit = editsById[id]
      if (!edit) continue
      const shadow = readNoteShadow(packId, id)
      if (shadow && shadow.editId === edit.editId && shadow.v === edit.v) {
        carried.set(id, { ...edit, shadow, note: canonicalCaptionOrNull(notesById[id]) })
      }
    }
  }

  let captionBlocked: Set<string>
  try {
    captionBlocked = new Set((await reconcileNoteShadows(packId, carried)).blocked)
  } catch (err) {
    // reconcileNoteShadows is per-shadow exception-isolated; reaching here
    // means storage itself is unusable — release NOTHING (fail closed).
    dbg('release:reconcile-failed', {
      detail: err instanceof Error ? err.message : 'reconcile failed',
    })
    if (intended) return { failedIds: intended }
    let ids: string[] = []
    try {
      ids = await listQueuedIdsForPack(packId)
    } catch {
      // storage unreadable: the panel's storageError surface owns this state
    }
    return { failedIds: ids }
  }
  let ids: string[]
  try {
    // KEYS ONLY (hotfix): which photos exist — no blob is read.
    ids = await listQueuedIdsForPack(packId)
  } catch (err) {
    // Storage unreadable: nothing was released. A caller handing off specific
    // photos gets ALL of them back as failed (never a silent []); the
    // recovery panel's storageError surface owns the no-map case.
    dbg('release:list-failed', {
      detail: err instanceof Error ? err.message : 'list failed',
    })
    return { failedIds: intended ?? [] }
  }
  if (intended) {
    // Only THIS handoff's photos: never release or report unrelated records.
    const wanted = new Set(intended)
    ids = ids.filter((id) => wanted.has(id))
  }

  // A record is RESOLVED when its claim settles: released, or correctly
  // refused (not saved_local / removed) — only unsettled/thrown ones count
  // as failed. ATOMIC per-record release semantics are unchanged: the
  // decision runs against the LATEST row inside one transaction, touches
  // only state/lease/note, and revokes any in-flight stager's lease.
  const resolved = new Set<string>()
  // BUDGET GATE (audit, 23 Jul): withDeadline stops WAITING, it cannot stop
  // WORK. The gate is checked before EVERY claim: once the budget closes, no
  // new claimQueuedPhoto begins; skipped records stay unresolved and land in
  // failedIds. Claims already in flight may still settle LATE — see below.
  const budgetClosed = { current: false }
  // Fallback stamp for callers that pass notes without keeper edits;
  // releaseDecision forces it above the record's current version.
  const releaseStamp = Date.now()
  const work = mapBounded(ids, RELEASE_CONCURRENCY, async (id) => {
    if (budgetClosed.current) return // skipped -> unresolved -> failedIds
    // FAIL CLOSED: an unproven newer caption shadow blocks THIS photo.
    if (captionBlocked.has(id)) return // unresolved -> failedIds
    try {
      const note = notesById ? notesById[id] : undefined
      const carry = carried.get(id)
      let carryApplies = false
      const claimed = await claimQueuedPhoto(id, (cur) => {
        if (cur.packId !== packId) return null
        // A shadow whose scope does not match is never applied (reconcile's
        // rule) — and reconcile would have left it alone, so fall back to
        // the plain release for this photo.
        carryApplies = carry !== undefined && shadowScopeMatches(cur, carry.shadow, packId)
        const release = releaseDecision(cur, note, editsById?.[id] ?? releaseStamp)
        if (release || !carryApplies || !carry) return release
        // Already released (queued/failed): still carry the strictly newer
        // release caption into the record, exactly as reconcile did.
        return noteEditDecision(cur, carry.note, carry.v, carry.editId)
      })
      let rec = claimed
      if (!claimed && note !== undefined) {
        // A null claim is either "already released / removed" (correct) or
        // "the release caption could not be proven newer" (fail closed).
        // Re-read to tell them apart; never count the latter as resolved.
        const fresh = await getQueuedPhoto(id)
        if (!fresh) {
          // Missing / vanished: NOT proven handed off (rev 8) — absence is
          // never treated as success here.
          dbg('release:record-vanished', { photoId: id })
          return // unresolved -> failedIds
        }
        if (fresh.packId !== packId) return // never another pack's record
        if (fresh.state === 'saved_local' && !fresh.discardRequested) {
          dbg('release:caption-order-unproven', { photoId: id })
          return // unresolved -> failedIds, record + shadow kept
        }
        rec = fresh
      }
      if (carry && carryApplies) {
        // IDENTITY PROOF for the carried release caption (same rule as
        // reconcile): resolved only if the record holds EXACTLY that edit.
        if (!rec || !shadowSatisfied(rec, carry.shadow)) {
          if (rec && (rec.noteEditedAt ?? 0) >= carry.v) {
            bumpHighWater(packId, id, rec.noteEditedAt ?? 0)
          }
          dbg('release:caption-unproven', { photoId: id })
          return // unresolved -> failedIds, shadow kept
        }
        clearNoteShadowIfIdentity(packId, id, carry.editId)
      }
      resolved.add(id)
    } catch (err) {
      dbg('release:failed', {
        photoId: id,
        detail: err instanceof Error ? err.message : 'release failed',
      })
    }
  })
  try {
    await withDeadline(work, RELEASE_TOTAL_BUDGET_MS, 'Releasing photos')
  } catch (err) {
    budgetClosed.current = true
    dbg('release:budget-exceeded', {
      detail: err instanceof Error ? err.message : 'release budget exceeded',
    })
    // LATE SETTLEMENT (hotfix): claims already in flight keep running after
    // we stop waiting. When they settle, refresh the UI's view and wake the
    // drain so a late release is picked up at once. Never an unhandled
    // rejection; a late success is still never reported as proven here.
    void work
      .catch(() => undefined)
      .then(() => refreshQueue(packId))
      .catch(() => undefined)
      .then(() => drainQueue(packId))
      .catch(() => undefined)
  }

  // With an intended set, an intended id that never appeared in the listing
  // is never resolved, so it is reported (rev 8). Object.keys is unique.
  const failedIds = (intended ?? ids).filter((id) => !resolved.has(id))
  try {
    await refreshQueue(packId)
  } catch {
    // best-effort; drain refreshes again
  }
  void drainQueue(packId)
  return { failedIds }
}

/**
 * CAPTION DURABILITY (P0, 22 Oct 2026; rev 4). Persist a capture-screen
 * caption edit into the photo's durable IndexedDB record. Atomic (CAS claim)
 * and strictly-newer-wins (see noteEditDecision). Returns true ONLY when the
 * record provably holds EXACTLY this edit afterwards (identity). The shadow
 * is cleared only if it is still this same edit — a stale completion can
 * never clear a newer shadow.
 */
export async function updateQueuedNote(
  packId: string,
  photoId: string,
  note: string | null,
  editedAtMs: number,
  editId: string,
): Promise<boolean> {
  try {
    const updated = await claimQueuedPhoto(photoId, (cur) =>
      cur.packId === packId ? noteEditDecision(cur, note, editedAtMs, editId) : null,
    )
    if (updated !== null && shadowSatisfied(updated, { note, v: editedAtMs, editId })) {
      clearNoteShadowIfIdentity(packId, photoId, editId)
      return true
    }
    return false
  } catch (err) {
    dbg('note:persist-failed', {
      photoId,
      detail: err instanceof Error ? err.message : 'note persist failed',
    })
    return false
  }
}

/**
 * CAPTION SHADOW RECONCILE (rev 4 — IDENTITY PROOF, FAIL CLOSED). Fold every
 * synchronously-persisted capture caption shadow for this pack into its
 * photo's IndexedDB record. Runs at the top of drainQueue and releaseQueued.
 *
 * A shadow is cleared ONLY when the durable record holds EXACTLY its edit
 * (identity + version + text). Returns the photo ids whose shadow could NOT
 * be proven durable — callers must not carry those photos' captions forward.
 *
 *   - durable record already at an equal-or-higher version with a DIFFERENT
 *     identity: order cannot be proven -> shadow KEPT, photo BLOCKED, and the
 *     persisted high-water mark is raised so the inspector's NEXT edit
 *     provably outranks it (recovery by a deliberate human edit, never by
 *     discarding text);
 *   - record missing: shadow KEPT (absence is not proof), nothing blocked;
 *   - scope mismatch: never applied, KEPT, not blocking.
 */
export async function reconcileNoteShadows(
  packId: string,
  /** Hotfix (one-tap attach): shadows that ARE a release edit the caller
   *  applies and proves inside its own release claim — skipped here so the
   *  photo is not rewritten twice. Matched by exact edit identity. */
  carriedByRelease?: ReadonlyMap<string, { editId: string }>,
): Promise<{ blocked: string[] }> {
  const blocked: string[] = []
  for (const s of readNoteShadows(packId)) {
    if (carriedByRelease?.get(s.photoId)?.editId === s.editId) continue
    try {
      let rec = await getQueuedPhoto(s.photoId)
      if (!rec) continue
      if (!shadowScopeMatches(rec, s, packId)) continue
      if (!shadowSatisfied(rec, s)) {
        await claimQueuedPhoto(s.photoId, (cur) =>
          shadowScopeMatches(cur, s, packId)
            ? noteEditDecision(cur, s.note, s.v, s.editId)
            : null,
        )
        rec = await getQueuedPhoto(s.photoId) // VERIFY — never trust the claim's null
      }
      if (rec && shadowSatisfied(rec, s)) {
        clearNoteShadowIfIdentity(packId, s.photoId, s.editId)
      } else {
        if (rec && (rec.noteEditedAt ?? 0) >= s.v) {
          bumpHighWater(packId, s.photoId, rec.noteEditedAt ?? 0)
        }
        blocked.push(s.photoId) // not provably durable: fail closed
      }
    } catch (err) {
      dbg('note:shadow-reconcile-failed', {
        photoId: s.photoId,
        detail: err instanceof Error ? err.message : 'shadow reconcile failed',
      })
      blocked.push(s.photoId) // keep the shadow: it is still the only durable copy
    }
  }
  return { blocked }
}

/** Refuse — never truncate — an over-limit caption at the attach boundary. */
export function assertAttachCaptionWithinLimit(note: string | null | undefined): void {
  if (captionTooLong(note)) {
    throw new Error('Caption is longer than 2,000 characters — shorten it to attach this photo')
  }
}

/**
 * ATTACH-BOUNDARY CAPTION GATE (rev 4). Called by BOTH attach paths right
 * after the worker claims a record and BEFORE the caption is sent. If the
 * photo's current shadow is not exactly what the record holds, it is applied
 * under the worker's OWN lease — only when strictly newer — and verified by
 * identity. Otherwise this THROWS: the attach fails closed into the ordinary
 * failed/backoff path with the shadow kept.
 */
export async function captionGateForAttach(
  packId: string,
  rec: QueuedPhotoRecord,
): Promise<QueuedPhotoRecord> {
  const s = readNoteShadow(packId, rec.id)
  if (!s || !shadowScopeMatches(rec, s, packId) || shadowSatisfied(rec, s)) return rec
  const lease = rec.leaseUntil ?? null
  const updated = await claimQueuedPhoto(rec.id, (cur) =>
    (cur.leaseUntil ?? null) === lease &&
    cur.state === rec.state &&
    !cur.discardRequested &&
    s.v > (cur.noteEditedAt ?? 0)
      ? { note: s.note, noteEditedAt: s.v, noteEditId: s.editId }
      : null,
  )
  // A null claim proves nothing either way: re-read and VERIFY identity.
  const proven =
    updated ??
    (await getQueuedPhoto(rec.id).then((fresh) =>
      fresh && (fresh.leaseUntil ?? null) === lease && fresh.state === rec.state ? fresh : null,
    ))
  if (!proven || !shadowSatisfied(proven, s)) {
    if (proven && (proven.noteEditedAt ?? 0) >= s.v) {
      bumpHighWater(packId, rec.id, proven.noteEditedAt ?? 0)
    }
    throw new Error('Caption changed on this device and is not saved yet — retrying')
  }
  return proven
}

/** Explicit "Try again": reset failed records so the worker picks them up
 *  immediately. The attempts counter RESETS here — a human deliberately
 *  retrying deserves a fresh quiet-retry budget, not an instant re-exhaust. */
export async function retryFailed(packId: string): Promise<void> {
  const records = await listQueuedForPack(packId)
  for (const r of records) {
    if (r.state === 'failed') {
      await patchQueuedPhoto(r.id, {
        state: 'queued',
        lastError: null,
        lastAttemptAt: null,
        attempts: 0,
        leaseUntil: null,
      })
    }
  }
  await refreshQueue(packId)
  void drainQueue(packId)
}

/**
 * A bare `fetch` / server action waits FOREVER. On a phone that hands off from
 * WiFi to LTE mid-request the socket simply never answers, and before these
 * bounds the worker sat inside uploadOne indefinitely: `running` never cleared,
 * so every later resume trigger hit the `running.has(packId)` guard and did
 * nothing. Switching apps and back could not recover it. Bounding every network
 * call converts that permanent freeze into an ordinary retryable failure.
 */
const PUT_TIMEOUT_MS = 45_000
const ACTION_TIMEOUT_MS = 30_000

/**
 * Bound a promise that cannot be aborted (server actions). The underlying call
 * may still complete on the server — that is safe here because every step is
 * keyed by the same logical photo uuid and is idempotent on replay (slot reuse,
 * relationship verification, PK 23505 handling).
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out — will retry automatically`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** PUT one storage object, bounded. Create-only duplicates CONVERGE:
 *  409, or Supabase's 400 with a "resource already exists"/"Duplicate" body,
 *  both mean the bytes already landed from a prior attempt — success. */
async function putObject(signedUrl: string, blob: Blob, label: string): Promise<void> {
  // AbortController (not just a race) so the dead socket is actually released
  // rather than left pinned while the retry opens another one.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PUT_TIMEOUT_MS)
  try {
    const res = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
      signal: controller.signal,
    })
    if (!res.ok && res.status !== 409) {
      // Supabase signed-upload duplicates answer 400, not 409 (P0, 22 Jul
      // night: "The resource already exists" treated as fatal in the field).
      const body = await res.text().catch(() => '')
      if (/already exists|duplicate/i.test(body)) return
      throw new Error(`${label} upload failed (${res.status})`)
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`${label} upload timed out — will retry automatically`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Intent + slot. The SAME uuid always returns the same relationship and paths,
 * so a lost response or a repeat call never creates a second photo.
 */
async function requestSlot(record: QueuedPhotoRecord): Promise<UploadSlot> {
  const slot = (await withTimeout(
    requestPhotoUploadSlot({
      propertyId: record.propertyId,
      flagId: null,
      evidencePackId: record.packId,
      photoId: record.id,
    }),
    ACTION_TIMEOUT_MS,
    'Preparing upload',
  )) as UploadSlot | { ok: false; error: string }
  if (!slot.ok) throw new Error(slot.error)
  return slot
}

/**
 * DISCARD REQUEST (durable). The UI never deletes a queue record directly —
 * removal persists this flag FIRST, then the worker owns cleanup. This is
 * what closes the remove-vs-staging race: any in-flight work for the photo
 * aborts at its next awaited boundary, and no new intent can be created
 * (nextStageable / nextUploadable both exclude discard-requested records).
 */
export async function requestDiscard(
  packId: string,
  photoId: string,
  reason: string,
): Promise<void> {
  const rec = await getQueuedPhoto(photoId)
  if (!rec || rec.packId !== packId) return
  await patchQueuedPhoto(photoId, {
    discardRequested: true,
    discardReason: reason,
    lastError: null,
    attempts: 0,
    lastAttemptAt: null,
  })
  await refreshQueue(packId)
  void drainQueue(packId)
}

/**
 * Resolve a discard request: server first, device second.
 *
 * The server call is UNCONDITIONAL — even for a photo whose slot RPC seems
 * never to have run. `intentRequested` in IndexedDB cannot prove no intent
 * exists (another tab, an interrupted request, a delayed packet). The RPC
 * writes a durable cancellation tombstone when no intent exists (migration
 * 20260721090000), and slot creation / attach reject tombstoned ids
 * atomically — THAT is what closes the race, not any client-side check.
 * The local record is deleted ONLY after the server confirms the durable
 * 'discarded' state. On failure/offline it stays visible as "Removing…" and
 * retries — a hidden, half-cleaned photo is exactly the debris this prevents.
 */
async function discardOne(record: QueuedPhotoRecord): Promise<void> {
  const res = await withTimeout(
    discardStagedPhotoIntent({
      propertyId: record.propertyId,
      photoId: record.id,
      evidencePackId: record.packId,
      reason: record.discardReason ?? 'Removed by inspector during capture',
    }),
    ACTION_TIMEOUT_MS,
    'Removing photo',
  )
  if (!res.ok) {
    // ATTACH WON the ordering: both are legal, and we do not pretend
    // cancellation always wins. The server refused the discard because the
    // photo is COMPLETED — i.e. it is attached, storage-verified evidence in
    // the pack. Terminal, visible, honest reconciliation: stop "Removing…",
    // count it as saved, refresh so it appears in the pack's photo list
    // (draft pack photos are immutable by design, so there is no quiet
    // delete path — the inspector sees it among the pack photos, which is
    // the truth). Retrying the discard forever would hide an attached photo
    // behind a spinner.
    if (/already saved and cannot be discarded/i.test(res.error)) {
      await deleteQueuedPhoto(record.id)
      packCapture.mark(record.packId, record.id, 'saved')
      setState(record.packId, { serverRefreshNeeded: true })
      await refreshQueue(record.packId)
      return
    }
    throw new Error(res.error)
  }
  // Confirmed CANCELLATION — ledger it BEFORE deleting so the Done gate can
  // never mistake this deletion for an attachment.
  recordDiscarded(record.packId, record.id)
  await deleteQueuedPhoto(record.id)
  // The inspector removed this photo: its caption shadow is moot.
  removeNoteShadow(record.packId, record.id)
  removeHighWater(record.packId, record.id)
  await refreshQueue(record.packId)
}

/**
 * Cross-tab convergence: the server said this photo was cancelled/discarded
 * (errcode 22023 paths raise with "discarded" in the message). This tab's
 * record is stale — route it into the discard path, whose server call is
 * idempotent ('already_discarded') and then deletes the local copy.
 */
function isCancelledByServer(message: string): boolean {
  // create_prearrival_photo_intent: 'photo intent % was discarded; capture a new photo'
  // attach_prearrival_photo:        'photo intent % was discarded'
  return /was discarded/i.test(message)
}

/** Re-read a record between awaited boundaries. null = stop all work on it. */
async function freshOrAbort(photoId: string): Promise<QueuedPhotoRecord | null> {
  const rec = await getQueuedPhoto(photoId)
  if (!rec || rec.discardRequested) return null
  return rec
}

/** Await BOTH branches, then fail if either did. A retry must never overlap a
 *  still-running previous branch, so nothing is left running on throw. */
async function putBothSettled(
  slot: UploadSlot,
  record: QueuedPhotoRecord,
): Promise<void> {
  // A null upload = the server VERIFIED the object already exists at its
  // deterministic path — nothing to send for it (per-object: master may be
  // present while the thumb still needs its bytes).
  const results = await Promise.allSettled([
    slot.masterUpload
      ? putObject(slot.masterUpload.signedUrl, record.master, 'Photo')
      : Promise.resolve(),
    slot.thumbUpload
      ? putObject(slot.thumbUpload.signedUrl, record.thumb, 'Thumbnail')
      : Promise.resolve(),
  ])
  const firstRejected = results.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  )
  if (firstRejected) {
    throw firstRejected.reason instanceof Error
      ? firstRejected.reason
      : new Error(String(firstRejected.reason))
  }
}

/**
 * UPLOAD EARLY: push both storage objects for an UNRELEASED photo while the
 * inspector is still shooting/reviewing. On success the record stays
 * `saved_local` (not attached, still discardable) but carries bytesStaged +
 * the slot paths, so the later attach is a single fast RPC.
 *
 * discardRequested is re-checked after awaited boundaries as DEFENCE IN
 * DEPTH — it stops most wasted work early, but it cannot close the removal
 * race (a request already in flight can land after any client check). The
 * actual guarantee is server-side: the cancellation tombstone (migration
 * 20260721090000) makes slot creation and attach reject a removed photo
 * atomically, whatever this client believed.
 */
async function stageOne(picked: QueuedPhotoRecord): Promise<void> {
  // ATOMIC staging claim: lease only, state stays `saved_local` so the photo
  // remains discardable. Two tabs staging the same capture: one wins.
  const record = await claimQueuedPhoto(picked.id, (r) =>
    claimForStagingDecision(r, Date.now()),
  )
  if (!record) return
  // OUR exact lease identity — the only proof of ownership at finalisation.
  const myLease = record.leaseUntil ?? null
  let slot: UploadSlot
  try {
    // From here an intent MAY exist even if the slot response is lost.
    await patchQueuedPhoto(record.id, { intentRequested: true })
    slot = await timed('stage:slot', record.id, () => requestSlot(record))

    if (!(await freshOrAbort(record.id))) return
    await timed('stage:put', record.id, () => putBothSettled(slot, record))
  } catch (err) {
    // Failure bookkeeping REQUIRES ownership: identity-checked inside the
    // claim, so a stale attempt whose record moved on writes nothing.
    const message = err instanceof Error ? err.message : 'Upload failed.'
    await claimQueuedPhoto(record.id, (cur) =>
      stageFailureDecision(cur, message, Date.now(), myLease),
    )
    throw err
  }

  // STALE-SAFE finalisation: release may have revoked our ownership while
  // the PUTs ran. The staged facts (bytes on server + paths) are recorded
  // whatever the current state — they are true and only help the fast path —
  // but the lease is cleared ONLY if the record is still saved_local; in any
  // other state it belongs to a new owner. Removed records get nothing.
  await claimQueuedPhoto(record.id, (cur) =>
    stageFinalizeDecision(
      cur,
      {
        masterPath: slot.masterPath,
        thumbPath: slot.thumbPath,
        retentionClass: slot.retentionClass,
      },
      myLease,
    ),
  )
  await refreshQueue(record.packId)
}

async function uploadOne(picked: QueuedPhotoRecord): Promise<void> {
  // ATOMIC CLAIM (single IndexedDB readwrite transaction, serialized across
  // tabs). Picking and claiming are different things: another tab may have
  // claimed this record between our list() and now. Exactly one claimer wins
  // the state change + WORKER LEASE; every other caller gets null and walks
  // away. Every network call below is timeout-bounded, so a live owner always
  // resolves the record before the lease expires — an expired lease is proof
  // of stranding.
  const record = await claimQueuedPhoto(picked.id, (r) =>
    claimForUploadDecision(r, Date.now()),
  )
  if (!record) return
  // REPORT BACK to the in-memory session store. evidence-capture commits every
  // released photo there as 'pending', and that store drives both the status
  // banner and the submit gate. When pack uploads moved out of the modal into
  // this worker, nothing marked those photos saved any more — so a pack the
  // server had stored completely still read "Uploading 3 of 13" and stayed
  // unsubmittable until a page reload. The logical id is the same one
  // ingestBlob minted, so these address the exact same photo. mark() no-ops
  // safely for records this session never committed (e.g. resumed after a
  // reload), which is correct: there is nothing local to unblock.
  packCapture.mark(record.packId, record.id, 'uploading')
  await refreshQueue(record.packId)

  // Fast path: staging already pushed the bytes and kept the slot paths, so
  // only the attach RPC remains. Slow path (unstaged / pre-staging record):
  // full pipeline, exactly as before.
  let masterPath = record.bytesStaged ? (record.masterPath ?? null) : null
  let thumbPath = record.bytesStaged ? (record.thumbPath ?? null) : null
  // Persisted queue records are untyped storage and may predate the
  // retentionClass field (or hold malformed text), so runtime-validate before
  // the value crosses into the typed action. When absent/invalid, the class
  // IS safely derivable from authoritative queue context: this queue holds
  // ONLY pre-arrival pack captures (scope requires packId; flags never
  // enqueue), whose canonical class is PRE_ARRIVAL_RETENTION — the same value
  // requestPhotoUploadSlot issues for pack slots and, decisively, the same
  // value attach_prearrival_photo hard-codes server-side ('routine_pre_
  // arrival', migration 20260718120000) because the server never trusts a
  // client-supplied class for pack photos anyway.
  let retentionClass: RetentionClass = isRetentionClass(record.retentionClass)
    ? record.retentionClass
    : PRE_ARRIVAL_RETENTION
  if (!masterPath || !thumbPath) {
    await patchQueuedPhoto(record.id, { intentRequested: true })
    const slot = await timed('upload:slot', record.id, () => requestSlot(record))
    if (!(await freshOrAbort(record.id))) return
    await timed('upload:put', record.id, () => putBothSettled(slot, record))
    masterPath = slot.masterPath
    thumbPath = slot.thumbPath
    retentionClass = slot.retentionClass
  }

  // Defence in depth before the attach RPC. NOT the guarantee — a removal can
  // still commit between this check and the attach landing. The guarantee is
  // attach_prearrival_photo rejecting state='discarded' under FOR UPDATE.
  if (!(await freshOrAbort(record.id))) return

  // Atomic phase advance: refuses if ownership was lost (e.g. a discard was
  // requested since the upload claim). The lease renews with the phase.
  const claimedForAttach = await claimQueuedPhoto(record.id, (r) =>
    claimForAttachDecision(r, Date.now()),
  )
  if (!claimedForAttach) return
  // CAPTION GATE (rev 3): the newest on-device caption is applied and
  // PROVEN into this record before it is sent — or this attach fails closed.
  const owned = await captionGateForAttach(record.packId, claimedForAttach)
  // LENGTH LIMIT (rev 5): an over-limit caption is REFUSED before it is sent
  // — never truncated. Throwing routes the record into the ordinary
  // failed/backoff path: the photo and its full caption stay on the device.
  assertAttachCaptionWithinLimit(owned.note)
  packCapture.mark(record.packId, record.id, 'attaching')
  await refreshQueue(record.packId)
  // BOUNDARY PROOF: both storage paths must be non-null strings before the
  // attach RPC may run. If either is missing (corrupt/legacy record whose
  // staged paths vanished and whose slot path was skipped), we must NOT
  // attach, NOT delete the record and NOT mark it successful — throwing
  // routes it through the ordinary failed/backoff/quiet-retry handling, and
  // the retry takes the slow path, which re-requests a slot and repopulates
  // the paths. No cast, no non-null assertion.
  const paths = provenAttachPaths(masterPath, thumbPath)
  if (!paths) {
    throw new Error('Photo storage paths missing — retrying with a fresh upload slot')
  }
  // The caption (note) travels INSIDE this attach call; the record is deleted
  // only after the server confirms it. Record-gone ⇒ caption saved.
  const attached = await timed('upload:attach', record.id, () =>
    withTimeout(
      attachEvidencePhoto(
        buildAttachInput(owned, paths.masterPath, paths.thumbPath, retentionClass),
      ),
      ACTION_TIMEOUT_MS,
      'Saving photo',
    ),
  )
  if (!attached.ok) throw new Error(attached.error)

  // ONLY now are the device bytes redundant.
  await deleteQueuedPhoto(record.id)
  // AUTHORITATIVE confirmation: the server holds EXACTLY the caption edit
  // this attach carried. Only a shadow with that same identity is spent.
  clearNoteShadowIfIdentity(record.packId, record.id, owned.noteEditId)
  clearHighWaterIfSettled(record.packId, record.id, owned.noteEditedAt ?? 0)
  // The server has confirmed. This is the call whose absence stuck the banner
  // and the Submit button.
  packCapture.mark(record.packId, record.id, 'saved')
  // Mark the server-rendered linked count stale. We deliberately do NOT
  // refresh per photo — 40 photos would mean 40 server round-trips competing
  // with the uploads. The React binding refreshes ONCE when the drain cycle
  // goes idle.
  setState(record.packId, { serverRefreshNeeded: true })
  await refreshQueue(record.packId)
}

// BOUNDED PARALLELISM (P0 performance, 22 Jul). Concurrency 1 was chosen when
// in-memory bytes made partial writes dangerous; with bytes durable in
// IndexedDB BEFORE any network call and every step claim-owned and idempotent
// by photo uuid, parallel waves are safe — and one slow photo no longer
// serializes the other 39. Constants live in photo-queue-state so the
// acceptance tests prove the REAL values (UPLOAD_CONCURRENCY, ATTACH_BATCH_SIZE).

/** Server says this photo was cancelled elsewhere: converge to the discard
 *  path instead of retrying an upload the server will always reject.
 *  Never throws (see handleWorkError). */
async function convergeCancelled(packId: string, photoId: string): Promise<void> {
  try {
    await patchQueuedPhoto(photoId, {
      discardRequested: true,
      discardReason: 'Cancelled on the server (removed elsewhere)',
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    })
    packCapture.remove(packId, photoId)
    await refreshQueue(packId)
  } catch (err) {
    dbg('converge:failed', {
      photoId,
      detail: err instanceof Error ? err.message : 'converge failed',
    })
  }
}

/** Shared upload/attach failure bookkeeping: quiet retry inside the budget,
 *  one calm surfaced failure at exhaustion, convergence on cancellation.
 *  NEVER THROWS: this runs inside catch paths — if the bookkeeping's own
 *  storage write fails (the deadline-bounded hang), the record simply stays
 *  in its previous state and the reclaim/lease machinery recovers it. A
 *  bookkeeping failure must not become an unhandled rejection. */
async function handleWorkError(
  packId: string,
  record: QueuedPhotoMeta,
  err: unknown,
): Promise<void> {
  try {
    const message = err instanceof Error ? err.message : 'Upload failed.'
    if (isCancelledByServer(message)) {
      await convergeCancelled(packId, record.id)
      return
    }
    const attempts = record.attempts + 1
    await patchQueuedPhoto(record.id, {
      state: 'failed',
      lastError: message,
      attempts,
      lastAttemptAt: Date.now(),
      leaseUntil: null,
    })
    packCapture.mark(
      packId,
      record.id,
      attempts >= MAX_AUTO_RETRY_ATTEMPTS ? 'failed' : 'uploading',
    )
    await refreshQueue(packId)
  } catch (bookErr) {
    dbg('bookkeeping:failed', {
      photoId: record.id,
      detail: bookErr instanceof Error ? bookErr.message : 'bookkeeping failed',
    })
  }
}

/**
 * THE FAST PATH: attach a wave of fully-staged records in ONE phone round
 * trip. Each record is atomically claimed first (exclusive ownership, lease),
 * paths are proven per item, and the server returns PER-PHOTO results — a
 * record is deleted only after ITS OWN confirmed attach, exactly as before.
 * One bad photo fails alone; the rest complete.
 */
async function batchAttachStaged(
  packId: string,
  candidates: QueuedPhotoMeta[],
): Promise<void> {
  const claimed: Array<{
    rec: QueuedPhotoRecord
    input: ReturnType<typeof buildAttachInput<RetentionClass>>
  }> = []
  for (const r of candidates) {
    // EXCEPTION-ISOLATED per candidate (the failed integration proof, 22 Jul
    // late): a deadline-bounded storage hang here used to ESCAPE drainQueue
    // as an unhandled rejection. Now one candidate's storage failure books
    // its own retry and the rest of the wave proceeds.
    try {
      const claimedForBatch = await claimQueuedPhoto(r.id, (cur) =>
        claimForUploadDecision(cur, Date.now()),
      )
      if (!claimedForBatch) continue
      // CAPTION GATE (rev 3): throws (-> this candidate's retry, shadow kept)
      // when a newer on-device caption cannot be proven into the record.
      const c = await captionGateForAttach(packId, claimedForBatch)
      assertAttachCaptionWithinLimit(c.note) // refuse, never truncate (rev 5)
      const paths = provenAttachPaths(c.masterPath ?? null, c.thumbPath ?? null)
      if (!paths) {
        // Staged facts vanished between pick and claim: hand back to the slow
        // path (full pipeline re-derives them). Never attach unproven paths.
        await claimQueuedPhoto(c.id, (cur) =>
          cur.state === 'uploading' ? { state: 'queued', leaseUntil: null } : null,
        )
        continue
      }
      const retention = isRetentionClass(c.retentionClass)
        ? c.retentionClass
        : PRE_ARRIVAL_RETENTION
      claimed.push({
        rec: c,
        input: buildAttachInput(c, paths.masterPath, paths.thumbPath, retention),
      })
      packCapture.mark(packId, c.id, 'attaching')
    } catch (err) {
      await handleWorkError(packId, r, err)
    }
  }
  if (claimed.length === 0) return
  await refreshQueue(packId)

  let res: Awaited<ReturnType<typeof attachEvidencePhotosBatch>>
  try {
    res = await timed('upload:attach-batch', null, () =>
      withTimeout(
        attachEvidencePhotosBatch(claimed.map((x) => x.input)),
        ACTION_TIMEOUT_MS,
        'Saving photos',
      ),
    )
  } catch (err) {
    for (const { rec } of claimed) await handleWorkError(packId, rec, err)
    return
  }
  if (!res.ok) {
    const err = new Error(res.error)
    for (const { rec } of claimed) await handleWorkError(packId, rec, err)
    return
  }
  // PURE, TESTED matching (proofs 5–8): confirmed-only deletion, per-id
  // failure isolation, and a missing result fails CLOSED (retry-safe: the
  // attach RPC replays idempotently by photo uuid).
  const outcome = resolveBatchOutcomes(
    claimed.map((x) => x.rec.id),
    res.results,
  )
  const byRec = new Map(claimed.map((x) => [x.rec.id, x.rec]))
  for (const id of outcome.attached) {
    // ITS OWN server confirmation — only now are the device bytes redundant.
    // Exception-isolated: if the local delete itself hits a storage hang,
    // the record survives, gets re-picked, and the server's idempotent
    // already_completed replay resolves it — never an escaped rejection.
    try {
      await deleteQueuedPhoto(id)
      // AUTHORITATIVE confirmation of the exact caption edit this attach carried.
      clearNoteShadowIfIdentity(packId, id, byRec.get(id)?.noteEditId)
      clearHighWaterIfSettled(packId, id, byRec.get(id)?.noteEditedAt ?? 0)
      packCapture.mark(packId, id, 'saved')
      setState(packId, { serverRefreshNeeded: true })
    } catch (err) {
      dbg('post-attach-delete:failed', {
        photoId: id,
        detail: err instanceof Error ? err.message : 'delete failed',
      })
    }
  }
  for (const f of outcome.failed) {
    const rec = byRec.get(f.id)
    if (rec) await handleWorkError(packId, rec, new Error(f.error))
  }
  await refreshQueue(packId)
}

/** One pending wake-up per pack. Replaced, never stacked. */
const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearRetryWake(packId: string): void {
  const existing = wakeTimers.get(packId)
  if (existing) {
    clearTimeout(existing)
    wakeTimers.delete(packId)
  }
}

/**
 * Book the single timer that brings the worker back for a backed-off record.
 * This is not polling: at most one timer exists per pack, it is only set when
 * a record is genuinely waiting, and it stops entirely at the auto-retry cap.
 */
function scheduleRetryWake(packId: string): void {
  clearRetryWake(packId)
  // Offline: the `online` listener is the correct trigger. Scheduling here
  // would spin, because drainQueue exits immediately while offline.
  if (!isOnline()) return
  const due = msUntilNextRetry(states.get(packId)?.records ?? [], Date.now())
  if (due === null) return
  // Floor the delay so a zero can never become a tight loop.
  const timer = setTimeout(() => {
    wakeTimers.delete(packId)
    void drainQueue(packId)
  }, Math.max(due, 250))
  wakeTimers.set(packId, timer)
}

/** Drain the pack's queue sequentially. Safe to call repeatedly. */
export async function drainQueue(packId: string): Promise<void> {
  if (running.has(packId)) return
  running.add(packId)
  // We are running now; any pending wake-up is redundant and is re-booked in
  // the finally below if it is still needed.
  clearRetryWake(packId)
  setState(packId, { draining: true })
  try {
    // CAPTION SHADOWS FIRST (P0 blocker review, 22 Oct 2026): fold any
    // synchronously-persisted capture caption shadows into their IndexedDB
    // records before any upload/attach work can carry a caption forward.
    await reconcileNoteShadows(packId)
    // RECLAIM STRANDED WORK FIRST. Records left in `uploading`/`attaching`
    // by a killed page were previously invisible to every picker and stalled
    // forever while the UI said "Uploading N photos…". Reclaim ONLY records
    // whose worker lease has expired — a fresh lease means a live worker
    // (possibly another tab) owns the record and must not be disturbed. Safe
    // because the whole pipeline is idempotent by the stable photo uuid: a
    // late response from the dead attempt can only 409/replay-verify.
    {
      const stranded = reclaimableRecords(
        (await listQueuedForPack(packId)).map((r) => r),
        Date.now(),
      )
      let reclaimed = 0
      for (const r of stranded) {
        // Atomic: re-checks staleness inside the transaction, so a worker
        // that re-leased the record between our list and now is respected.
        // Exception-isolated: one hung reclaim must not stop the others.
        try {
          const got = await claimQueuedPhoto(r.id, (cur) =>
            reclaimDecision(cur, Date.now()),
          )
          if (got) {
            reclaimed += 1
            dbg('reclaimed-stranded', { photoId: r.id, detail: r.state })
          }
        } catch (err) {
          dbg('reclaim:failed', {
            photoId: r.id,
            detail: err instanceof Error ? err.message : 'reclaim failed',
          })
        }
      }
      if (reclaimed > 0) await refreshQueue(packId)
    }
    for (;;) {
      if (!isOnline()) break
      const all = await listQueuedForPack(packId)

      // Cleanup first: a photo the inspector removed blocks the pack until
      // the server confirms no intent survives, so it outranks everything.
      const disc = nextDiscardable(all, Date.now())
      if (disc) {
        const record = all.find((r) => r.id === disc.id)
        if (!record) continue
        try {
          await discardOne(record)
        } catch (err) {
          // Keep the record VISIBLE and retryable — never hide half-done
          // cleanup from the inspector. Backoff prevents hammering. The
          // bookkeeping itself is best-effort: if IT hits a storage hang the
          // record stays as-is and the next resume retries the discard.
          try {
            await patchQueuedPhoto(record.id, {
              lastError: err instanceof Error ? err.message : 'Could not remove photo.',
              attempts: record.attempts + 1,
              lastAttemptAt: Date.now(),
            })
            await refreshQueue(packId)
          } catch (bookErr) {
            dbg('discard-bookkeeping:failed', {
              photoId: record.id,
              detail: bookErr instanceof Error ? bookErr.message : 'failed',
            })
          }
        }
        continue
      }

      // Released work next: the inspector is actively finishing the pack.
      const uploadables = uploadableRecords(all, Date.now())
      if (uploadables.length > 0) {
        // FAST PATH — BATCH ATTACH. Staged records need only the attach RPC,
        // and each attach used to be its own phone round trip: 40 photos =
        // 40 × mobile RTT = minutes. Batch them into ONE round trip; the
        // per-photo RPCs run server-side where latency is milliseconds.
        const staged = uploadables.filter(
          (r) => r.bytesStaged && r.masterPath && r.thumbPath,
        )
        if (staged.length > 0) {
          await batchAttachStaged(packId, staged.slice(0, ATTACH_BATCH_SIZE))
          continue
        }
        // SLOW PATH — unstaged released photos still need their bytes pushed.
        // Bounded parallelism: one slow photo must not serialize the rest.
        const wave = uploadables.slice(0, UPLOAD_CONCURRENCY)
        await Promise.all(
          wave.map(async (record) => {
            try {
              await uploadOne(record)
            } catch (err) {
              await handleWorkError(packId, record, err)
            }
          }),
        )
        continue
      }

      // No released work: stage bytes for unreleased captures in the
      // background — in parallel — so Attach is near-instant when tapped.
      const stageWave = stageableRecords(all, Date.now()).slice(0, UPLOAD_CONCURRENCY)
      if (stageWave.length === 0) break
      await Promise.all(
        stageWave.map(async (record) => {
          try {
            await stageOne(record)
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Upload failed.'
            if (isCancelledByServer(message)) {
              await convergeCancelled(packId, record.id)
              return
            }
            // Failure bookkeeping already happened inside stageOne under its
            // own lease identity (a stale attempt writes nothing). Staging
            // remains an accelerator, never a gate.
          }
        }),
      )
      await refreshQueue(packId)
    }
  } catch (err) {
    // NOTHING ESCAPES drainQueue (audit, 22 Jul late). Callers fire it with
    // `void drainQueue(...)` — an escaped rejection is unhandled and, in the
    // failed integration proof, exactly what happened when a storage hang
    // slipped through batchAttachStaged. Every inner path now isolates its
    // own failures; this is the belt for anything unforeseen. Recovery is
    // the finally's job either way.
    dbg('drain:crashed', {
      detail: err instanceof Error ? err.message : 'drain crashed',
    })
  } finally {
    // EXCEPTION-SAFE ORDERING (audit requirement 2): guard release and
    // draining:false are synchronous and run FIRST, so no awaited cleanup
    // step can prevent them. Each awaited/throwing step is then isolated so
    // recovery scheduling ALWAYS happens last.
    running.delete(packId)
    setState(packId, { draining: false })
    try {
      await refreshQueue(packId)
    } catch (err) {
      dbg('final-refresh:failed', {
        detail: err instanceof Error ? err.message : 'refresh failed',
      })
    }
    // A record inside its backoff window makes the loop above exit. Book the
    // one timer that brings the worker back, otherwise it waits for a mount /
    // pageshow / visibility / online event that may never come while the
    // inspector is looking straight at the page.
    try {
      scheduleRetryWake(packId)
    } catch (err) {
      dbg('wake-schedule:failed', {
        detail: err instanceof Error ? err.message : 'wake failed',
      })
    }
  }
}

export const photoQueue = {
  /**
   * Atomically CLAIM the stale-server signal. Returns true only to the first
   * caller; every later caller gets false. Reading the live store (not a
   * render snapshot) is what stops two mounted panels for the same pack from
   * each firing a refresh in the same commit, and stops a remount replaying it.
   */
  claimServerRefresh(packId: string): boolean {
    if (!states.get(packId)?.serverRefreshNeeded) return false
    setState(packId, { serverRefreshNeeded: false })
    return true
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
  snapshot(packId: string): PackQueueState {
    return states.get(packId) ?? EMPTY
  },
}

/**
 * Subscribe to a pack's queue and resume it automatically on mount, BFCache
 * restore, tab visibility (returning from a phone call) and reconnect.
 */
export function usePackQueue(packId: string): PackQueueState & {
  describe: ReturnType<typeof describeQueue>
} {
  const router = useRouter()
  const state = useSyncExternalStore(
    photoQueue.subscribe,
    () => photoQueue.snapshot(packId),
    () => EMPTY,
  )

  // ONE server refresh per completed drain cycle — not one per photo. We wait
  // until the worker is idle (which includes a cycle that ended with some
  // failures), acknowledge the signal FIRST so a remount cannot retrigger it,
  // then pull fresh server data so the linked count updates live.
  useEffect(() => {
    if (!state.serverRefreshNeeded || state.draining) return
    // Claim first — only the winner refreshes.
    if (!photoQueue.claimServerRefresh(packId)) return
    router.refresh()
  }, [state.serverRefreshNeeded, state.draining, packId, router])

  useEffect(() => {
    let cancelled = false
    const resume = () => {
      if (cancelled) return
      void refreshQueue(packId).then(() => {
        if (!cancelled) void drainQueue(packId)
      })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') resume()
    }
    const onOnline = () => {
      setState(packId, { online: true })
      resume()
    }
    const onOffline = () => setState(packId, { online: false })

    resume()
    window.addEventListener('pageshow', resume)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.removeEventListener('pageshow', resume)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [packId])

  return { ...state, describe: describeQueue(state.summary, state.online) }
}
