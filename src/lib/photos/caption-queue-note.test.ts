import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * CAPTURE-SCREEN CAPTION DURABILITY at the QUEUE layer (rev 4, 26 Oct).
 *
 * Runs the REAL enqueuePhoto / updateQueuedNote / reconcileNoteShadows /
 * captionGateForAttach / releaseQueued and the REAL caption decisions against
 * an in-memory CAS double of photo-queue-db, with the REAL shadow module over
 * an in-memory localStorage. Proves identity-based proof, fail-closed
 * reconciliation, the attach gate and release ordering.
 */

const store = new Map<string, Record<string, unknown>>()
/** Storage-failure injection: ids whose reads / claims throw. */
const failGetFor = new Set<string>()
const failClaimFor = new Set<string>()
/** rev 8: the whole queue listing fails (IndexedDB unreadable). */
const failList = { current: false }
/** rev 8: records that disappear between the listing and their claim. */
const vanishOnClaim = new Set<string>()
/** Every state transition written through the double, in order. */
const stateLog: Array<{ id: string; state: unknown }> = []

vi.mock('@/app/properties/[id]/photos/actions', () => ({
  requestPhotoUploadSlot: vi.fn(async () => ({ ok: false, error: 'not used here' })),
  attachEvidencePhoto: vi.fn(async () => ({ ok: false, error: 'not used here' })),
  attachEvidencePhotosBatch: vi.fn(async () => ({ ok: true, results: [] })),
  discardStagedPhotoIntent: vi.fn(async () => ({ ok: true })),
}))

vi.mock('@/lib/photos/photo-queue-db', () => {
  class PhotoQueueUnavailableError extends Error {}
  return {
    PhotoQueueUnavailableError,
    requestPersistentStorage: async () => true,
    putQueuedPhoto: async (r: { id: string }) => {
      store.set(r.id, { ...r })
    },
    getQueuedPhoto: async (id: string) => {
      if (failGetFor.has(id)) throw new PhotoQueueUnavailableError('Reading photo on device timed out')
      return store.get(id) ? { ...store.get(id) } : null
    },
    listQueuedForPack: async (packId: string) => {
      if (failList.current) throw new PhotoQueueUnavailableError('Listing photos on device timed out')
      return [...store.values()].filter((r) => r.packId === packId).map((r) => ({ ...r }))
    },
    patchQueuedPhoto: async (id: string, patch: Record<string, unknown>) => {
      const cur = store.get(id)
      if (!cur) return null
      const next = { ...cur, ...patch }
      store.set(id, next)
      if ('state' in patch) stateLog.push({ id, state: patch.state })
      return { ...next }
    },
    deleteQueuedPhoto: async (id: string) => {
      store.delete(id)
    },
    // Faithful CAS: read-decide-write with no interleaving (single-threaded test).
    claimQueuedPhoto: async (
      id: string,
      decide: (cur: Record<string, unknown>) => Record<string, unknown> | null,
    ) => {
      if (failClaimFor.has(id)) throw new PhotoQueueUnavailableError('Claiming photo on device timed out')
      if (vanishOnClaim.has(id)) store.delete(id)
      const cur = store.get(id)
      if (!cur) return null
      const patch = decide({ ...cur })
      if (!patch) return null
      const next = { ...cur, ...patch, updatedAt: new Date().toISOString() }
      store.set(id, next)
      if ('state' in patch) stateLog.push({ id, state: patch.state })
      return { ...next }
    },
  }
})

import {
  captionGateForAttach,
  drainQueue,
  enqueuePhoto,
  reconcileNoteShadows,
  releaseQueued,
  updateQueuedNote,
} from '@/lib/photos/photo-queue'
import { claimQueuedPhoto, getQueuedPhoto, type QueuedPhotoRecord } from '@/lib/photos/photo-queue-db'
import {
  noteEditDecision,
  releaseDecision,
  type QueuedPhotoMeta,
} from '@/lib/photos/photo-queue-state'
import {
  CaptureNoteKeeper,
  bumpHighWater,
  readHighWater,
  readNoteShadow,
  readNoteShadows,
  writeNoteShadow,
} from '@/lib/photos/capture-note-shadow'

import { attachEvidencePhotosBatch } from '@/app/properties/[id]/photos/actions'
import {
  CaptureExitGate,
  planCaptureExit,
  type CapturePhotoLite,
  applyHandoffOutcome,
  handOffPackRelease,
  idsToHandOff,
  packRowStatus,
} from '@/lib/photos/capture-handoff'
import { evaluateBatch } from '@/lib/photos/photo-queue-state'

const SCOPE = { userId: 'u1', companyId: 'co1', propertyId: 'prop1', packId: 'pack-cap' }

async function enqueueOne(id: string, packId: string = SCOPE.packId) {
  await enqueuePhoto({ ...SCOPE, packId }, {
    id,
    master: new Blob(['m']),
    thumb: new Blob(['t']),
    width: 10,
    height: 10,
    sizeBytes: 1,
    capturedAt: new Date().toISOString(),
    note: null,
    release: false,
  })
}

function makeLocalStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
    clear: () => map.clear(),
  }
}

const SH = (photoId: string, note: string, v: number, editId = `edit-${v}`) => ({
  photoId,
  note,
  v,
  editId,
  userId: 'u1',
  companyId: 'co1',
  propertyId: 'prop1',
})

const rec = async (id: string) => (await getQueuedPhoto(id)) as unknown as QueuedPhotoMeta
async function setState(id: string, patch: Record<string, unknown>) {
  await claimQueuedPhoto(id, () => patch)
}

beforeEach(() => {
  store.clear()
  failGetFor.clear()
  failClaimFor.clear()
  failList.current = false
  vanishOnClaim.clear()
  stateLog.length = 0
  ;(globalThis as unknown as { window: { localStorage: unknown } }).window = {
    localStorage: makeLocalStorage(),
  }
})

