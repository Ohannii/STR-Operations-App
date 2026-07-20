'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import {
  attachEvidencePhoto,
  requestPhotoUploadSlot,
  type UploadSlot,
} from '@/app/properties/[id]/photos/actions'
import {
  deleteQueuedPhoto,
  listQueuedForPack,
  patchQueuedPhoto,
  putQueuedPhoto,
  requestPersistentStorage,
  type QueuedPhotoRecord,
} from '@/lib/photos/photo-queue-db'
import {
  describeQueue,
  nextUploadable,
  summarizeQueue,
  type QueueSummary,
  type QueuedPhotoMeta,
} from '@/lib/photos/photo-queue-state'

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
}

const EMPTY_SUMMARY: QueueSummary = {
  total: 0,
  savedLocal: 0,
  queued: 0,
  uploading: 0,
  attaching: 0,
  failed: 0,
  blocking: false,
}

const EMPTY: PackQueueState = {
  records: [],
  summary: EMPTY_SUMMARY,
  online: true,
  storageError: null,
  serverRefreshNeeded: false,
  draining: false,
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

/** Release saved-but-unqueued photos (and update notes) for upload. */
export async function releaseQueued(
  packId: string,
  notesById?: Record<string, string | null>,
): Promise<void> {
  const records = await listQueuedForPack(packId)
  for (const r of records) {
    if (r.state === 'saved_local') {
      await patchQueuedPhoto(r.id, {
        state: 'queued',
        note: notesById?.[r.id] ?? r.note,
      })
    }
  }
  await refreshQueue(packId)
  void drainQueue(packId)
}

/** Reset failed records so the worker picks them up immediately. */
export async function retryFailed(packId: string): Promise<void> {
  const records = await listQueuedForPack(packId)
  for (const r of records) {
    if (r.state === 'failed') {
      await patchQueuedPhoto(r.id, { state: 'queued', lastError: null, lastAttemptAt: null })
    }
  }
  await refreshQueue(packId)
  void drainQueue(packId)
}

async function uploadOne(record: QueuedPhotoRecord): Promise<void> {
  await patchQueuedPhoto(record.id, { state: 'uploading' })
  await refreshQueue(record.packId)

  // 1+2. Intent + slot. The SAME uuid always returns the same relationship and
  // paths, so a lost response never creates a second photo.
  const slot = (await requestPhotoUploadSlot({
    propertyId: record.propertyId,
    flagId: null,
    evidencePackId: record.packId,
    photoId: record.id,
  })) as UploadSlot | { ok: false; error: string }
  if (!slot.ok) throw new Error(slot.error)

  // 3+4. Sequential PUTs. Create-only storage: 409 means the object already
  // landed from a previous attempt, which is success for our purposes.
  const put = async (signedUrl: string, blob: Blob, label: string) => {
    const res = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    })
    if (!res.ok && res.status !== 409) {
      throw new Error(`${label} upload failed (${res.status})`)
    }
  }
  await put(slot.masterUpload.signedUrl, record.master, 'Photo')
  await put(slot.thumbUpload.signedUrl, record.thumb, 'Thumbnail')

  // 5. Atomic attach.
  await patchQueuedPhoto(record.id, { state: 'attaching' })
  await refreshQueue(record.packId)
  const attached = await attachEvidencePhoto({
    photoId: slot.photoId,
    propertyId: record.propertyId,
    flagId: null,
    evidencePackId: slot.evidencePackId,
    masterPath: slot.masterPath,
    thumbPath: slot.thumbPath,
    width: record.width,
    height: record.height,
    sizeBytes: record.sizeBytes,
    capturedAt: record.capturedAt,
    note: record.note,
    retentionClass: slot.retentionClass,
  })
  if (!attached.ok) throw new Error(attached.error)

  // 6. ONLY now are the device bytes redundant.
  await deleteQueuedPhoto(record.id)
  // Mark the server-rendered linked count stale. We deliberately do NOT
  // refresh per photo — 40 photos would mean 40 server round-trips competing
  // with the uploads. The React binding refreshes ONCE when the drain cycle
  // goes idle.
  setState(record.packId, { serverRefreshNeeded: true })
  await refreshQueue(record.packId)
}

/** Drain the pack's queue sequentially. Safe to call repeatedly. */
export async function drainQueue(packId: string): Promise<void> {
  if (running.has(packId)) return
  running.add(packId)
  setState(packId, { draining: true })
  try {
    for (;;) {
      if (!isOnline()) break
      const all = await listQueuedForPack(packId)
      const meta = nextUploadable(all, Date.now())
      if (!meta) break
      const record = all.find((r) => r.id === meta.id)
      if (!record) break
      try {
        await uploadOne(record)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed.'
        await patchQueuedPhoto(record.id, {
          state: 'failed',
          lastError: message,
          attempts: record.attempts + 1,
          lastAttemptAt: Date.now(),
        })
        await refreshQueue(packId)
        // Stop this pass; a resume trigger or Retry will pick it up again.
        break
      }
    }
  } finally {
    running.delete(packId)
    await refreshQueue(packId)
    // Cycle is idle — including a cycle that ended with some photos failed.
    // This is what releases the single server refresh.
    setState(packId, { draining: false })
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
