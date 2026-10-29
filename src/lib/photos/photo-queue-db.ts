'use client'

import type { QueuedPhotoMeta, QueuedPhotoState } from '@/lib/photos/photo-queue-state'
import { DeadlineError, withDeadline } from '@/lib/util/deadline'

/**
 * App-private durable store for captured pre-arrival photos (Outcome 3).
 *
 * Native IndexedDB only — no library, no service worker, no polling. Blobs are
 * stored inside the origin's IndexedDB, which is private to this web app: they
 * are NOT written to the phone's camera roll or gallery and are not readable by
 * other apps or sites.
 *
 * A record is removed ONLY after the server confirms the photo is attached, or
 * after an explicit audited discard. There is deliberately NO TTL sweep, no
 * sign-out purge and no navigation/modal cleanup — silently deleting unresolved
 * evidence is exactly the failure this layer exists to prevent.
 */

const DB_NAME = 'dropinn-evidence'
const DB_VERSION = 1
const STORE = 'queued_photos'
const IDX_PACK = 'by_pack'

/**
 * Every IndexedDB operation is bounded (P0, 22 Jul evening): iOS Safari can
 * hang a transaction forever without firing oncomplete OR onabort, which
 * froze releaseQueued (Attach stuck on "0/25 done" for minutes) and froze
 * drain workers while they held the running guard, blocking every automatic
 * resume until a manual refresh. 8s is far beyond any honest local storage
 * operation; a breach means the WebKit hang, and the caller's existing
 * failure handling takes over. On timeout the cached connection is also
 * dropped so the next operation opens a FRESH one — the known workaround
 * that unsticks Safari's IDB.
 */
const IDB_OP_TIMEOUT_MS = 8000
let idbOpTimeoutMs = IDB_OP_TIMEOUT_MS

/**
 * TEST-ONLY: shrink the operation deadline so behavioural tests can exercise
 * the timeout/late-success path in milliseconds instead of 8 seconds.
 * Production code never calls this.
 */
export function __setIdbOpTimeoutForTests(ms: number): void {
  idbOpTimeoutMs = ms
}

/**
 * TEST-ONLY: restore the production timeout AND drop/close any cached
 * connection so module state cannot leak between tests. Production code
 * never calls this.
 */
export function __resetDbForTests(): void {
  idbOpTimeoutMs = IDB_OP_TIMEOUT_MS
  dropCachedDb()
}

export type QueuedPhotoRecord = QueuedPhotoMeta & {
  master: Blob
  thumb: Blob
}

export class PhotoQueueUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhotoQueueUnavailableError'
  }
}

/**
 * ONE cached connection per JS context (P0, 22 Jul evening). The previous
 * open-per-operation pattern churned dozens of connection open/close cycles
 * during a 25-photo release+drain — exactly the workload that provokes the
 * Safari IndexedDB hang. The connection is opened lazily, reused, and
 * dropped on close/error/timeout so the next operation reopens fresh.
 */
let cachedDb: IDBDatabase | null = null
let opening: Promise<IDBDatabase> | null = null
/**
 * OPEN-ATTEMPT GENERATION (audit item 4, 22 Jul late). A timed-out
 * indexedDB.open() request can still fire onsuccess LATER; without an
 * identity check that late success would re-cache the very connection the
 * timeout just condemned — resurrecting the stuck state. Every drop bumps
 * the generation; an open attempt may only adopt its connection if the
 * generation is unchanged since the attempt began (isCurrentOpenAttempt,
 * unit-tested). A stale success closes its connection and walks away.
 */
let openGeneration = 0

/** Pure adoption rule for an open attempt's success callback. */
export function isCurrentOpenAttempt(
  generationAtStart: number,
  generationNow: number,
): boolean {
  return generationAtStart === generationNow
}

function dropCachedDb(): void {
  openGeneration += 1
  if (cachedDb) {
    try {
      cachedDb.close()
    } catch {
      // already closed/broken — dropping the reference is what matters
    }
  }
  cachedDb = null
  opening = null
}

function openDb(): Promise<IDBDatabase> {
  if (cachedDb) return Promise.resolve(cachedDb)
  if (opening) return opening
  const generationAtStart = openGeneration
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(
        new PhotoQueueUnavailableError(
          'This browser cannot store photos safely on the device.',
        ),
      )
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      reject(
        new PhotoQueueUnavailableError(
          err instanceof Error ? err.message : 'Could not open device storage.',
        ),
      )
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex(IDX_PACK, 'packId', { unique: false })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // LATE-SUCCESS GUARD (audit item 4): if this attempt already timed out
      // (dropCachedDb bumped the generation), this success belongs to a
      // condemned attempt — close it and adopt nothing.
      if (!isCurrentOpenAttempt(generationAtStart, openGeneration)) {
        try {
          db.close()
        } catch {
          // nothing to salvage from a stale connection
        }
        return
      }
      // If the browser force-closes the connection (Safari does under
      // pressure), drop the cache so the next operation reopens.
      db.onclose = () => {
        if (cachedDb === db) dropCachedDb()
      }
      db.onversionchange = () => {
        if (cachedDb === db) dropCachedDb()
      }
      cachedDb = db
      opening = null
      resolve(db)
    }
    req.onerror = () => {
      opening = null
      reject(
        new PhotoQueueUnavailableError(
          req.error?.message ?? 'Could not open device storage.',
        ),
      )
    }
    req.onblocked = () => {
      opening = null
      reject(new PhotoQueueUnavailableError('Device storage is busy in another tab.'))
    }
  })
  opening = withDeadline(attempt, idbOpTimeoutMs, 'Opening device storage').catch(
    (err) => {
      dropCachedDb()
      throw err instanceof PhotoQueueUnavailableError
        ? err
        : new PhotoQueueUnavailableError(
            err instanceof Error ? err.message : 'Could not open device storage.',
          )
    },
  )
  return opening
}