describe('updateQueuedNote — identity-proven persistence', () => {
  it('writes the exact edit into the saved_local record (refresh-safe)', async () => {
    await enqueueOne('ph-1')
    expect(await updateQueuedNote('pack-cap', 'ph-1', 'Geyser valve closed', 100, 'e1')).toBe(true)
    const r = await rec('ph-1')
    expect(r).toMatchObject({ note: 'Geyser valve closed', noteEditedAt: 100, noteEditId: 'e1' })
    expect(r.state).toBe('saved_local')
  })

  it('a wrong pack id is refused — scope is part of the claim', async () => {
    await enqueueOne('ph-1')
    expect(await updateQueuedNote('another-pack', 'ph-1', 'x', 100, 'e1')).toBe(false)
    expect((await rec('ph-1')).note).toBeNull()
  })

  it('an older delayed write cannot overwrite a newer caption', async () => {
    await enqueueOne('ph-1')
    await updateQueuedNote('pack-cap', 'ph-1', 'newer caption', 200, 'e2')
    expect(await updateQueuedNote('pack-cap', 'ph-1', 'older caption', 150, 'e1')).toBe(false)
    expect((await rec('ph-1')).note).toBe('newer caption')
  })

  it('(d) a STALE async completion cannot clear the CURRENT shadow', async () => {
    await enqueueOne('ph-1')
    // The newest keystroke's shadow is on the device...
    writeNoteShadow('pack-cap', SH('ph-1', 'newest text', 300, 'e3'))
    // ...when an OLDER edit's debounced IndexedDB write completes.
    expect(await updateQueuedNote('pack-cap', 'ph-1', 'older text', 200, 'e2')).toBe(true)
    expect(readNoteShadow('pack-cap', 'ph-1')?.editId).toBe('e3') // NOT cleared
    // The newest edit still reconciles afterwards and wins.
    const { blocked } = await reconcileNoteShadows('pack-cap')
    expect(blocked).toEqual([])
    expect((await rec('ph-1')).note).toBe('newest text')
    expect(readNoteShadows('pack-cap')).toEqual([])
  })
})

describe('reconcile — cleared only on IDENTITY proof, fail closed otherwise', () => {
  it('text typed inside the debounce window survives a page kill via the shadow', async () => {
    await enqueueOne('ph-1')
    writeNoteShadow('pack-cap', SH('ph-1', 'typed 50ms before the phone killed the page', 100))
    await reconcileNoteShadows('pack-cap')
    expect((await rec('ph-1')).note).toBe('typed 50ms before the phone killed the page')
    expect(readNoteShadows('pack-cap')).toEqual([])
  })

  it('(c) durable version HIGHER with a different caption: shadow KEPT, photo BLOCKED, mark raised', async () => {
    await enqueueOne('ph-1')
    await updateQueuedNote('pack-cap', 'ph-1', 'caption A', 2000, 'a') // durable A @2000
    writeNoteShadow('pack-cap', SH('ph-1', 'caption B', 1000, 'b')) // later B, clock behind
    const { blocked } = await reconcileNoteShadows('pack-cap')
    expect(blocked).toEqual(['ph-1'])
    expect(readNoteShadow('pack-cap', 'ph-1')?.note).toBe('caption B') // text NOT lost
    expect((await rec('ph-1')).note).toBe('caption A')
    expect(readHighWater('pack-cap', 'ph-1')).toBeGreaterThanOrEqual(2000) // next edit outranks A
  })

  it('a same-version TIE with a different identity is refused and blocks (never guessed)', async () => {
    await enqueueOne('ph-1')
    await updateQueuedNote('pack-cap', 'ph-1', 'tab A', 1000, 'A')
    writeNoteShadow('pack-cap', SH('ph-1', 'tab B', 1000, 'B'))
    const { blocked } = await reconcileNoteShadows('pack-cap')
    expect(blocked).toEqual(['ph-1'])
    expect(readNoteShadow('pack-cap', 'ph-1')?.note).toBe('tab B')
  })

  it('queued record + strictly newer shadow: reconciled into the record (not stranded)', async () => {
    await enqueueOne('ph-1')
    await claimQueuedPhoto('ph-1', (cur) =>
      releaseDecision(cur as unknown as QueuedPhotoMeta, 'old caption at release', { v: 100, editId: 'rel' }),
    )
    writeNoteShadow('pack-cap', SH('ph-1', 'newer caption typed after release', 200))
    const { blocked } = await reconcileNoteShadows('pack-cap')
    expect(blocked).toEqual([])
    expect((await rec('ph-1')).note).toBe('newer caption typed after release')
    expect(readNoteShadows('pack-cap')).toEqual([])
  })

  it('WORKER-OWNED record + newer shadow: KEPT and blocked', async () => {
    await enqueueOne('ph-1')
    await setState('ph-1', { state: 'uploading', leaseUntil: Date.now() + 60_000, note: 'old', noteEditedAt: 100, noteEditId: 'o' })
    writeNoteShadow('pack-cap', SH('ph-1', 'newer', 200))
    const { blocked } = await reconcileNoteShadows('pack-cap')
    expect(blocked).toEqual(['ph-1'])
    expect(readNoteShadow('pack-cap', 'ph-1')?.note).toBe('newer')
  })

  it('a storage error during reconcile keeps the shadow and blocks the photo', async () => {
    await enqueueOne('ph-1')
    writeNoteShadow('pack-cap', SH('ph-1', 'only copy', 200))
    failClaimFor.add('ph-1')
    const { blocked } = await reconcileNoteShadows('pack-cap')
    expect(blocked).toEqual(['ph-1'])
    expect(readNoteShadow('pack-cap', 'ph-1')?.note).toBe('only copy')
  })

  it('record missing: the shadow is KEPT (absence is not proof), nothing blocked', async () => {
    writeNoteShadow('pack-cap', SH('ph-gone', 'orphan text', 200))
    const { blocked } = await reconcileNoteShadows('pack-cap')
    expect(blocked).toEqual([])
    expect(readNoteShadow('pack-cap', 'ph-gone')?.note).toBe('orphan text')
  })

  it('a scope mismatch is never applied, never blocks, never destroyed', async () => {
    await enqueueOne('ph-1')
    writeNoteShadow('pack-cap', { ...SH('ph-1', 'wrong scope', 100), userId: 'someone-else' })
    const { blocked } = await reconcileNoteShadows('pack-cap')
    expect((await rec('ph-1')).note).toBeNull()
    expect(blocked).toEqual([])
    expect(readNoteShadows('pack-cap').length).toBe(1)
  })
})

