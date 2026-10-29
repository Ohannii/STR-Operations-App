import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * INTEGRATION regression (chat verification item 3, 22 Jul evening).
 *
 * Runs the REAL drainQueue against an in-memory storage double whose claim
 * operation can be made to behave exactly like the field failure: a storage
 * wait that never settles until the deadline converts it into the queue's
 * standard error (the real photo-queue-db now bounds every operation with
 * withDeadline at 8s and drops the cached connection; the double reproduces
 * that OUTCOME on a test timescale).
 *
 * What this proves, end to end, with no page refresh and NO test-triggered
 * second drain (WAKE-ONLY recovery):
 *   1. a hung storage wait does NOT freeze or reject drainQueue -- it
 *      resolves;
 *   2. the record survives with the SAME photo id and caption, marked
 *      failed/backoff;
 *   3. the wake timer booked by the drain's own finally fires BY ITSELF and
 *      retries the SAME id through the batch path -- which is also the
 *      guard-release proof, since a still-held guard would make the wake's
 *      drain a no-op;
 *   4. the record is deleted only after its own confirmed per-photo success;
 *   5. the successful attach raises serverRefreshNeeded, the flag that
 *      drives the client's router.refresh() freshness path.
 */

const store = new Map<string, Record<string, unknown>>()
let hangNextClaims = 0
/** When true, EVERY claim returns a promise that never settles — the raw
 *  WebKit hang with no per-op deadline (the mock bypasses the real db's
 *  bound), so only releaseQueued's TOTAL budget can end the wait. */
let hangAllClaimsForever = false
/** When > 0, every claim SETTLES (rejects) after this many ms — the
 *  production timing relationship where per-op deadlines fire well inside
 *  the total budget, so waves genuinely succeed each other. */
let slowRejectClaimMs = 0
const claimCalls: string[] = []
/** Epoch-ms start time of every claim — the budget-gate proof reads this. */
const claimStartTimes: number[] = []

vi.mock('@/app/properties/[id]/photos/actions', () => ({
  requestPhotoUploadSlot: vi.fn(async (input: { photoId?: string | null }) => ({
    ok: true,
    photoId: input.photoId ?? 'unknown',
    masterPath: `companies/co1/property/prop1/${input.photoId}.jpg`,
    thumbPath: `companies/co1/property/prop1/${input.photoId}_thumb.jpg`,
    // The duplicate-convergence test overrides these per call.
    masterUpload: { signedUrl: `https://storage.test/${input.photoId}/m`, token: 't' },
    thumbUpload: { signedUrl: `https://storage.test/${input.photoId}/t`, token: 't' },
    retentionClass: 'routine_pre_arrival',
    companyId: 'co1',
    evidencePackId: 'pack-integration',
  })),
  attachEvidencePhoto: vi.fn(async (input: { photoId: string }) => ({
    ok: true,
    photoId: input.photoId,
  })),
  discardStagedPhotoIntent: vi.fn(async () => ({ ok: true })),
  attachEvidencePhotosBatch: vi.fn(async (inputs: Array<{ photoId: string }>) => ({
    ok: true,
    results: inputs.map((i) => ({ photoId: i.photoId, ok: true })),
  })),
}))

