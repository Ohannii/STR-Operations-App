'use client'

import type { QueuedPhotoMeta, QueuedPhotoState } from '@/lib/photos/photo-queue-state'

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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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
    req.onsuccess = () => resolve(req.result)
    req.onerror = () =>
      reject(
        new PhotoQueueUnavailableError(
          req.error?.message ?? 'Could not open device storage.',
        ),
      )
    req.onblocked = () =>
      reject(new PhotoQueueUnavailableError('Device storage is busy in another tab.'))
  })
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let request: IDBRequest<T>
        try {
          const t = db.transaction(STORE, mode)
          request = run(t.objectStore(STORE))
          t.oncomplete = () => db.close()
          t.onabort = () => {
            db.close()
            reject(
              new PhotoQueueUnavailableError(
                t.error?.message ?? 'Device storage transaction aborted.',
              ),
            )
          }
        } catch (err) {
          db.close()
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
  await tx('readwrite', (s) => s.put(record) as IDBRequest<IDBValidKey>)
}

export async function getQueuedPhoto(id: string): Promise<QueuedPhotoRecord | null> {
  const r = await tx<QueuedPhotoRecord | undefined>(
    'readonly',
    (s) => s.get(id) as IDBRequest<QueuedPhotoRecord | undefined>,
  )
  return r ?? null
}

/** All records for a pack, oldest first. */
export async function listQueuedForPack(packId: string): Promise<QueuedPhotoRecord[]> {
  const all = await tx<QueuedPhotoRecord[]>(
    'readonly',
    (s) => s.index(IDX_PACK).getAll(packId) as IDBRequest<QueuedPhotoRecord[]>,
  )
  return (all ?? []).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
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
  await tx('readwrite', (s) => s.delete(id) as IDBRequest<undefined>)
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
  const db = await openDb()
  return new Promise<QueuedPhotoRecord | null>((resolve, reject) => {
    let result: QueuedPhotoRecord | null = null
    let t: IDBTransaction
    try {
      t = db.transaction(STORE, 'readwrite')
    } catch (err) {
      db.close()
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
    t.oncomplete = () => {
      db.close()
      resolve(result)
    }
    t.onabort = () => {
      db.close()
      reject(
        new PhotoQueueUnavailableError(
          t.error?.message ?? 'Device storage transaction aborted.',
        ),
      )
    }
    t.onerror = () => {
      // handled by onabort
    }
  })
}