describe('attach gate — only the PROVEN newest caption is carried', () => {
  it("a strictly newer shadow is applied under the worker's OWN lease", async () => {
    await enqueueOne('ph-1')
    await setState('ph-1', { state: 'attaching', leaseUntil: Date.now() + 60_000, note: 'old', noteEditedAt: 100, noteEditId: 'o' })
    writeNoteShadow('pack-cap', SH('ph-1', 'newest', 200, 'n'))
    const owned = (await getQueuedPhoto('ph-1')) as unknown as QueuedPhotoRecord
    const gated = await captionGateForAttach('pack-cap', owned)
    expect(gated).toMatchObject({ note: 'newest', noteEditedAt: 200, noteEditId: 'n' })
  })

  it('durable version higher with different text: attach FAILS CLOSED, shadow kept', async () => {
    await enqueueOne('ph-1')
    await setState('ph-1', { state: 'attaching', leaseUntil: 5, note: 'A', noteEditedAt: 2000, noteEditId: 'a' })
    writeNoteShadow('pack-cap', SH('ph-1', 'B', 1000, 'b'))
    const owned = (await getQueuedPhoto('ph-1')) as unknown as QueuedPhotoRecord
    await expect(captionGateForAttach('pack-cap', owned)).rejects.toThrow(/not saved yet/)
    expect(readNoteShadow('pack-cap', 'ph-1')?.note).toBe('B')
  })

  it('lease lost to another worker: FAILS CLOSED, shadow kept, caption untouched', async () => {
    await enqueueOne('ph-1')
    await setState('ph-1', { state: 'attaching', leaseUntil: 111, note: 'old', noteEditedAt: 100, noteEditId: 'o' })
    writeNoteShadow('pack-cap', SH('ph-1', 'newest', 200))
    const stale = (await getQueuedPhoto('ph-1')) as unknown as QueuedPhotoRecord
    await setState('ph-1', { leaseUntil: 222 })
    await expect(captionGateForAttach('pack-cap', stale)).rejects.toThrow(/not saved yet/)
    expect(readNoteShadow('pack-cap', 'ph-1')?.note).toBe('newest')
    expect((await rec('ph-1')).note).toBe('old')
  })

  it('storage error while applying: FAILS CLOSED, shadow kept', async () => {
    await enqueueOne('ph-1')
    await setState('ph-1', { state: 'attaching', leaseUntil: 5, note: 'old', noteEditedAt: 100, noteEditId: 'o' })
    writeNoteShadow('pack-cap', SH('ph-1', 'newest', 200))
    const owned = (await getQueuedPhoto('ph-1')) as unknown as QueuedPhotoRecord
    failClaimFor.add('ph-1')
    await expect(captionGateForAttach('pack-cap', owned)).rejects.toThrow()
    expect(readNoteShadow('pack-cap', 'ph-1')?.note).toBe('newest')
  })

  it('the shadow IS the record (identity): passes through unchanged', async () => {
    await enqueueOne('ph-1')
    await setState('ph-1', { state: 'attaching', leaseUntil: 5, note: 'final', noteEditedAt: 300, noteEditId: 'f' })
    writeNoteShadow('pack-cap', SH('ph-1', 'final', 300, 'f'))
    const owned = (await getQueuedPhoto('ph-1')) as unknown as QueuedPhotoRecord
    expect((await captionGateForAttach('pack-cap', owned)).note).toBe('final')
  })
})

describe('noteEditDecision / releaseDecision rules', () => {
  const base = {
    id: 'x', userId: 'u', companyId: 'c', propertyId: 'p', packId: 'k',
    capturedAt: '', note: null, noteEditedAt: 10, noteEditId: 'cur', width: 1, height: 1, sizeBytes: 1,
    state: 'saved_local', lastError: null, attempts: 0, lastAttemptAt: null,
  } as unknown as QueuedPhotoMeta

  it('strictly newer only; ties and worker-owned/discarded records are refused', () => {
    expect(noteEditDecision(base, 'n', 11, 'e')).toEqual({ note: 'n', noteEditedAt: 11, noteEditId: 'e' })
    expect(noteEditDecision(base, 'n', 10, 'other')).toBeNull() // tie: unprovable
    expect(noteEditDecision(base, 'n', 9, 'e')).toBeNull()
    expect(noteEditDecision({ ...base, discardRequested: true }, 'n', 11, 'e')).toBeNull()
    expect(noteEditDecision({ ...base, state: 'uploading' }, 'n', 11, 'e')).toBeNull()
    expect(noteEditDecision({ ...base, state: 'attaching' }, 'n', 11, 'e')).toBeNull()
    expect(noteEditDecision({ ...base, state: 'queued' }, 'n', 11, 'e')).not.toBeNull()
    expect(noteEditDecision({ ...base, state: 'failed' }, 'n', 11, 'e')).not.toBeNull()
  })

  // The durable record holds edit {v:10, id:'cur', note:'Kitchen clean'}.
  const held = { ...base, note: 'Kitchen clean' } as unknown as QueuedPhotoMeta

  it('(a) an OLDER release is refused', () => {
    expect(releaseDecision(held, 'release text', { v: 9, editId: 'r' })).toBeNull()
  })

  it('(b) equal version + DIFFERENT identity is refused (ambiguous tie)', () => {
    expect(releaseDecision(held, 'Kitchen clean', { v: 10, editId: 'someone-else' })).toBeNull()
  })

  it('(b) equal identity + DIFFERENT text is refused (never trusted)', () => {
    expect(releaseDecision(held, 'Kitchen NOT clean', { v: 10, editId: 'cur' })).toBeNull()
  })

  it('(c) the EXACT same edit (identity + canonical text) is an idempotent queue transition', () => {
    expect(releaseDecision(held, 'Kitchen clean', { v: 10, editId: 'cur' })).toEqual({
      state: 'queued',
      leaseUntil: null,
    })
    // Canonical text: edge whitespace in the release map is the same caption.
    expect(releaseDecision(held, '  Kitchen clean\n', { v: 10, editId: 'cur' })).toEqual({
      state: 'queued',
      leaseUntil: null,
    })
  })

  it('(d) a strictly NEWER release applies its canonical caption and queues', () => {
    expect(releaseDecision(held, ' release text ', { v: 11, editId: 'r' })).toEqual({
      state: 'queued',
      leaseUntil: null,
      note: 'release text',
      noteEditedAt: 11,
      noteEditId: 'r',
    })
    expect(releaseDecision(held, undefined)).toEqual({ state: 'queued', leaseUntil: null })
  })
})

// ----------------------------------------------------------------
// THE PRODUCTION SEQUENCE (rev 4 integration regression). Both EvidenceCapture
// call sites — normal Attach (handleAttach) and pack-mode Report Issue
// (handleRaiseFlag) — run exactly:
//   releaseQueued(evidencePackId, notes, noteKeeper?.prepareRelease(notes))
// prepareRelease shadows each release edit; releaseQueued reconciles those
// shadows INTO the records first; releaseDecision must then accept its own
// exact edit. Real keeper, real shadow storage, real queue, real decisions.
// ----------------------------------------------------------------