/** Bound any storage promise; a deadline breach drops the cached connection
 *  (the Safari unstick) and surfaces as the queue's standard error type. */
async function bounded<T>(label: string, work: Promise<T>): Promise<T> {
  try {
    return await withDeadline(work, idbOpTimeoutMs, label)
  } catch (err) {
    if (err instanceof DeadlineError) {
      dropCachedDb()
      throw new PhotoQueueUnavailableError(err.message)
    }
    throw err
  }
}

function tx<T>(
  label: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const work = openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let request: IDBRequest<T>
        try {
          const t = db.transaction(STORE, mode)
          request = run(t.objectStore(STORE))
          // Connection is CACHED — never closed per transaction.
          t.onabort = () =>
            reject(
              new PhotoQueueUnavailableError(
                t.error?.message ?? 'Device storage transaction aborted.',
              ),
            )
        } catch (err) {
          reject(
            new PhotoQueueUnavailableError(
              err instanceof Error ? err.message : 'Device storage error.',
            ),
          )
          return
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () =>
          reject(
            new PhotoQueueUnavailableError(
              request.error?.message ?? 'Device storage write failed.',
            ),
          )
      }),
  )
  return bounded(label, work)
}

/**
 * Ask the browser to make this origin's storage persistent so the queue is not
 * evicted under memory pressure. Best-effort: never throws.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** Write (or overwrite) a record. Rejects if the device cannot store it. */
export async function putQueuedPhoto(record: QueuedPhotoRecord): Promise<void> {
  await tx('Saving photo on device', 'readwrite', (s) => s.put(record) as IDBRequest<IDBValidKey>)
}

export async function getQueuedPhoto(id: string): Promise<QueuedPhotoRecord | null> {
  const r = await tx<QueuedPhotoRecord | undefined>(
    'Reading photo on device',
    'readonly',
    (s) => s.get(id) as IDBRequest<QueuedPhotoRecord | undefined>,
  )
  return r ?? null
}

/** All records for a pack, oldest first. */
export async function listQueuedForPack(packId: string): Promise<QueuedPhotoRecord[]> {
  const all = await tx<QueuedPhotoRecord[]>(
    'Listing photos on device',
    'readonly',
    (s) => s.index(IDX_PACK).getAll(packId) as IDBRequest<QueuedPhotoRecord[]>,
  )
  return (all ?? []).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}

/**
 * IDs only of a pack's records (hotfix, one-tap attach). Uses the index's
 * KEYS, so no photo blob is read: the release path needs to know WHICH
 * photos exist, never their bytes — and on iOS every blob-bearing read
 * competes with the background uploader for the same store.
 */
export async function listQueuedIdsForPack(packId: string): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>(
    'Listing photos on device',
    'readonly',
    (s) => s.index(IDX_PACK).getAllKeys(packId) as IDBRequest<IDBValidKey[]>,
  )
  return (keys ?? []).map(String).sort()
}

export async function patchQueuedPhoto(
  id: string,
  patch: Partial<Omit<QueuedPhotoRecord, 'id'>> & { state?: QueuedPhotoState },
): Promise<QueuedPhotoRecord | null> {
  const existing = await getQueuedPhoto(id)
  if (!existing) return null
  const next: QueuedPhotoRecord = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  await putQueuedPhoto(next)
  return next
}

/**
 * Remove a record. ONLY call this after the server has confirmed the photo is
 * attached, or as part of an explicit, audited discard.
 */
export async function deleteQueuedPhoto(id: string): Promise<void> {
  await tx('Removing photo on device', 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>)
}

/**
 * ATOMIC claim (compare-and-swap). The read, the decision and the write all
 * happen inside ONE readwrite IndexedDB transaction on the store — and
 * readwrite transactions on the same store are serialized by the browser,
 * across tabs of the same origin. Two simultaneous claims therefore cannot
 * both win: the loser's transaction runs after the winner's commit, sees the
 * updated record, and its `decide` returns null.
 *
 * `decide` is a PURE function (unit-tested separately): given the current
 * record it returns either the patch to apply (claim succeeds) or null
 * (claim refused). Returns the updated record on success, null otherwise.
 */
export async function claimQueuedPhoto(
  id: string,
  decide: (current: QueuedPhotoRecord) => Partial<QueuedPhotoRecord> | null,
): Promise<QueuedPhotoRecord | null> {
  const work = openDb().then(
    (db) =>
      new Promise<QueuedPhotoRecord | null>((resolve, reject) => {
        let result: QueuedPhotoRecord | null = null
        let t: IDBTransaction
        try {
          t = db.transaction(STORE, 'readwrite')
        } catch (err) {
          reject(
            new PhotoQueueUnavailableError(
              err instanceof Error ? err.message : 'Device storage error.',
            ),
          )
          return
        }
        const store = t.objectStore(STORE)
        const getReq = store.get(id) as IDBRequest<QueuedPhotoRecord | undefined>
        getReq.onsuccess = () => {
          const current = getReq.result
          if (!current) return // absent -> claim refused; txn completes empty
          const patch = decide(current)
          if (!patch) return
          const next: QueuedPhotoRecord = {
            ...current,
            ...patch,
            updatedAt: new Date().toISOString(),
          }
          store.put(next)
          result = next
        }
        // Connection is CACHED — never closed per transaction.
        t.oncomplete = () => resolve(result)
        t.onabort = () =>
          reject(
            new PhotoQueueUnavailableError(
              t.error?.message ?? 'Device storage transaction aborted.',
            ),
          )
        t.onerror = () => {
          // handled by onabort
        }
      }),
  )
  return bounded('Claiming photo on device', work)
}
