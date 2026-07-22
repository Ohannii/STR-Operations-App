import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  __resetDbForTests,
  __setIdbOpTimeoutForTests,
  listQueuedForPack,
  PhotoQueueUnavailableError,
} from '@/lib/photos/photo-queue-db'

/**
 * BEHAVIOURAL late-open coverage (audit item 3, 23 Jul). A predicate test
 * alone could pass while the real close/adoption wiring broke — so this
 * drives the REAL openDb through a controllable fake indexedDB and proves:
 *   * an open attempt that outlives the deadline fails the caller;
 *   * when its onsuccess fires LATE anyway, that connection's close() is
 *     called and it is NOT adopted as the cached connection;
 *   * the next operation opens a FRESH connection and uses it, not the
 *     condemned one.
 */

type FakeRequest = {
  onsuccess: (() => void) | null
  onerror: (() => void) | null
  onupgradeneeded: (() => void) | null
  onblocked: (() => void) | null
  result?: unknown
  error?: { message: string } | null
}

function makeFakeDb(name: string) {
  const db = {
    name,
    closed: false,
    txCount: 0,
    objectStoreNames: { contains: () => true },
    onclose: null as (() => void) | null,
    onversionchange: null as (() => void) | null,
    close() {
      db.closed = true
    },
    transaction() {
      db.txCount += 1
      const txn = {
        onabort: null as (() => void) | null,
        error: null,
        objectStore() {
          return {
            index() {
              return {
                getAll() {
                  const req: FakeRequest = {
                    onsuccess: null,
                    onerror: null,
                    onupgradeneeded: null,
                    onblocked: null,
                    result: [],
                  }
                  setTimeout(() => {
                    req.result = []
                    req.onsuccess?.()
                  }, 0)
                  return req
                },
              }
            },
          }
        },
      }
      return txn
    },
  }
  return db
}

let pendingOpens: Array<{ req: FakeRequest; fire: (db: ReturnType<typeof makeFakeDb>) => void }> =
  []
let openCount = 0
let autoSucceed = false

beforeEach(() => {
  __resetDbForTests() // start every test with no cached connection
  pendingOpens = []
  openCount = 0
  autoSucceed = false
  __setIdbOpTimeoutForTests(60) // test timescale for the 8s production bound
  ;(globalThis as { indexedDB?: unknown }).indexedDB = {
    open() {
      openCount += 1
      const req: FakeRequest = {
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
        error: null,
      }
      const db = makeFakeDb(`db-${openCount}`)
      const fire = (d: ReturnType<typeof makeFakeDb>) => {
        req.result = d
        req.onsuccess?.()
      }
      if (autoSucceed) {
        setTimeout(() => fire(db), 0)
      } else {
        pendingOpens.push({ req, fire })
      }
      return req
    },
  }
})

afterEach(() => {
  // Restores the production timeout AND drops/closes any cached fake
  // connection — no module-state leakage into other tests.
  __resetDbForTests()
  delete (globalThis as { indexedDB?: unknown }).indexedDB
})

describe('late IndexedDB open success (REAL openDb behaviour)', () => {
  it('a condemned attempt is closed on late success, never cached; the next op gets a FRESH connection', async () => {
    // 1. First operation: the open attempt never succeeds inside the
    // deadline — the caller fails with the standard storage error.
    await expect(listQueuedForPack('pack-x')).rejects.toThrow(PhotoQueueUnavailableError)
    expect(pendingOpens).toHaveLength(1)

    // 2. The browser fires onsuccess LATE anyway, delivering db-1.
    const zombie = makeFakeDb('zombie')
    pendingOpens[0].fire(zombie)
    await new Promise((r) => setTimeout(r, 10))

    // The real adoption guard must CLOSE it and adopt nothing.
    expect(zombie.closed).toBe(true)
    expect(zombie.txCount).toBe(0) // never used for any transaction

    // 3. Next operation: a FRESH open succeeds and serves the transaction —
    // proving the zombie did not become cachedDb.
    autoSucceed = true
    const opensBefore = openCount
    await expect(listQueuedForPack('pack-x')).resolves.toEqual([])
    expect(openCount).toBe(opensBefore + 1) // fresh connection was opened
    expect(zombie.txCount).toBe(0) // and the zombie still untouched
  })
})