function productionKeeper(packId: string) {
  return new CaptureNoteKeeper({
    packId,
    scope: { userId: 'u1', companyId: 'co1', propertyId: 'prop1' },
    persistToQueue: updateQueuedNote, // the same queue the component wires
    onUnsafeChange: () => {},
  })
}

const releasedTo = (id: string) => stateLog.filter((e) => e.id === id).map((e) => e.state)

describe('PRODUCTION SEQUENCE: prepareRelease -> releaseQueued accepts its own exact edit', () => {
  it('one photo: no failure, queued, and the record holds EXACTLY the release edit', async () => {
    await enqueueOne('ph-1', 'pack-prod')
    const keeper = productionKeeper('pack-prod')
    const notes = { 'ph-1': 'Lounge aircon remote present' }
    const edits = keeper.prepareRelease(notes)
    const { failedIds } = await releaseQueued('pack-prod', notes, edits)
    expect(failedIds).toEqual([])
    expect(releasedTo('ph-1')[0]).toBe('queued') // the release transition itself
    const r = store.get('ph-1')!
    expect(r.state).not.toBe('saved_local')
    expect(r.note).toBe('Lounge aircon remote present')
    expect(r.noteEditedAt).toBe(edits['ph-1'].v)
    expect(r.noteEditId).toBe(edits['ph-1'].editId)
    expect(readNoteShadow('pack-prod', 'ph-1')).toBeNull() // proven, so spent
    keeper.dispose()
  })

  it('a whole batch with a note map for EVERY photo (incl. blanks and edge whitespace) all release', async () => {
    for (const id of ['a', 'b', 'c']) await enqueueOne(id, 'pack-batch')
    const keeper = productionKeeper('pack-batch')
    keeper.change('a', 'draft typed before Attach') // earlier edits exist too
    const notes = { a: 'Bedroom 1 linen', b: null, c: '  Balcony door locked \n' }
    const edits = keeper.prepareRelease(notes)
    const { failedIds } = await releaseQueued('pack-batch', notes, edits)
    expect(failedIds).toEqual([])
    for (const id of ['a', 'b', 'c']) {
      expect(releasedTo(id)[0]).toBe('queued')
      expect(store.get(id)!.noteEditId).toBe(edits[id].editId)
      expect(store.get(id)!.noteEditedAt).toBe(edits[id].v)
    }
    expect(store.get('a')!.note).toBe('Bedroom 1 linen')
    expect(store.get('b')!.note).toBeNull()
    expect(store.get('c')!.note).toBe('Balcony door locked')
    keeper.dispose()
  })

  it('if the release shadow could NOT be written, the strictly newer release edit still applies (case d)', async () => {
    await enqueueOne('ph-1', 'pack-noshadow')
    const keeper = new CaptureNoteKeeper({
      packId: 'pack-noshadow',
      scope: { userId: 'u1', companyId: 'co1', propertyId: 'prop1' },
      storage: null, // device storage unusable
      persistToQueue: updateQueuedNote,
      onUnsafeChange: () => {},
    })
    const notes = { 'ph-1': 'Spare key in safe' }
    const edits = keeper.prepareRelease(notes)
    const { failedIds } = await releaseQueued('pack-noshadow', notes, edits)
    expect(failedIds).toEqual([])
    expect(store.get('ph-1')!).toMatchObject({
      note: 'Spare key in safe',
      noteEditedAt: edits['ph-1'].v,
      noteEditId: edits['ph-1'].editId,
    })
  })

  it('an AMBIGUOUS tie at release time is still blocked and reported', async () => {
    await enqueueOne('ph-1', 'pack-tie')
    const keeper = productionKeeper('pack-tie')
    const notes = { 'ph-1': 'release caption' }
    const edits = keeper.prepareRelease(notes)
    // Another tab wrote a DIFFERENT edit at the very same version first.
    await updateQueuedNote('pack-tie', 'ph-1', 'other tab caption', edits['ph-1'].v, 'other-tab')
    const { failedIds } = await releaseQueued('pack-tie', notes, edits)
    expect(failedIds).toEqual(['ph-1'])
    expect(store.get('ph-1')!.state).toBe('saved_local')
    expect(store.get('ph-1')!.note).toBe('other tab caption')
    expect(readNoteShadow('pack-tie', 'ph-1')?.note).toBe('release caption') // kept, not lost
    keeper.dispose()
  })
})

describe('releaseQueued — never continues past an unproven caption', () => {
  it('reconcile storage error: that photo is NOT released, is reported, and keeps its shadow', async () => {
    await enqueueOne('ph-ok', 'pack-rel')
    await enqueueOne('ph-bad', 'pack-rel')
    writeNoteShadow('pack-rel', SH('ph-bad', 'unreconciled caption', 200))
    failGetFor.add('ph-bad')
    const { failedIds } = await releaseQueued(
      'pack-rel',
      { 'ph-ok': 'ok caption', 'ph-bad': 'release text' },
      { 'ph-ok': { v: 300, editId: 'r-ok' }, 'ph-bad': { v: 300, editId: 'r-bad' } },
    )
    expect(failedIds).toContain('ph-bad')
    expect(failedIds).not.toContain('ph-ok')
    expect(store.get('ph-bad')?.note).not.toBe('release text')
    expect(store.get('ph-ok')?.note).toBe('ok caption')
    expect(readNoteShadow('pack-rel', 'ph-bad')?.note).toBe('unreconciled caption')
  })

  it('a release caption that is not provably newer is NOT released and is reported', async () => {
    await enqueueOne('ph-1', 'pack-rel2')
    await updateQueuedNote('pack-rel2', 'ph-1', 'durable A', 5000, 'a')
    const { failedIds } = await releaseQueued(
      'pack-rel2',
      { 'ph-1': 'release text' },
      { 'ph-1': { v: 4000, editId: 'r' } }, // order unprovable
    )
    expect(failedIds).toEqual(['ph-1'])
    expect(store.get('ph-1')?.note).toBe('durable A')
  })
})

// ----------------------------------------------------------------
// rev 5 — REAL drain through the batch fast path.
// ----------------------------------------------------------------

type BatchInputs = Parameters<typeof attachEvidencePhotosBatch>[0]
type BatchInput = BatchInputs[number]
const batchMock = vi.mocked(attachEvidencePhotosBatch)

async function stagedQueued(id: string, packId: string, note: string, v = 100, editId = `e-${id}`) {
  await enqueueOne(id, packId)
  await setState(id, {
    state: 'queued',
    leaseUntil: null,
    bytesStaged: true,
    masterPath: `m/${id}.jpg`,
    thumbPath: `t/${id}.jpg`,
    retentionClass: 'routine_pre_arrival',
    note,
    noteEditedAt: v,
    noteEditId: editId,
  })
}