vi.mock('@/lib/photos/photo-queue-db', () => {
  class PhotoQueueUnavailableError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'PhotoQueueUnavailableError'
    }
  }
  const get = async (id: string) => (store.get(id) ? { ...store.get(id) } : null)
  return {
    PhotoQueueUnavailableError,
    requestPersistentStorage: async () => true,
    putQueuedPhoto: async (r: { id: string }) => {
      store.set(r.id, { ...r })
    },
    getQueuedPhoto: get,
    listQueuedForPack: async (packId: string) =>
      [...store.values()]
        .filter((r) => r.packId === packId)
        .map((r) => ({ ...r })),
    listQueuedIdsForPack: async (packId: string) =>
      [...store.values()]
        .filter((r) => r.packId === packId)
        .map((r) => r.id as string)
        .sort(),
    patchQueuedPhoto: async (id: string, patch: Record<string, unknown>) => {
      const cur = store.get(id)
      if (!cur) return null
      const next = { ...cur, ...patch, updatedAt: new Date().toISOString() }
      store.set(id, next)
      return { ...next }
    },
    deleteQueuedPhoto: async (id: string) => {
      store.delete(id)
    },
    claimQueuedPhoto: async (
      id: string,
      decide: (cur: Record<string, unknown>) => Record<string, unknown> | null,
    ) => {
      claimCalls.push(id)
      claimStartTimes.push(Date.now())
      if (hangAllClaimsForever) {
        return new Promise(() => {}) // never settles
      }
      if (slowRejectClaimMs > 0) {
        await new Promise((r) => setTimeout(r, slowRejectClaimMs))
        throw new PhotoQueueUnavailableError(
          'Claiming photo on device did not complete within 8s',
        )
      }
      if (hangNextClaims > 0) {
        hangNextClaims -= 1
        // The field failure's OUTCOME: the underlying wait never settles;
        // the (real) deadline turns it into the standard storage error.
        await new Promise((r) => setTimeout(r, 60))
        throw new PhotoQueueUnavailableError(
          'Claiming photo on device did not complete within 8s',
        )
      }
      const cur = store.get(id)
      if (!cur) return null
      const patch = decide({ ...cur })
      if (!patch) return null
      const next = { ...cur, ...patch, updatedAt: new Date().toISOString() }
      store.set(id, next)
      return { ...next }
    },
  }
})

import { drainQueue, photoQueue, releaseQueued } from '@/lib/photos/photo-queue'
import {
  attachEvidencePhotosBatch,
  requestPhotoUploadSlot,
} from '@/app/properties/[id]/photos/actions'

const PACK = 'pack-integration'

