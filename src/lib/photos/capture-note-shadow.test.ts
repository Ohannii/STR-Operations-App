import { describe, it, expect } from 'vitest'
import {
  BATCH_NOTE_UNSAFE_ID,
  CaptureNoteKeeper,
  allocateNoteVersion,
  clearHighWaterIfSettled,
  readBatchNote,
  removeHighWater,
  bumpHighWater,
  clearNoteShadowIfIdentity,
  nextNoteVersion,
  readHighWater,
  readNoteShadow,
  readNoteShadows,
  removeNoteShadow,
  shadowKey,
  shadowSatisfied,
  writeNoteShadow,
  type NoteShadow,
  type ShadowStorage,
} from './capture-note-shadow'
import { noteEditDecision, type QueuedPhotoMeta } from './photo-queue-state'

/**
 * CAPTURE CAPTION SHADOW (rev 4, 26 Oct). Proves, without a DOM:
 *   - the synchronous shadow write and its failure modes;
 *   - ordering via a PERSISTED high-water mark that survives keeper remounts,
 *     multiple keepers (tabs) and a clock that goes backwards;
 *   - proof is IDENTITY: a larger durable version with different text is
 *     never "satisfied";
 *   - a shadow is cleared only by its own identity, so a stale async
 *     completion can never clear the current shadow.
 */

function memStorage(opts?: { failWrites?: boolean }): ShadowStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if (opts?.failWrites) throw new Error('QuotaExceededError')
      map.set(k, v)
    },
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

const SHADOW = (photoId: string, note: string | null, v: number, editId = `id-${v}`): NoteShadow => ({
  photoId,
  note,
  v,
  editId,
  userId: 'u1',
  companyId: 'co1',
  propertyId: 'prop1',
})

describe('synchronous shadow write', () => {
  it('persists on the SAME call — no debounce, no await', () => {
    const s = memStorage()
    expect(writeNoteShadow('pack-1', SHADOW('ph-1', 'typed then killed', 100), s)).toBe(true)
    expect(readNoteShadows('pack-1', s)).toEqual([SHADOW('ph-1', 'typed then killed', 100)])
  })

  it('returns FALSE on quota/private-mode failure — the caller must not claim safety', () => {
    expect(writeNoteShadow('pack-1', SHADOW('ph-1', 'x', 100), memStorage({ failWrites: true }))).toBe(false)
    expect(writeNoteShadow('pack-1', SHADOW('ph-1', 'x', 100), null)).toBe(false)
  })

  it('reads are scoped per pack, ignore corrupt entries and identity-less shadows', () => {
    const s = memStorage()
    writeNoteShadow('pack-1', SHADOW('ph-1', 'one', 1), s)
    writeNoteShadow('pack-2', SHADOW('ph-9', 'other pack', 1), s)
    s.map.set(shadowKey('pack-1', 'ph-corrupt'), 'not json {{{')
    const { editId: _omit, ...noId } = SHADOW('ph-noid', 'x', 1)
    void _omit
    s.map.set(shadowKey('pack-1', 'ph-noid'), JSON.stringify(noId))
    expect(readNoteShadows('pack-1', s)).toEqual([SHADOW('ph-1', 'one', 1)])
  })
})

describe('clearing is by IDENTITY only', () => {
  it('clears when the current shadow is exactly that edit', () => {
    const s = memStorage()
    writeNoteShadow('pack-1', SHADOW('ph-1', 'x', 100, 'edit-A'), s)
    clearNoteShadowIfIdentity('pack-1', 'ph-1', 'edit-A', s)
    expect(readNoteShadows('pack-1', s)).toEqual([])
  })

  it('(d) a STALE async completion cannot clear the CURRENT shadow', () => {
    const s = memStorage()
    writeNoteShadow('pack-1', SHADOW('ph-1', 'newer', 200, 'edit-B'), s)
    clearNoteShadowIfIdentity('pack-1', 'ph-1', 'edit-A', s) // older edit's completion
    clearNoteShadowIfIdentity('pack-1', 'ph-1', null, s)
    expect(readNoteShadow('pack-1', 'ph-1', s)?.editId).toBe('edit-B')
  })

  it('removeNoteShadow is the explicit discard path', () => {
    const s = memStorage()
    writeNoteShadow('pack-1', SHADOW('ph-1', 'x', 1), s)
    removeNoteShadow('pack-1', 'ph-1', s)
    expect(readNoteShadows('pack-1', s)).toEqual([])
  })
})