describe('ITEM 1 — 2,000 accepted, 2,001 REFUSED at the attach boundary (real drain)', () => {
  it('2,001 chars: never sent, record + full caption KEPT, no partial attach', async () => {
    batchMock.mockImplementation(async (inputs: BatchInputs) => ({
      ok: true,
      results: inputs.map((i) => ({ photoId: i.photoId, ok: true })),
    }))
    batchMock.mockClear()
    await stagedQueued('long', 'pack-limit', 'x'.repeat(2001))
    await drainQueue('pack-limit')
    const sent = batchMock.mock.calls.flatMap((c) => c[0] as BatchInput[]).map((i) => i.photoId)
    expect(sent).not.toContain('long')
    const kept = store.get('long')!
    expect(kept).toBeTruthy() // NOT deleted
    expect((kept.note as string).length).toBe(2001) // NOT truncated
    expect(kept.state).toBe('failed')
  })

  it('exactly 2,000 chars: attached with the FULL caption, then the record is removed', async () => {
    batchMock.mockImplementation(async (inputs: BatchInputs) => ({
      ok: true,
      results: inputs.map((i) => ({ photoId: i.photoId, ok: true })),
    }))
    batchMock.mockClear()
    await stagedQueued('ok2000', 'pack-limit2', 'y'.repeat(2000))
    await drainQueue('pack-limit2')
    const sent = batchMock.mock.calls.flatMap((c) => c[0] as BatchInput[])
    expect(sent.find((i) => i.photoId === 'ok2000')?.note).toBe('y'.repeat(2000))
    expect(store.has('ok2000')).toBe(false)
  })
})

describe('ITEM 10 — high-water-mark lifecycle after an AUTHORITATIVE attach', () => {
  it('attach success with no newer shadow removes the mark', async () => {
    batchMock.mockImplementation(async (inputs: BatchInputs) => ({
      ok: true,
      results: inputs.map((i) => ({ photoId: i.photoId, ok: true })),
    }))
    await stagedQueued('h1', 'pack-hwm', 'final', 500, 'f')
    bumpHighWater('pack-hwm', 'h1', 500)
    await drainQueue('pack-hwm')
    expect(store.has('h1')).toBe(false)
    expect(readHighWater('pack-hwm', 'h1')).toBe(0) // spent
  })

  it('a NEWER shadow written while the attach is in flight is KEPT, and so is its mark', async () => {
    await stagedQueued('h2', 'pack-hwm2', 'sent text', 500, 'sent')
    bumpHighWater('pack-hwm2', 'h2', 500)
    batchMock.mockImplementation(async (inputs: BatchInputs) => {
      // The inspector types again DURING the attach round trip.
      bumpHighWater('pack-hwm2', 'h2', 600)
      writeNoteShadow('pack-hwm2', SH('h2', 'typed during attach', 600, 'newer'))
      return { ok: true, results: inputs.map((i) => ({ photoId: i.photoId, ok: true })) }
    })
    await drainQueue('pack-hwm2')
    expect(store.has('h2')).toBe(false) // the attached version is done
    expect(readNoteShadow('pack-hwm2', 'h2')?.note).toBe('typed during attach') // NOT cleared
    expect(readHighWater('pack-hwm2', 'h2')).toBe(600) // NOT cleared
  })
})

describe('ITEMS 3 + 4 — the handoff over the REAL queue fails closed', () => {
  it('a photo the queue cannot take makes the handoff fail (Report issue must not navigate)', async () => {
    await enqueueOne('ok-1', 'pack-h')
    await enqueueOne('bad-1', 'pack-h')
    writeNoteShadow('pack-h', SH('bad-1', 'unreconciled', 200))
    failGetFor.add('bad-1')
    const result = await handOffPackRelease({
      packId: 'pack-h',
      notes: { 'ok-1': 'a', 'bad-1': 'b' },
      release: releaseQueued,
    })
    expect(result).toMatchObject({ ok: false, reason: 'release_failed', failedIds: ['bad-1'] })
  })

  it('device storage unusable: the release caption is made IndexedDB-PROVEN before release', async () => {
    await enqueueOne('ph-1', 'pack-h2')
    const keeper = new CaptureNoteKeeper({
      packId: 'pack-h2',
      scope: { userId: 'u1', companyId: 'co1', propertyId: 'prop1' },
      storage: null,
      persistToQueue: updateQueuedNote,
      onUnsafeChange: () => {},
    })
    const result = await handOffPackRelease({
      packId: 'pack-h2',
      notes: { 'ph-1': 'Spare key in safe' },
      secureRelease: (n) => keeper.secureRelease(n),
      release: releaseQueued,
    })
    expect(result).toEqual({ ok: true })
    expect(store.get('ph-1')!.note).toBe('Spare key in safe')
    expect(releasedTo('ph-1')[0]).toBe('queued')
  })

  it('device storage unusable AND the IndexedDB proof fails: NOTHING is released', async () => {
    await enqueueOne('ph-1', 'pack-h3')
    const keeper = new CaptureNoteKeeper({
      packId: 'pack-h3',
      scope: { userId: 'u1', companyId: 'co1', propertyId: 'prop1' },
      storage: null,
      persistToQueue: async () => false, // IDB write refused / failed
      onUnsafeChange: () => {},
    })
    const release = vi.fn(releaseQueued)
    const result = await handOffPackRelease({
      packId: 'pack-h3',
      notes: { 'ph-1': 'caption' },
      secureRelease: (n) => keeper.secureRelease(n),
      release,
    })
    expect(result).toMatchObject({ ok: false, reason: 'caption_unsafe' })
    expect(release).not.toHaveBeenCalled()
    expect(store.get('ph-1')!.state).toBe('saved_local')
  })
})

// ----------------------------------------------------------------
// rev 6 — PackQueuePanel recovery path: "Attach N saved photos" on the
// property page calls releaseQueued(packId) with NO caption map. Proven with
// the REAL releaseQueued -> reconcileNoteShadows -> releaseDecision(note ===
// undefined) over the same CAS double + REAL shadow module.
// ----------------------------------------------------------------