function seedStagedReleasedRecord(id: string) {
  store.set(id, {
    id,
    userId: 'u1',
    companyId: 'co1',
    propertyId: 'prop1',
    packId: PACK,
    capturedAt: new Date().toISOString(),
    note: 'caption stays',
    width: 100,
    height: 100,
    sizeBytes: 1000,
    state: 'queued',
    bytesStaged: true,
    masterPath: `companies/co1/property/prop1/${id}.jpg`,
    thumbPath: `companies/co1/property/prop1/${id}_thumb.jpg`,
    retentionClass: 'routine_pre_arrival',
    lastError: null,
    attempts: 0,
    lastAttemptAt: null,
    leaseUntil: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
}

beforeEach(() => {
  store.clear()
  claimCalls.length = 0
  claimStartTimes.length = 0
  hangNextClaims = 0
  hangAllClaimsForever = false
  slowRejectClaimMs = 0
  vi.mocked(attachEvidencePhotosBatch).mockClear()
})

/** Unreleased but already STAGED: the release path is the only work the
 *  drain can find, so claim counts during these tests are release claims
 *  (plus post-release upload claims once records become queued). */
function seedSavedLocalRecord(id: string) {
  seedStagedReleasedRecord(id)
  const r = store.get(id)
  if (r) store.set(id, { ...r, state: 'saved_local' })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('drainQueue survives a hung storage operation and recovers ALONE', () => {
  it('hang -> RESOLVES -> guard free -> wake-only same-id retry -> attached, no refresh', async () => {
    seedStagedReleasedRecord('p1')
    hangNextClaims = 1 // the first upload claim "hangs" then deadline-fails

    // 1. The first REAL drainQueue call RESOLVES — it must not reject.
    // (This exact call previously rejected with PhotoQueueUnavailableError.)
    await expect(drainQueue(PACK)).resolves.toBeUndefined()

    // 3. The record survived with the SAME id and caption, failed + backoff.
    const afterHang = store.get('p1')
    expect(afterHang).toBeDefined()
    expect(afterHang?.state).toBe('failed')
    expect(afterHang?.attempts).toBe(1)
    expect(afterHang?.note).toBe('caption stays')
    expect(attachEvidencePhotosBatch).not.toHaveBeenCalled()

    // 4+5. NOTHING further from the test: no refresh, no manual drain. The
    // wake booked by the drain's own finally must fire (backoff for
    // attempts=1 is 1s) and complete the retry with the SAME photo id via
    // the batch path. This is ALSO the guard-release proof: the wake calls
    // drainQueue itself, and a still-held guard would make that a no-op —
    // the attach below could then never happen.
    await new Promise((r) => setTimeout(r, 1600))
    expect(attachEvidencePhotosBatch).toHaveBeenCalledTimes(1)
    const batched = vi.mocked(attachEvidencePhotosBatch).mock.calls[0][0]
    expect(batched.map((i: { photoId: string }) => i.photoId)).toEqual(['p1'])
    // Caption rode the retried attach unchanged.
    expect(batched[0].note).toBe('caption stays')

    // 6. Deleted ONLY after its own confirmed success.
    expect(store.get('p1')).toBeUndefined()

    // FRESHNESS (behavioural, audit item 6): the successful attach set the
    // serverRefreshNeeded signal — the exact flag usePackQueue consumes to
    // call router.refresh(), which refetches the dynamic route and updates
    // the client Router Cache with the new linked count. The claim/ack
    // mechanics of that signal are covered by the existing refresh tests.
    expect(photoQueue.snapshot(PACK).serverRefreshNeeded).toBe(true)
  }, 10_000)

  it('a healthy record attaches first try and is deleted on ITS confirmation', async () => {
    seedStagedReleasedRecord('p2')
    await drainQueue(PACK)
    expect(attachEvidencePhotosBatch).toHaveBeenCalledTimes(1)
    expect(store.get('p2')).toBeUndefined()
  })
})

describe('releaseQueued: COUNT-INDEPENDENT ceiling (25 never-settling releases)', () => {
  it('returns within ONE fixed budget, reports every unresolved id, deletes nothing, retries later', async () => {
    // 25 unreleased photos; every claim is the raw WebKit hang (never
    // settles — the mock has no per-op bound, so only the TOTAL budget can
    // end the wait). Sequential per-record deadlines would be 25 x 8s ≈ 200s;
    // the ceiling must be ~one budget (10s), count-independent.
    const ids = Array.from({ length: 25 }, (_, i) => `r${String(i).padStart(2, '0')}`)
    for (const id of ids) seedSavedLocalRecord(id)
    hangAllClaimsForever = true

    const start = Date.now()
    const { failedIds } = await releaseQueued(PACK)
    const elapsed = Date.now() - start

    // ONE budget, not 25: comfortably under two budgets, at least near one.
    expect(elapsed).toBeGreaterThan(9_000)
    expect(elapsed).toBeLessThan(15_000)

    // Every unresolved id reported — this is exactly what EvidenceCapture
    // renders as the amber recovery notice ("N photos could not be handed
    // to the uploader"), keyed off failedIds.length > 0.
    expect(failedIds.sort()).toEqual([...ids].sort())

    // Nothing was deleted; every record remains durable and unreleased.
    for (const id of ids) {
      expect(store.get(id)).toBeDefined()
      expect(store.get(id)?.state).toBe('saved_local')
    }

    // LATER RETRY WORKS and late work cannot regress it: storage recovers,
    // the same call releases them all, and the drain (kicked by release)
    // batch-attaches every one — records drain to zero.
    hangAllClaimsForever = false
    const retry = await releaseQueued(PACK)
    expect(retry.failedIds).toEqual([])
    await sleep(400)
    expect(store.size).toBe(0)
  }, 30_000)
})

describe('FIELD REGRESSION 22 Jul: 24 staged + 1 ambiguous converge to exactly 25 attached', () => {
  it('duplicate storage responses converge; master-exists/thumb-missing signs only the thumb; no dupes; no dead state', async () => {
    // 24 photos fully staged (bytes verifiably on the server), 1 photo whose
    // staging was interrupted: masterPath bytes landed but the record never
    // learned it (bytesStaged false) — the exact ambiguous state behind
    // "The resource already exists".
    const stagedIds = Array.from({ length: 24 }, (_, i) => `s${String(i).padStart(2, '0')}`)
    for (const id of stagedIds) seedSavedLocalRecord(id)
    seedSavedLocalRecord('ambiguous')
    const amb = store.get('ambiguous')
    if (amb) store.set('ambiguous', { ...amb, bytesStaged: false })

    // The slot for the ambiguous photo reports the SERVER truth: master
    // already exists (upload: null — nothing to sign for it), thumb still
    // needs bytes (signed URL provided).
    vi.mocked(requestPhotoUploadSlot).mockImplementationOnce(async (input) => ({
      ok: true as const,
      photoId: (input as { photoId?: string }).photoId ?? 'ambiguous',
      masterPath: 'companies/co1/property/prop1/ambiguous.jpg',
      thumbPath: 'companies/co1/property/prop1/ambiguous_thumb.jpg',
      masterUpload: null, // already exists — converge, do not fail
      thumbUpload: { signedUrl: 'https://storage.test/ambiguous/t', token: 't' },
      retentionClass: 'routine_pre_arrival',
      companyId: 'co1',
      evidencePackId: PACK,
    }))
    // And even the thumb PUT answers with Supabase's duplicate shape
    // (HTTP 400 + "already exists" body) — it must converge too.
    const fetchMock = vi.fn(async () =>
      new Response('{"message":"The resource already exists"}', { status: 400 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    try {
      const { failedIds } = await releaseQueued(PACK)
      expect(failedIds).toEqual([])
      // Let the drain finish: 24 via the batch fast path, the ambiguous one
      // via the slow path (slot -> thumb-only PUT -> attach).
      await sleep(600)

      // EXACTLY 25 attached, each id exactly once, across both attach paths.
      const batchedIds = vi
        .mocked(attachEvidencePhotosBatch)
        .mock.calls.flatMap((c) => c[0].map((i: { photoId: string }) => i.photoId))
      const singleIds = vi
        .mocked(
          (await import('@/app/properties/[id]/photos/actions')).attachEvidencePhoto,
        )
        .mock.calls.map((c) => (c[0] as { photoId: string }).photoId)
      const allAttached = [...batchedIds, ...singleIds]
      expect(allAttached).toHaveLength(25)
      expect(new Set(allAttached).size).toBe(25)

      // Only the thumb was ever PUT — the existing master was never
      // re-uploaded or overwritten.
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const putUrl = String(fetchMock.mock.calls[0][0])
      expect(putUrl).toContain('/ambiguous/t')

      // Every record deleted only after ITS confirmed attach: store empty.
      expect(store.size).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  }, 15_000)
})

describe('release budget GATE: no new claims may start after the ceiling closes', () => {
  it('realistic timing: waves succeed each other, the gate stops new starts at the budget', async () => {
    // Production timing RELATIONSHIP, real budget: claims SETTLE (reject)
    // after 4s — well inside the 10s ceiling — so wave 1 (5 claims, t≈0)
    // settles at ~4s, wave 2 starts (~4s), wave 3 starts (~8s), and the
    // budget closes at 10s with wave 3 still in flight. Waves 4 and 5 must
    // NEVER start claims: the gate skips them instantly.
    const ids = Array.from({ length: 25 }, (_, i) => `g${String(i).padStart(2, '0')}`)
    for (const id of ids) seedSavedLocalRecord(id)
    slowRejectClaimMs = 4_000

    const t0 = Date.now()
    const { failedIds } = await releaseQueued(PACK)
    const returnedAt = Date.now()

    // Returns at the fixed ceiling — one budget, count-independent.
    expect(returnedAt - t0).toBeGreaterThan(9_000)
    expect(returnedAt - t0).toBeLessThan(12_000)

    // Nothing resolved -> every id reported unresolved.
    expect(failedIds).toHaveLength(25)

    // At most 3 waves of 5 ever STARTED (0s, ~4s, ~8s)…
    const startsBeforeReturn = claimStartTimes.filter((t) => t <= returnedAt + 100)
    expect(startsBeforeReturn.length).toBeLessThanOrEqual(15)

    // …and after advancing WELL beyond every per-operation duration, not a
    // single additional claim has begun: the gate closed the pipeline.
    await sleep(5_500)
    expect(claimStartTimes.length).toBe(startsBeforeReturn.length)
    expect(claimStartTimes.every((t) => t <= returnedAt + 100)).toBe(true)

    // Unresolved records remained durable throughout.
    for (const id of ids) {
      expect(store.get(id)?.state).toBe('saved_local')
    }

    // Retry/drain cannot be regressed by the late (settled) work: claims
    // heal, the same call releases all 25, and the drain batch-attaches
    // them to zero. Any unhandled rejection anywhere fails this test.
    slowRejectClaimMs = 0
    const retry = await releaseQueued(PACK)
    expect(retry.failedIds).toEqual([])
    await sleep(400)
    expect(store.size).toBe(0)
  }, 40_000)
})