describe('shadowSatisfied — proof is EXACT identity', () => {
  it('same identity, version and text => satisfied', () => {
    expect(
      shadowSatisfied({ note: 'B', noteEditedAt: 1000, noteEditId: 'b' }, { note: 'B', v: 1000, editId: 'b' }),
    ).toBe(true)
  })

  it('(c) durable version HIGHER but different caption/identity => NOT satisfied', () => {
    expect(
      shadowSatisfied({ note: 'A', noteEditedAt: 2000, noteEditId: 'a' }, { note: 'B', v: 1000, editId: 'b' }),
    ).toBe(false)
  })

  it('same text at a higher version but a different identity is still NOT proof', () => {
    expect(
      shadowSatisfied({ note: 'B', noteEditedAt: 2000, noteEditId: 'z' }, { note: 'B', v: 1000, editId: 'b' }),
    ).toBe(false)
  })

  it('same identity but tampered text or version is NOT proof', () => {
    expect(
      shadowSatisfied({ note: 'X', noteEditedAt: 1000, noteEditId: 'b' }, { note: 'B', v: 1000, editId: 'b' }),
    ).toBe(false)
    expect(
      shadowSatisfied({ note: 'B', noteEditedAt: 999, noteEditId: 'b' }, { note: 'B', v: 1000, editId: 'b' }),
    ).toBe(false)
  })
})

describe('persisted high-water mark', () => {
  it('versions are strictly above the persisted mark even when the clock goes backwards', () => {
    const s = memStorage()
    expect(allocateNoteVersion('p', 'ph', 5000, undefined, s)).toBe(5000)
    expect(readHighWater('p', 'ph', s)).toBe(5000)
    expect(allocateNoteVersion('p', 'ph', 1000, undefined, s)).toBe(5001) // clock rolled back
  })

  it('bumpHighWater only ever raises the mark', () => {
    const s = memStorage()
    bumpHighWater('p', 'ph', 300, s)
    bumpHighWater('p', 'ph', 100, s)
    expect(readHighWater('p', 'ph', s)).toBe(300)
  })

  it('nextNoteVersion is strictly monotonic', () => {
    expect(nextNoteVersion(undefined, 1000)).toBe(1000)
    expect(nextNoteVersion(1000, 1000)).toBe(1001)
    expect(nextNoteVersion(1001, 900)).toBe(1002)
  })
})

// ----------------------------------------------------------------
// CaptureNoteKeeper, with a REAL noteEditDecision record so out-of-order
// IndexedDB writes are proven, not assumed.
// ----------------------------------------------------------------

type Persist = { note: string | null; v: number; editId: string; resolve: (ok: boolean) => void }

function makeRecord(): QueuedPhotoMeta {
  return {
    id: 'ph-1', userId: 'u1', companyId: 'co1', propertyId: 'prop1', packId: 'pack-k',
    capturedAt: '', note: null, noteEditedAt: 0, noteEditId: null, width: 1, height: 1,
    sizeBytes: 1, state: 'saved_local', lastError: null, attempts: 0, lastAttemptAt: null,
  } as unknown as QueuedPhotoMeta
}

let idSeq = 0
function keeperHarness(opts: { storage?: ShadowStorage; now?: () => number; shadowFails?: boolean } = {}) {
  const storage = opts.storage ?? memStorage({ failWrites: opts.shadowFails })
  const timers: Array<{ fn: () => void; cancelled: boolean }> = []
  const persists: Persist[] = []
  let unsafe: ReadonlySet<string> = new Set()
  const keeper = new CaptureNoteKeeper({
    packId: 'pack-k',
    scope: { userId: 'u1', companyId: 'co1', propertyId: 'prop1' },
    storage,
    persistToQueue: (_p, _id, note, v, editId) =>
      new Promise<boolean>((resolve) => persists.push({ note, v, editId, resolve })),
    onUnsafeChange: (ids) => {
      unsafe = ids
    },
    now: opts.now ?? (() => 1000),
    makeEditId: () => `edit-${++idSeq}`,
    setTimeoutFn: (fn) => {
      const t = { fn, cancelled: false }
      timers.push(t)
      return t as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeoutFn: (t) => {
      ;(t as unknown as { cancelled: boolean }).cancelled = true
    },
  })
  return {
    keeper,
    storage,
    persists,
    fireTimers: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn()
    },
    unsafe: () => unsafe,
  }
}