describe('PackQueuePanel recovery — releaseQueued(packId) with no caption map', () => {
  it('(1) a saved_local photo WITH a caption keeps the exact caption, version and identity', async () => {
    await enqueueOne('ph-1', 'pack-panel-1')
    await updateQueuedNote('pack-panel-1', 'ph-1', 'Lounge aircon remote present', 500, 'e-lounge')
    const { failedIds } = await releaseQueued('pack-panel-1')
    expect(failedIds).toEqual([])
    expect(releasedTo('ph-1')[0]).toBe('queued')
    expect(store.get('ph-1')!).toMatchObject({
      note: 'Lounge aircon remote present',
      noteEditedAt: 500,
      noteEditId: 'e-lounge',
    })
  })

  it('(2) a NEWER caption that exists only in the device shadow is reconciled FIRST, then queued exactly', async () => {
    await enqueueOne('ph-1', 'pack-panel-2')
    await updateQueuedNote('pack-panel-2', 'ph-1', 'older durable caption', 500, 'e-old')
    // Typed on the capture screen, page killed before the IndexedDB write.
    writeNoteShadow('pack-panel-2', SH('ph-1', 'newer caption only in the shadow', 900, 'e-new'))
    const { failedIds } = await releaseQueued('pack-panel-2')
    expect(failedIds).toEqual([])
    expect(releasedTo('ph-1')[0]).toBe('queued')
    expect(store.get('ph-1')!).toMatchObject({
      note: 'newer caption only in the shadow',
      noteEditedAt: 900,
      noteEditId: 'e-new',
    })
    expect(readNoteShadow('pack-panel-2', 'ph-1')).toBeNull() // proven, so spent
  })

  it.each([
    [
      'storage error while persisting the shadow',
      async () => {
        failClaimFor.add('ph-bad')
      },
    ],
    [
      'same-version tie with a different identity',
      async () => {
        await updateQueuedNote('pack-panel-3', 'ph-bad', 'other tab caption', 900, 'other-tab')
      },
    ],
    [
      'durable version higher with different text',
      async () => {
        await updateQueuedNote('pack-panel-3', 'ph-bad', 'other tab caption', 5000, 'other-tab')
      },
    ],
  ])(
    '(3) newer shadow cannot be proven (%s): photo stays saved_local and is in failedIds',
    async (_label, arrange) => {
      await enqueueOne('ph-ok', 'pack-panel-3')
      await enqueueOne('ph-bad', 'pack-panel-3')
      await updateQueuedNote('pack-panel-3', 'ph-ok', 'fine caption', 100, 'e-ok')
      writeNoteShadow('pack-panel-3', SH('ph-bad', 'unproven newer caption', 900, 'e-shadow'))
      await arrange()
      const before = { ...store.get('ph-bad')! }
      const { failedIds } = await releaseQueued('pack-panel-3')
      failClaimFor.clear()
      expect(failedIds).toEqual(['ph-bad'])
      expect(releasedTo('ph-bad')).not.toContain('queued')
      expect(store.get('ph-bad')!.state).toBe('saved_local')
      expect(store.get('ph-bad')!.note).toBe(before.note) // durable caption untouched
      expect(readNoteShadow('pack-panel-3', 'ph-bad')?.note).toBe('unproven newer caption') // kept
      // The provable photo in the same pack still releases with its caption.
      expect(releasedTo('ph-ok')[0]).toBe('queued')
      expect(store.get('ph-ok')!.note).toBe('fine caption')
    },
  )

  it('(4) the recovery release NEVER replaces a stored caption with null or blank', async () => {
    const captions: Record<string, string | null> = {
      a: 'Bedroom 1 linen',
      b: 'Balcony door locked',
      c: null, // blank BY CHOICE stays blank — not invented either
    }
    let v = 100
    for (const [id, note] of Object.entries(captions)) {
      await enqueueOne(id, 'pack-panel-4')
      await updateQueuedNote('pack-panel-4', id, note, (v += 100), `e-${id}`)
    }
    const before = Object.fromEntries(
      Object.keys(captions).map((id) => [id, { ...store.get(id)! }]),
    )
    const { failedIds } = await releaseQueued('pack-panel-4')
    expect(failedIds).toEqual([])
    for (const id of Object.keys(captions)) {
      expect(releasedTo(id)[0]).toBe('queued')
      expect(store.get(id)!.note).toBe(before[id].note)
      expect(store.get(id)!.noteEditedAt).toBe(before[id].noteEditedAt)
      expect(store.get(id)!.noteEditId).toBe(before[id].noteEditId)
    }
    // The decision itself: with note === undefined the patch carries NO
    // caption fields at all — only the saved_local -> queued transition.
    const patch = releaseDecision(
      { ...(before.a as unknown as QueuedPhotoMeta), state: 'saved_local' },
      undefined,
    )
    expect(patch).toEqual({ state: 'queued', leaseUntil: null })
  })

  it('(5) SOURCE CONTRACT: PackQueuePanel calls releaseQueued(packId) without manufacturing a caption', () => {
    const panel = readFileSync(
      join(process.cwd(), 'src/components/photos/pack-queue-panel.tsx'),
      'utf8',
    )
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const calls = panel.match(/releaseQueued\([^)]*\)/g) ?? []
    expect(calls).toEqual(['releaseQueued(packId)']) // exactly one call, one argument
    expect(panel).not.toMatch(/notesById|editsById|prepareRelease|secureRelease/)
  })
})

// ----------------------------------------------------------------
// rev 8 — EXACT intended-photo coverage; no false success anywhere.
// Real enqueue / releaseQueued / reconcile / handOffPackRelease over the CAS
// double, plus the pure session bookkeeping BOTH EvidenceCapture call sites
// use (idsToHandOff / applyHandoffOutcome / packRowStatus / evaluateBatch).
// ----------------------------------------------------------------

/** Report issue's navigation predicate, exactly as handleRaiseFlag applies it. */
const mayNavigate = (ok: boolean, next: 'done' | 'review') => ok && next === 'done'

async function handOff(packId: string, notes: Record<string, string | null>) {
  const keeper = productionKeeper(packId)
  const res = await handOffPackRelease({
    packId,
    notes,
    secureRelease: (n) => keeper.secureRelease(n),
    release: releaseQueued,
  })
  keeper.dispose()
  return res
}

const queuedCount = (id: string) => releasedTo(id).filter((st) => st === 'queued').length

describe('REV 8 (C1) — an intended photo missing from the queue is FAILED, never omitted', () => {
  it('intended {a,b}, only a exists: releaseQueued reports b', async () => {
    await enqueueOne('a', 'pack-r8-1')
    const { failedIds } = await releaseQueued('pack-r8-1', { a: 'A caption', b: 'B caption' })
    expect(failedIds).toEqual(['b'])
    expect(queuedCount('a')).toBe(1)
  })

  it('the shared handoff is NOT successful, and names exactly what was proven', async () => {
    await enqueueOne('a', 'pack-r8-1b')
    const res = await handOff('pack-r8-1b', { a: 'A caption', b: 'B caption' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('release_failed')
    expect(res.failedIds).toEqual(['b'])
    expect(res.handedOffIds).toEqual(['a'])
    expect(res.message).not.toMatch(/safe/i) // never claims b is safely stored
    const outcome = applyHandoffOutcome(new Set(), ['a', 'b'], res)
    expect(mayNavigate(res.ok, outcome.next)).toBe(false) // Report issue stays put
  })

  it('unrelated saved_local photos of the same pack neither release nor contaminate the result', async () => {
    await enqueueOne('a', 'pack-r8-1c')
    await enqueueOne('unrelated', 'pack-r8-1c')
    const { failedIds } = await releaseQueued('pack-r8-1c', { a: 'A caption' })
    expect(failedIds).toEqual([])
    expect(queuedCount('unrelated')).toBe(0)
    expect(store.get('unrelated')!.state).toBe('saved_local')
  })
})

describe('REV 8 (C1b) — a record that VANISHES between listing and claim is not proof', () => {
  it('it is failed, never counted as handed off', async () => {
    await enqueueOne('a', 'pack-r8-v')
    await enqueueOne('b', 'pack-r8-v')
    vanishOnClaim.add('b')
    const { failedIds } = await releaseQueued('pack-r8-v', { a: 'A', b: 'B' })
    expect(failedIds).toEqual(['b'])
    expect(queuedCount('a')).toBe(1)
  })
})

describe('REV 8 (C2) — an unreadable queue listing fails EVERY intended photo', () => {
  it('listQueuedForPack throws: all intended ids failed (never []), nothing released', async () => {
    await enqueueOne('a', 'pack-r8-2')
    await enqueueOne('b', 'pack-r8-2')
    failList.current = true
    const { failedIds } = await releaseQueued('pack-r8-2', { a: 'A', b: 'B' })
    expect(failedIds).toEqual(['a', 'b'])
    expect(queuedCount('a') + queuedCount('b')).toBe(0)
  })

  it('Report issue stays put: handoff not ok, outcome is review, no proven photos', async () => {
    await enqueueOne('a', 'pack-r8-2b')
    failList.current = true
    const res = await handOff('pack-r8-2b', { a: 'A', b: 'B' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.failedIds).toEqual(['a', 'b'])
    expect(res.handedOffIds).toEqual([])
    const outcome = applyHandoffOutcome(new Set(), ['a', 'b'], res)
    expect(outcome.next).toBe('review')
    expect(mayNavigate(res.ok, outcome.next)).toBe(false)
    expect([...outcome.handedOff]).toEqual([])
  })
})

describe('REV 8 (C3) — normal Attach can never show Done for the missing photo', () => {
  it('the missing id never joins the Done batch; its row is never "attached"', async () => {
    await enqueueOne('a', 'pack-r8-3')
    const res = await handOff('pack-r8-3', { a: 'A', b: 'B' })
    const outcome = applyHandoffOutcome(new Set(), ['a', 'b'], res)
    expect(outcome.next).toBe('review') // Attach does not go to the Done stage
    expect(outcome.handedOff.has('b')).toBe(false)
    // Even once a attaches (record deleted after confirmation) the gate is
    // about a only — b was never counted, so it can never read as attached.
    store.delete('a')
    const batch = evaluateBatch(outcome.handedOff, [], true, new Set())
    expect(batch.total).toBe(1)
    expect(packRowStatus(outcome.handedOff.has('b'), undefined, true)).toBe('not_attached')
    expect(packRowStatus(outcome.handedOff.has('a'), undefined, true)).toBe('attached')
    // The OLD bookkeeping (every ready id joined the batch) produced exactly
    // the false Done chat found: complete with b never stored.
    expect(evaluateBatch(new Set(['a', 'b']), [], true, new Set()).complete).toBe(true)
  })
})

describe('REV 8 (C4) — partial handoff: proven photos continue ONCE; failed ones stay retryable', () => {
  it('a continues exactly once; b stays visible, is retried alone, nothing discarded or duplicated', async () => {
    await enqueueOne('a', 'pack-r8-4')
    const first = await handOff('pack-r8-4', { a: 'A', b: 'B' })
    let session = applyHandoffOutcome(new Set(), ['a', 'b'], first)
    expect([...session.handedOff]).toEqual(['a'])
    expect(session.failedIds).toEqual(['b'])

    // b becomes available (e.g. the inspector retook it) and Attach is tapped
    // again with BOTH photos still on the review screen.
    await enqueueOne('b', 'pack-r8-4')
    const intended = idsToHandOff(['a', 'b'], session.handedOff)
    expect(intended).toEqual(['b']) // a is never resent
    const second = await handOff('pack-r8-4', { b: 'B' })
    expect(second).toEqual({ ok: true })
    session = applyHandoffOutcome(session.handedOff, intended, second)
    expect(session.next).toBe('done')
    expect([...session.handedOff].sort()).toEqual(['a', 'b'])

    expect(queuedCount('a')).toBe(1) // exactly once
    expect(queuedCount('b')).toBe(1)
    for (const id of ['a', 'b']) expect(store.get(id)?.discardRequested ?? false).toBe(false)
    expect(store.get('a')!.note).toBe('A')
    expect(store.get('b')!.note).toBe('B')
  })
})

describe('REV 8 (C5) — PackQueuePanel releaseQueued(packId) keeps its recovery behaviour', () => {
  it('no caption map: every saved_local photo of the pack releases, captions untouched', async () => {
    await enqueueOne('x', 'pack-r8-5')
    await enqueueOne('y', 'pack-r8-5')
    await updateQueuedNote('pack-r8-5', 'x', 'kept caption', 300, 'e-x')
    const { failedIds } = await releaseQueued('pack-r8-5')
    expect(failedIds).toEqual([])
    expect(queuedCount('x')).toBe(1)
    expect(queuedCount('y')).toBe(1)
    expect(store.get('x')!).toMatchObject({ note: 'kept caption', noteEditedAt: 300, noteEditId: 'e-x' })
  })

  it('no caption map + unreadable listing: unchanged (the panel\u2019s storageError surface owns it)', async () => {
    await enqueueOne('x', 'pack-r8-5b')
    failList.current = true
    expect(await releaseQueued('pack-r8-5b')).toEqual({ failedIds: [] })
  })
})

// ----------------------------------------------------------------
// rev 9 — capture exit + single flight, over the REAL queue.
// `exit` follows EvidenceCapture's handler protocol step for step (the
// contract test in report-issue-contract.test.ts pins the component to it):
// claim the gate synchronously -> plan -> refuse if not allowed -> hand off
// only not-yet-proven photos -> record into the gate -> navigate (Report
// issue, keeping the gate claimed) or finish -> leave unless navigating.
// ----------------------------------------------------------------

type ExitKind = 'attach' | 'report'

function exitRig(packId: string) {
  const gate = new CaptureExitGate()
  const releases: string[][] = []
  const navigations: number[] = []
  let hold: Promise<void> | null = null
  let open!: () => void
  const slowNextRelease = () => {
    hold = new Promise<void>((r) => (open = r))
  }
  const exit = async (kind: ExitKind, photos: CapturePhotoLite[]) => {
    if (!gate.tryEnter()) return 'busy'
    let navigating = false
    try {
      const plan = planCaptureExit(photos, gate.handedOff(), 'pack')
      if (!plan.allowed) return 'blocked'
      const intended = idsToHandOff(plan.eligibleIds, gate.handedOff())
      if (intended.length > 0) {
        const notes = Object.fromEntries(intended.map((id) => [id, `caption ${id}`]))
        const res = await handOffPackRelease({
          packId,
          notes,
          release: async (pid, n, e) => {
            releases.push(Object.keys(n))
            if (hold) await hold
            return releaseQueued(pid, n, e)
          },
        })
        if (gate.record(intended, res).next !== 'done') return 'review'
      }
      if (kind === 'report') {
        navigating = true
        navigations.push(Date.now())
      }
      return 'proceeded'
    } finally {
      if (!navigating) gate.leave()
    }
  }
  return { gate, exit, releases, navigations, slowNextRelease, release: () => open() }
}

const P = (id: string, state: CapturePhotoLite['state']): CapturePhotoLite => ({
  id,
  state,
  hasBytes: state === 'ready',
})

describe('REV 9 — Report issue / Attach never abandon a processing or failed photo', () => {
  it('(A) zero ready + one compressing: Report issue does not navigate, nothing released', async () => {
    const rig = exitRig('pack-r9-a')
    expect(await rig.exit('report', [P('a', 'compressing')])).toBe('blocked')
    expect(rig.navigations).toEqual([])
    expect(rig.releases).toEqual([])
  })

  it('(B) one ready + one compressing: NEITHER action processes the ready subset', async () => {
    await enqueueOne('a', 'pack-r9-b')
    const rig = exitRig('pack-r9-b')
    const photos = [P('a', 'ready'), P('b', 'compressing')]
    expect(await rig.exit('attach', photos)).toBe('blocked')
    expect(await rig.exit('report', photos)).toBe('blocked')
    expect(rig.releases).toEqual([])
    expect(rig.navigations).toEqual([])
    expect(store.get('a')!.state).toBe('saved_local') // untouched
  })

  it('(C) one ready + one error: blocked, nothing released or navigated', async () => {
    await enqueueOne('a', 'pack-r9-c')
    const rig = exitRig('pack-r9-c')
    expect(await rig.exit('report', [P('a', 'ready'), P('b', 'error')])).toBe('blocked')
    expect(rig.releases).toEqual([])
    expect(rig.navigations).toEqual([])
  })

  it('(D) pending empty: Report issue navigates WITHOUT calling release', async () => {
    const rig = exitRig('pack-r9-d')
    expect(await rig.exit('report', [])).toBe('proceeded')
    expect(rig.releases).toEqual([])
    expect(rig.navigations.length).toBe(1)
  })

  it('(E) a later round neither blocks on nor resends earlier proven photos', async () => {
    await enqueueOne('a', 'pack-r9-e')
    const rig = exitRig('pack-r9-e')
    expect(await rig.exit('attach', [P('a', 'ready')])).toBe('proceeded')
    store.delete('a') // a attached; its record is gone (NOT a failure)
    await enqueueOne('b', 'pack-r9-e')
    expect(await rig.exit('report', [P('a', 'ready'), P('b', 'ready')])).toBe('proceeded')
    expect(rig.releases).toEqual([['a'], ['b']]) // a never resent
    expect(queuedCount('a')).toBe(1)
    expect(queuedCount('b')).toBe(1)
  })
})

describe('REV 9 — single flight across Attach and Report issue', () => {
  it('(F) two rapid Report issue taps: exactly ONE handoff and ONE navigation', async () => {
    await enqueueOne('a', 'pack-r9-f')
    const rig = exitRig('pack-r9-f')
    rig.slowNextRelease()
    const first = rig.exit('report', [P('a', 'ready')])
    const second = rig.exit('report', [P('a', 'ready')]) // same tick, stale snapshot
    expect(await second).toBe('busy')
    rig.release()
    expect(await first).toBe('proceeded')
    // A third tap after navigation started is ALSO refused (gate kept).
    expect(await rig.exit('report', [P('a', 'ready')])).toBe('busy')
    expect(rig.releases).toEqual([['a']])
    expect(rig.navigations.length).toBe(1)
    expect(queuedCount('a')).toBe(1)
  })

  it('(G) Attach and Report issue started together: only one wins', async () => {
    await enqueueOne('a', 'pack-r9-g')
    const rig = exitRig('pack-r9-g')
    rig.slowNextRelease()
    const attach = rig.exit('attach', [P('a', 'ready')])
    const report = rig.exit('report', [P('a', 'ready')])
    expect(await report).toBe('busy')
    rig.release()
    expect(await attach).toBe('proceeded')
    expect(rig.releases).toEqual([['a']])
    expect(rig.navigations).toEqual([])
    // Attach left the gate: a later Report issue proceeds WITHOUT resending a.
    expect(await rig.exit('report', [P('a', 'ready')])).toBe('proceeded')
    expect(rig.releases).toEqual([['a']])
    expect(rig.navigations.length).toBe(1)
  })

  it('(H) the proven set after concurrent rounds keeps every proven id', async () => {
    await enqueueOne('a', 'pack-r9-h')
    await enqueueOne('b', 'pack-r9-h')
    const rig = exitRig('pack-r9-h')
    expect(await rig.exit('attach', [P('a', 'ready')])).toBe('proceeded')
    expect(await rig.exit('attach', [P('a', 'ready'), P('b', 'ready')])).toBe('proceeded')
    expect([...rig.gate.handedOff()].sort()).toEqual(['a', 'b'])
  })
})