/** Apply a persist to the record with the REAL decision. */
function applyTo(record: QueuedPhotoMeta, p: Persist): QueuedPhotoMeta {
  const patch = noteEditDecision(record, p.note, p.v, p.editId)
  return patch ? { ...record, ...patch } : record
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('type then immediately blur', () => {
  it('the EXACT latest text survives; the blur never writes a stale render value', () => {
    const h = keeperHarness()
    h.keeper.change('ph-1', 'Gey')
    h.keeper.blur('ph-1', 'Geyser valve closed') // DOM value newer than render state
    const shadow = readNoteShadow('pack-k', 'ph-1', h.storage)
    expect(shadow?.note).toBe('Geyser valve closed')
    h.fireTimers() // the superseded debounce never runs
    expect(h.persists.map((p) => p.note)).toEqual(['Geyser valve closed'])
    const rec = applyTo(makeRecord(), h.persists[0])
    expect(rec.note).toBe('Geyser valve closed')
    expect(shadowSatisfied(rec, shadow!)).toBe(true)
  })

  it('termination BEFORE the debounce fires: the shadow alone holds the exact text', () => {
    const h = keeperHarness()
    h.keeper.change('ph-1', 'typed 50ms before the phone killed the page')
    expect(h.persists.length).toBe(0)
    expect(readNoteShadow('pack-k', 'ph-1', h.storage)?.note).toBe(
      'typed 50ms before the phone killed the page',
    )
  })
})

describe('(a) keeper REMOUNT + clock going BACKWARDS', () => {
  it('the genuinely later caption gets the higher version and wins', () => {
    const storage = memStorage()
    const first = keeperHarness({ storage, now: () => 2000 })
    first.keeper.blur('ph-1', 'A')
    let rec = applyTo(makeRecord(), first.persists[0]) // IndexedDB holds A @2000
    clearNoteShadowIfIdentity('pack-k', 'ph-1', first.persists[0].editId, storage) // shadow spent
    first.keeper.dispose()

    // Remount on a device whose clock is now BEHIND.
    const second = keeperHarness({ storage, now: () => 1000 })
    second.keeper.blur('ph-1', 'B')
    const shadowB = readNoteShadow('pack-k', 'ph-1', storage)!
    expect(shadowB.v).toBeGreaterThan(2000) // persisted mark, not the clock
    rec = applyTo(rec, second.persists[0])
    expect(rec.note).toBe('B')
    expect(shadowSatisfied(rec, shadowB)).toBe(true)
  })

  it('if the mark was LOST, the later caption is refused and its shadow is NOT satisfied (fail closed)', () => {
    const first = keeperHarness({ now: () => 2000 })
    first.keeper.blur('ph-1', 'A')
    const rec = applyTo(makeRecord(), first.persists[0]) // A @2000

    const wiped = memStorage() // device storage wiped; IndexedDB kept A
    const second = keeperHarness({ storage: wiped, now: () => 1000 })
    second.keeper.blur('ph-1', 'B')
    const shadowB = readNoteShadow('pack-k', 'ph-1', wiped)!
    const after = applyTo(rec, second.persists[0])
    expect(after.note).toBe('A') // B refused: order unprovable
    expect(shadowSatisfied(after, shadowB)).toBe(false) // B kept, attach blocked, text NOT lost
  })
})

describe('(b) two keeper instances (tabs) in the SAME millisecond', () => {
  it('sequential allocation through the shared mark orders them; the later caption wins', () => {
    const storage = memStorage()
    const tab1 = keeperHarness({ storage, now: () => 1000 })
    const tab2 = keeperHarness({ storage, now: () => 1000 })
    tab1.keeper.blur('ph-1', 'from tab 1')
    tab2.keeper.blur('ph-1', 'from tab 2')
    expect(tab2.persists[0].v).toBeGreaterThan(tab1.persists[0].v)
    // Even if IndexedDB applies them in REVERSE order, tab 2 (later) wins.
    let rec = applyTo(makeRecord(), tab2.persists[0])
    rec = applyTo(rec, tab1.persists[0])
    expect(rec.note).toBe('from tab 2')
  })

  it('a true simultaneous TIE (same version, different identity) is refused — never resolved by guess', () => {
    // Simulate two tabs that read the shared mark before either wrote it.
    const rec0 = makeRecord()
    const a = { note: 'tab A', v: 1000, editId: 'A', resolve: () => {} }
    const b = { note: 'tab B', v: 1000, editId: 'B', resolve: () => {} }
    const rec = applyTo(applyTo(rec0, a), b)
    expect(rec.note).toBe('tab A') // first durable write stands
    // The shadow key holds the LAST writer (B): not satisfied -> kept, attach blocked.
    expect(shadowSatisfied(rec, { note: 'tab B', v: 1000, editId: 'B' })).toBe(false)
  })
})

describe('the unsafe warning is truthful', () => {
  it('an OLD IndexedDB success cannot clear the warning for a NEWER unsafe edit', async () => {
    const h = keeperHarness({ shadowFails: true })
    h.keeper.blur('ph-1', 'v1')
    expect(h.unsafe().has('ph-1')).toBe(true)
    h.keeper.change('ph-1', 'v2')
    h.persists[0].resolve(true) // old write succeeds late
    await flush()
    expect(h.unsafe().has('ph-1')).toBe(true)
    h.fireTimers()
    h.persists[1].resolve(true)
    await flush()
    expect(h.unsafe().has('ph-1')).toBe(false)
  })

  it('a failed IndexedDB write keeps the warning', async () => {
    const h = keeperHarness({ shadowFails: true })
    h.keeper.blur('ph-1', 'text')
    h.persists[0].resolve(false)
    await flush()
    expect(h.unsafe().has('ph-1')).toBe(true)
  })

  it('dispose FLUSHES pending debounced writes instead of dropping them', () => {
    const h = keeperHarness()
    h.keeper.change('ph-1', 'pending at unmount')
    h.keeper.dispose()
    expect(h.persists.map((p) => p.note)).toEqual(['pending at unmount'])
  })
})

describe('prepareRelease — the release caption is itself a proven edit', () => {
  it('writes a shadow with a fresh identity and a version above every earlier edit', () => {
    const h = keeperHarness()
    h.keeper.change('ph-1', 'draft')
    const before = readNoteShadow('pack-k', 'ph-1', h.storage)!
    const edits = h.keeper.prepareRelease({ 'ph-1': 'final at attach' })
    const after = readNoteShadow('pack-k', 'ph-1', h.storage)!
    expect(edits['ph-1'].v).toBeGreaterThan(before.v)
    expect(after).toMatchObject({ note: 'final at attach', v: edits['ph-1'].v, editId: edits['ph-1'].editId })
    h.fireTimers()
    expect(h.persists.length).toBe(0) // the superseded debounce was cancelled
  })
})

// ----------------------------------------------------------------
// rev 5
// ----------------------------------------------------------------

describe('ITEM 2 — "Note for all photos" is device-durable at once', () => {
  it('type batch note -> KILL before debounce/Attach -> reopen -> the exact note is recovered', () => {
    const storage = memStorage()
    const first = keeperHarness({ storage })
    first.keeper.registerPhoto('ph-1') // a photo with no own caption
    first.keeper.setBatchNote('Stain on couch — see angles 1–3')
    expect(first.persists.length).toBe(0) // debounce never fired: app killed
    // Reopen: a brand-new keeper over the same device storage.
    const second = keeperHarness({ storage })
    expect(second.keeper.getBatchNote()).toBe('Stain on couch — see angles 1–3')
    expect(readBatchNote('pack-k', storage)).toBe('Stain on couch — see angles 1–3')
    // And the blank photo's inherited caption is already shadowed.
    expect(readNoteShadow('pack-k', 'ph-1', storage)?.note).toBe('Stain on couch — see angles 1–3')
  })

  it('photos captured AFTER the batch note inherit it durably', () => {
    const h = keeperHarness()
    h.keeper.setBatchNote('Batch note')
    h.keeper.registerPhoto('ph-late')
    expect(readNoteShadow('pack-k', 'ph-late', h.storage)?.note).toBe('Batch note')
    expect(h.persists.map((p) => p.note)).toEqual(['Batch note']) // straight to IndexedDB
  })

  it('an explicit per-photo caption OVERRIDES the fallback and is never touched by it', () => {
    const h = keeperHarness()
    h.keeper.registerPhoto('ph-1')
    h.keeper.blur('ph-1', 'My own caption')
    h.keeper.setBatchNote('Batch note')
    expect(readNoteShadow('pack-k', 'ph-1', h.storage)?.note).toBe('My own caption')
    // Clearing the own caption falls back to the batch note.
    h.keeper.blur('ph-1', '   ')
    expect(readNoteShadow('pack-k', 'ph-1', h.storage)?.note).toBe('Batch note')
  })

  it('CLEARING the fallback is durable: key removed, inheriting photos get a blank edit', () => {
    const storage = memStorage()
    const h = keeperHarness({ storage })
    h.keeper.registerPhoto('ph-1')
    h.keeper.setBatchNote('Batch note')
    h.keeper.setBatchNote('')
    expect(readBatchNote('pack-k', storage)).toBeNull()
    expect(readNoteShadow('pack-k', 'ph-1', storage)?.note).toBeNull()
    expect(keeperHarness({ storage }).keeper.getBatchNote()).toBe('')
  })

  it('ending the session forgets the pack key WITHOUT changing any photo', () => {
    const storage = memStorage()
    const h = keeperHarness({ storage })
    h.keeper.registerPhoto('ph-1')
    h.keeper.setBatchNote('Batch note')
    h.keeper.forgetBatchNote()
    expect(readBatchNote('pack-k', storage)).toBeNull()
    expect(readNoteShadow('pack-k', 'ph-1', storage)?.note).toBe('Batch note') // untouched
  })

  it('a batch note the device refused to store is reported UNSAFE', () => {
    const h = keeperHarness({ shadowFails: true })
    h.keeper.setBatchNote('x')
    expect(h.unsafe().has(BATCH_NOTE_UNSAFE_ID)).toBe(true)
  })
})

describe('ITEM 4 — secureRelease: an explicit proven/unsafe outcome', () => {
  it('shadow-durable release captions are ok without waiting on IndexedDB', async () => {
    const h = keeperHarness()
    const res = await h.keeper.secureRelease({ 'ph-1': 'caption' })
    expect(res.ok).toBe(true)
    expect(h.persists.length).toBe(0)
  })

  it('shadow FAILED: ok only once IndexedDB proves the exact edit', async () => {
    const h = keeperHarness({ shadowFails: true })
    const pending = h.keeper.secureRelease({ 'ph-1': 'caption' })
    await flush()
    expect(h.persists.map((p) => p.note)).toEqual(['caption'])
    h.persists[0].resolve(true)
    const res = await pending
    expect(res.ok).toBe(true)
    expect(h.unsafe().has('ph-1')).toBe(false)
  })

  it('shadow FAILED and IndexedDB refuses: NOT ok, photo stays unsafe', async () => {
    const h = keeperHarness({ shadowFails: true })
    const pending = h.keeper.secureRelease({ 'ph-1': 'caption' })
    await flush()
    h.persists[0].resolve(false)
    const res = await pending
    expect(res).toMatchObject({ ok: false, unsafeIds: ['ph-1'] })
    expect(h.unsafe().has('ph-1')).toBe(true)
  })
})

describe('ITEM 11 — ONE canonical rule through capture and release', () => {
  it('ASCII edge whitespace is trimmed; NBSP and the letter v are preserved', () => {
    const h = keeperHarness()
    h.keeper.blur('a', ' \t padded \n')
    h.keeper.blur('b', '\u00A0nbsp\u00A0')
    h.keeper.blur('c', 'vase v')
    expect(readNoteShadow('pack-k', 'a', h.storage)?.note).toBe('padded')
    expect(readNoteShadow('pack-k', 'b', h.storage)?.note).toBe('\u00A0nbsp\u00A0')
    expect(readNoteShadow('pack-k', 'c', h.storage)?.note).toBe('vase v')
    const edits = h.keeper.prepareRelease({ c: '  vase v\v' })
    expect(readNoteShadow('pack-k', 'c', h.storage)).toMatchObject({ note: 'vase v', editId: edits.c.editId })
  })
})

describe('ITEM 10 — high-water-mark cleanup never races a newer shadow', () => {
  it('settled (no shadow, mark <= attached) => mark removed', () => {
    const s = memStorage()
    bumpHighWater('p', 'ph', 500, s)
    expect(clearHighWaterIfSettled('p', 'ph', 500, s)).toBe(true)
    expect(readHighWater('p', 'ph', s)).toBe(0)
  })

  it('a remaining (newer) shadow keeps the mark', () => {
    const s = memStorage()
    bumpHighWater('p', 'ph', 600, s)
    writeNoteShadow('p', SHADOW('ph', 'newer', 600), s)
    expect(clearHighWaterIfSettled('p', 'ph', 500, s)).toBe(false)
    expect(readHighWater('p', 'ph', s)).toBe(600)
  })

  it('a mark above the attached version (later allocation) is kept', () => {
    const s = memStorage()
    bumpHighWater('p', 'ph', 700, s)
    expect(clearHighWaterIfSettled('p', 'ph', 500, s)).toBe(false)
    expect(readHighWater('p', 'ph', s)).toBe(700)
  })

  it('explicit discard removes the mark', () => {
    const s = memStorage()
    bumpHighWater('p', 'ph', 700, s)
    removeHighWater('p', 'ph', s)
    expect(readHighWater('p', 'ph', s)).toBe(0)
  })
})
