import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CAPTION_DEBOUNCE_MS,
  CAPTION_MAX_ATTEMPTS,
  CaptionAutosave,
  type CaptionSaveResult,
} from './caption-autosave'
import { loadPersistedStore, type CaptionDrafts, type CaptionOrphans } from './caption-drafts'
import { journalKeys, memoryKV, writeJournal, type MemoryKV } from './caption-journal-test-kv'

/**
 * Behavioural proof of the autosave controller with fake timers — the
 * debounce/coalescing, bounded retry, offline handling, latest-edit-wins and
 * flush-before-submit guarantees the P0 directive requires. No DOM involved:
 * the controller is the exact object the React provider drives.
 */

type SaveCall = { photoId: string; note: string; expected: string }

function makeHarness(opts?: {
  failTimes?: number
  failForever?: boolean
  staleAlways?: boolean
  online?: () => boolean
  manualResolve?: boolean
  persistFails?: boolean
  /** Share ONE device between harnesses (two tabs / a refresh). */
  kv?: MemoryKV
}) {
  const calls: SaveCall[] = []
  const pendingResolvers: Array<(r: CaptionSaveResult) => void> = []
  let remainingFailures = opts?.failTimes ?? 0
  // The REAL device journal over an in-memory Storage; `persisted` reads
  // back exactly what is on the device.
  const kv = opts?.kv ?? memoryKV()
  if (opts?.persistFails) kv.failWrites = true
  const persisted = {
    get current(): CaptionDrafts | null {
      const entries = loadPersistedStore('pack-1', kv).entries
      return Object.keys(entries).length > 0 ? entries : null
    },
    get orphans(): CaptionOrphans {
      return loadPersistedStore('pack-1', kv).orphans
    },
  }
  const controller = new CaptionAutosave({
    packId: 'pack-1',
    save: async (photoId, note, expected) => {
      calls.push({ photoId, note, expected })
      if (opts?.manualResolve) {
        return new Promise<CaptionSaveResult>((resolve) => pendingResolvers.push(resolve))
      }
      if (opts?.staleAlways) {
        return { ok: false, code: 'stale', error: 'changed elsewhere' }
      }
      if (opts?.failForever || remainingFailures > 0) {
        remainingFailures -= 1
        return { ok: false, error: 'boom', retryable: true }
      }
      return { ok: true }
    },
    onChange: () => {},
    isOnline: opts?.online ?? (() => true),
    kv,
  })
  return { controller, calls, persisted, pendingResolvers, kv }
}

/** Orphan text for a photo (orphans are keyed by edit identity). */
function orphanTexts(orphans: CaptionOrphans, photoId: string): string[] {
  return Object.values(orphans)
    .filter((o) => o.photoId === photoId)
    .map((o) => o.text)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('device durability precedes any network wait', () => {
  it('every keystroke is persisted to the device store BEFORE the debounce fires', () => {
    const { controller, calls, persisted } = makeHarness()
    controller.seed({ p1: null })
    controller.edit('p1', 'G')
    controller.edit('p1', 'Geyser')
    expect(persisted.current?.p1.text).toBe('Geyser') // durable immediately
    expect(calls.length).toBe(0) // no server call yet
  })
})

describe('debounce + coalescing', () => {
  it('many keystrokes across many photos coalesce to ONE save per photo', async () => {
    const { controller, calls } = makeHarness()
    controller.seed({ p1: null, p2: null, p3: null })
    for (const ch of ['a', 'ab', 'abc']) controller.edit('p1', ch)
    controller.edit('p2', 'two')
    controller.edit('p3', 'three')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    await flushMicrotasks()
    expect(calls.length).toBe(3)
    expect(calls.find((c) => c.photoId === 'p1')?.note).toBe('abc')
    expect(controller.statusFor('p1')).toBe('clean')
    expect(controller.pageStatus().blocking).toBe(false)
  })
})

describe('bounded retry, honest failure, no draft loss', () => {
  it(`retries then lands on 'error' after ${CAPTION_MAX_ATTEMPTS} attempts; the text survives`, async () => {
    const { controller, calls, persisted } = makeHarness({ failForever: true })
    controller.seed({ p1: null })
    controller.edit('p1', 'never lose me')
    // Debounce + every retry delay.
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    for (let i = 0; i < CAPTION_MAX_ATTEMPTS + 2; i += 1) {
      await vi.advanceTimersByTimeAsync(35_000)
      await flushMicrotasks()
    }
    expect(calls.length).toBe(CAPTION_MAX_ATTEMPTS) // bounded, not infinite
    expect(controller.statusFor('p1')).toBe('error') // truthful state
    expect(controller.textFor('p1')).toBe('never lose me') // draft intact
    expect(persisted.current?.p1.text).toBe('never lose me') // device intact
    expect(controller.pageStatus().blocking).toBe(true) // submission blocked
  })

  it('a transient failure recovers on retry and ends clean', async () => {
    const { controller } = makeHarness({ failTimes: 2 })
    controller.seed({ p1: null })
    controller.edit('p1', 'eventually saved')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    await vi.advanceTimersByTimeAsync(60_000)
    await flushMicrotasks()
    expect(controller.statusFor('p1')).toBe('clean')
  })

  it('a human edit resets an exhausted photo back to retryable', async () => {
    const { controller } = makeHarness({ failForever: true })
    controller.seed({ p1: null })
    controller.edit('p1', 'v1')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    for (let i = 0; i < CAPTION_MAX_ATTEMPTS + 2; i += 1) {
      await vi.advanceTimersByTimeAsync(35_000)
      await flushMicrotasks()
    }
    expect(controller.statusFor('p1')).toBe('error')
    controller.edit('p1', 'v2')
    expect(controller.statusFor('p1')).toBe('dirty') // fresh budget
  })
})

describe('offline behaviour', () => {
  it("offline => status 'offline' (saved on device), no network calls; online resumes", async () => {
    let online = false
    const { controller, calls, persisted } = makeHarness({ online: () => online })
    controller.seed({ p1: null })
    controller.edit('p1', 'typed in a dead zone')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    await flushMicrotasks()
    expect(calls.length).toBe(0)
    expect(controller.statusFor('p1')).toBe('offline')
    expect(persisted.current?.p1.text).toBe('typed in a dead zone')
    expect(controller.pageStatus().blocking).toBe(true) // offline-unsynced blocks
    online = true
    controller.notifyOnline()
    await vi.advanceTimersByTimeAsync(10)
    await flushMicrotasks()
    expect(calls.length).toBe(1)
    expect(controller.statusFor('p1')).toBe('clean')
  })
})

describe('latest edit wins + SINGLE FLIGHT ordering (blocker 5)', () => {
  it('only ONE request per photo is ever in flight; the next starts strictly after it settles', async () => {
    const { controller, calls, pendingResolvers } = makeHarness({ manualResolve: true })
    controller.seed({ p1: null })
    controller.edit('p1', 'old text')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    expect(calls.length).toBe(1) // save of 'old text' in flight
    controller.edit('p1', 'newer text') // user keeps typing
    // Its own debounce elapses while request 1 is STILL pending:
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    expect(calls.length).toBe(1) // SINGLE-FLIGHT: no concurrent second request
    pendingResolvers.shift()?.({ ok: true }) // request 1 settles (late ack)
    await flushMicrotasks()
    expect(controller.textFor('p1')).toBe('newer text') // not clobbered
    expect(controller.statusFor('p1')).not.toBe('clean') // still needs saving
    // SETTLE-RECHAIN: request 2 starts only now, with the newer text.
    await vi.advanceTimersByTimeAsync(10)
    expect(calls.length).toBe(2)
    expect(calls.at(-1)?.note).toBe('newer text')
    // rev 6.1: the CAS baseline ADVANCED to what request 1 confirmed.
    expect(calls.at(-1)?.expected).toBe('old text')
    pendingResolvers.shift()?.({ ok: true })
    await flushMicrotasks()
    expect(controller.statusFor('p1')).toBe('clean')
  })

  it('every request carries the expected server value for the database CAS', async () => {
    const { controller, calls } = makeHarness()
    controller.seed({ p1: 'server original' })
    controller.edit('p1', 'replacement')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    await flushMicrotasks()
    expect(calls[0].expected).toBe('server original') // mandatory CAS baseline
  })

  it("a 'stale' CAS refusal (another tab wrote newer text) preserves the draft and blocks submit", async () => {
    const { controller, calls, persisted } = makeHarness({ staleAlways: true })
    controller.seed({ p1: 'server original' })
    controller.edit('p1', 'my conflicting text')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.length).toBe(1) // stale is terminal — no silent retry/overwrite
    expect(controller.statusFor('p1')).toBe('conflict') // persisted, explicit conflict state
    expect(controller.textFor('p1')).toBe('my conflicting text') // draft kept
    expect(persisted.current?.p1.text).toBe('my conflicting text') // device kept
    expect(controller.pageStatus().blocking).toBe(true) // submit blocked
  })
})

describe('device storage failure (blocker 6)', () => {
  it('never claims device durability when the write failed; draft and gate stay honest', () => {
    const { controller, persisted } = makeHarness({ persistFails: true })
    controller.seed({ p1: null })
    controller.edit('p1', 'typed into a full device')
    expect(controller.pageStatus().deviceDurable).toBe(false) // UI must not say "on device"
    expect(controller.pageStatus().blocking).toBe(true) // submission blocked while dirty
    expect(controller.textFor('p1')).toBe('typed into a full device') // text intact in memory
    expect(persisted.current).toBeNull() // nothing pretended to persist
  })
})

describe('flushAll — the submit race guard', () => {
  it('submitting right after typing cannot race the debounce: flushAll saves NOW', async () => {
    const { controller, calls } = makeHarness()
    controller.seed({ p1: null, p2: null })
    controller.edit('p1', 'typed')
    controller.edit('p2', 'and submitted immediately')
    const result = controller.flushAll() // no timer advance: debounce bypassed
    await flushMicrotasks()
    await vi.runAllTimersAsync()
    expect(await result).toBe(true)
    expect(calls.length).toBe(2)
    expect(controller.pageStatus().blocking).toBe(false)
  })

  it('flushAll reports false when a save failed — the caller must not fake success', async () => {
    const { controller } = makeHarness({ failForever: true })
    controller.seed({ p1: null })
    controller.edit('p1', 'will not reach the server')
    const result = controller.flushAll()
    await flushMicrotasks()
    await vi.runAllTimersAsync()
    expect(await result).toBe(false)
    expect(controller.textFor('p1')).toBe('will not reach the server') // kept
  })
})

describe('snapshotAll — what save-and-submit sends', () => {
  it('returns the FULL current caption set (blank-by-choice included)', () => {
    const { controller } = makeHarness()
    controller.seed({ p1: 'server kept', p2: 'to be blanked' })
    controller.edit('p2', '')
    const snapshot = controller.snapshotAll()
    expect(snapshot).toContainEqual({ photoId: 'p1', note: 'server kept' })
    expect(snapshot).toContainEqual({ photoId: 'p2', note: '' })
  })

  it('snapshotForSubmit carries every caption WITH its server baseline (blocker 4)', () => {
    const { controller } = makeHarness()
    controller.seed({ p1: 'server one', p2: null })
    controller.edit('p1', 'my new text')
    expect(controller.snapshotForSubmit()).toEqual([
      { photoId: 'p1', note: 'my new text', expected: 'server one' },
      { photoId: 'p2', note: '', expected: '' },
    ])
  })
})

describe('BLOCKER 6 — a stale conflict survives refresh and never auto-overwrites', () => {
  it('stale in-session -> refresh -> still a conflict; NO autosave is attempted', async () => {
    const first = makeHarness({ staleAlways: true })
    first.controller.seed({ p1: 'baseline' })
    first.controller.edit('p1', 'my local caption')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    await flushMicrotasks()
    expect(first.controller.statusFor('p1')).toBe('conflict')
    expect(first.persisted.current?.p1.conflictServer).toBeNull() // server text unknown in-session
    first.controller.dispose()

    // REFRESH: new controller on the SAME device, server now shows the other
    // device's text.
    const second = makeHarness({ kv: first.kv })
    second.controller.seed({ p1: 'other device caption' })
    await vi.advanceTimersByTimeAsync(60_000)
    await flushMicrotasks()
    expect(second.calls.length).toBe(0) // fail closed: never auto-overwrites
    expect(second.controller.statusFor('p1')).toBe('conflict')
    expect(second.controller.textFor('p1')).toBe('my local caption')
    expect(second.controller.conflictServerFor('p1')).toBe('other device caption')
    expect(second.controller.pageStatus().blocking).toBe(true)
  })

  it('a restored draft whose baseline no longer matches the server is a conflict (no rebase)', async () => {
    const { controller, calls, kv } = makeHarness()
    writeJournal(kv, 'pack-1', {
      p1: { text: 'typed offline', editedAt: 5, savedText: 'old server', savedEditedAt: 0 },
    })
    controller.seed({ p1: 'changed by someone else' })
    await vi.advanceTimersByTimeAsync(60_000)
    await flushMicrotasks()
    expect(calls.length).toBe(0)
    expect(controller.statusFor('p1')).toBe('conflict')
  })

  it('explicit "keep mine" autosaves with the SERVER text as the CAS baseline', async () => {
    const { controller, calls, kv } = makeHarness()
    writeJournal(kv, 'pack-1', {
      p1: { text: 'mine', editedAt: 5, savedText: 'old', savedEditedAt: 0, conflictServer: null },
    })
    controller.seed({ p1: 'theirs' })
    controller.keepMine('p1')
    await vi.advanceTimersByTimeAsync(10)
    await flushMicrotasks()
    expect(calls).toEqual([{ photoId: 'p1', note: 'mine', expected: 'theirs' }])
    expect(controller.statusFor('p1')).toBe('clean')
  })

  it('explicit "use server" takes their text, clean, nothing sent', async () => {
    const { controller, calls, kv } = makeHarness()
    writeJournal(kv, 'pack-1', {
      p1: { text: 'mine', editedAt: 5, savedText: 'old', savedEditedAt: 0, conflictServer: null },
    })
    controller.seed({ p1: 'theirs' })
    controller.takeServerVersion('p1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.length).toBe(0)
    expect(controller.textFor('p1')).toBe('theirs')
    expect(controller.statusFor('p1')).toBe('clean')
  })

  it('flushAll reports false while any conflict is unresolved', async () => {
    const { controller, kv } = makeHarness()
    writeJournal(kv, 'pack-1', { p1: { text: 'mine', editedAt: 5, savedText: 'old', savedEditedAt: 0 } })
    controller.seed({ p1: 'theirs' })
    expect(await controller.flushAll()).toBe(false)
  })
})

describe('BLOCKER 7 — React Strict Mode lifecycle', () => {
  it('seed -> dispose -> seed leaves a LIVE controller: edits still autosave', async () => {
    const { controller, calls } = makeHarness()
    controller.seed({ p1: null })
    controller.dispose() // Strict Mode effect cleanup
    controller.seed({ p1: null }) // Strict Mode effect re-run
    controller.edit('p1', 'typed after strict-mode remount')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    await flushMicrotasks()
    expect(calls.map((c) => c.note)).toEqual(['typed after strict-mode remount'])
    expect(controller.statusFor('p1')).toBe('clean')
  })
})

describe('BLOCKER 5 — freeze + acknowledge never clear newer text', () => {
  it('while frozen, edits are refused and change nothing', () => {
    const { controller } = makeHarness()
    controller.seed({ p1: 'submitted text' })
    controller.setFrozen(true)
    expect(controller.edit('p1', 'typed during submit')).toBe(false)
    expect(controller.textFor('p1')).toBe('submitted text')
    controller.setFrozen(false)
    expect(controller.edit('p1', 'after')).toBe(true)
  })

  it('acknowledging an OLDER snapshot keeps newer local text dirty and on the device', () => {
    const { controller, persisted } = makeHarness()
    controller.seed({ p1: null, p2: null })
    controller.edit('p1', 'submitted')
    controller.edit('p2', 'submitted too')
    const snapshot = controller.snapshotForSubmit()
    controller.edit('p2', 'NEWER text typed after the snapshot')
    const leftover = controller.acknowledgeSubmitted(snapshot)
    expect(leftover).toEqual(['p2'])
    expect(controller.statusFor('p1')).toBe('clean')
    // What the REAL device journal holds:
    const onDevice = persisted.current ?? {}
    expect(onDevice.p2.text).toBe('NEWER text typed after the snapshot')
    expect(onDevice.p1).toBeUndefined() // only the acknowledged entry left the device
  })
})

describe('BLOCKER 3 (rev 4) — a changed photo manifest is reconciled without a reload', () => {
  it('removing a draft photo drops it; the remaining EXACT manifest submits', async () => {
    const { controller } = makeHarness()
    controller.seed({ p1: null, p2: null })
    controller.edit('p1', 'kept caption')
    controller.edit('p2', 'caption of a photo about to be removed')
    // The photo is removed elsewhere; a server refresh keeps the editor
    // mounted and delivers the new server manifest.
    expect(controller.reconcileManifest({ p1: null })).toBe(true)
    const flushed = controller.flushAll()
    await flushMicrotasks()
    await vi.runAllTimersAsync()
    expect(await flushed).toBe(true)
    expect(controller.snapshotForSubmit()).toEqual([
      { photoId: 'p1', note: 'kept caption', expected: 'kept caption' },
    ])
  })

  it('dirty and conflicted captions of SURVIVING photos are preserved; new photos are seeded', () => {
    const { controller, kv } = makeHarness()
    writeJournal(kv, 'pack-1', { p2: { text: 'mine', editedAt: 1, savedText: 'old', savedEditedAt: 0 } })
    controller.seed({ p1: null, p2: 'theirs', p3: null })
    controller.edit('p1', 'unsaved local text')
    controller.reconcileManifest({ p1: null, p2: 'theirs', p4: 'server caption of new photo' })
    expect(controller.textFor('p1')).toBe('unsaved local text')
    expect(controller.statusFor('p1')).not.toBe('clean')
    expect(controller.statusFor('p2')).toBe('conflict')
    expect(controller.textFor('p4')).toBe('server caption of new photo')
    expect(controller.snapshotForSubmit().map((m) => m.photoId).sort()).toEqual(['p1', 'p2', 'p4'])
  })

  it('an in-flight save for a REMOVED photo resolves harmlessly', async () => {
    const { controller, pendingResolvers } = makeHarness({ manualResolve: true })
    controller.seed({ p1: null, p2: null })
    controller.edit('p2', 'saving when removed')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    controller.reconcileManifest({ p1: null })
    pendingResolvers.shift()?.({ ok: true })
    await flushMicrotasks()
    expect(controller.snapshotForSubmit().map((m) => m.photoId)).toEqual(['p1'])
    expect(controller.pageStatus().blocking).toBe(false)
  })

  it('an identical manifest is a no-op (ordinary re-renders never reset state)', () => {
    const { controller } = makeHarness()
    controller.seed({ p1: null })
    controller.edit('p1', 'typing')
    expect(controller.reconcileManifest({ p1: null })).toBe(false)
    expect(controller.textFor('p1')).toBe('typing')
  })
})

describe('ITEMS 6 + 7 (rev 5) — live manifest reconciliation', () => {
  it('SAME ids + changed server caption: a clean caption adopts it; a dirty one is preserved', () => {
    const { controller } = makeHarness()
    controller.seed({ p1: 'old one', p2: 'old two' })
    controller.edit('p2', 'my unsaved edit')
    expect(controller.reconcileManifest({ p1: 'new one', p2: 'new two' })).toBe(true)
    expect(controller.textFor('p1')).toBe('new one')
    expect(controller.statusFor('p1')).toBe('clean')
    expect(controller.textFor('p2')).toBe('my unsaved edit')
    expect(controller.statusFor('p2')).not.toBe('clean')
  })

  it('an identical manifest (ordinary re-render) changes nothing', () => {
    const { controller } = makeHarness()
    controller.seed({ p1: 'one' })
    expect(controller.reconcileManifest({ p1: 'one' })).toBe(false)
  })

  it('REMOTE REMOVAL while a local dirty caption exists: excluded from submit, kept as an orphan', () => {
    const { controller, persisted } = makeHarness()
    controller.seed({ p1: null, p2: null })
    controller.edit('p2', 'typed for a photo removed elsewhere')
    controller.reconcileManifest({ p1: null })
    expect(controller.snapshotForSubmit().map((m) => m.photoId)).toEqual(['p1'])
    expect(orphanTexts(controller.getOrphans(), 'p2')).toEqual(['typed for a photo removed elsewhere'])
    expect(controller.pageStatus().blocking).toBe(false) // orphans never block submit
    // Persisted WITH the orphan, so a refresh cannot lose it.
    expect(orphanTexts(persisted.orphans, 'p2')).toEqual(['typed for a photo removed elsewhere'])
    controller.discardOrphans() // explicit inspector action only
    expect(controller.getOrphans()).toEqual({})
    expect(persisted.orphans).toEqual({})
  })

  it('persisted drafts whose photo is already gone at load time become orphans', () => {
    const { controller, kv } = makeHarness()
    writeJournal(kv, 'pack-1', {
      gone: { text: 'typed before refresh', editedAt: 1, savedText: '', savedEditedAt: 0 },
    })
    controller.seed({ p1: null })
    expect(orphanTexts(controller.getOrphans(), 'gone')).toEqual(['typed before refresh'])
  })
})

// ----------------------------------------------------------------
// rev 6 — BLOCKER 1: a stale controller can never delete or overwrite a
// newer device draft; two editors on one device never lose each other's text.
// ----------------------------------------------------------------

const STALE_RESULTS: Array<[string, CaptionSaveResult]> = [
  ['success', { ok: true }],
  ['stale CAS refusal', { ok: false, code: 'stale', error: 'changed elsewhere', serverNotes: 'x' }],
  ['retryable failure', { ok: false, error: 'boom', retryable: true }],
]

describe('REV 6 (a) — a DISPOSED controller resolving late cannot touch a newer editor', () => {
  it.each(STALE_RESULTS)(
    'A disposed with a pending save -> B types newer text -> A resolves (%s) -> B’s exact text stays',
    async (_label, lateResult) => {
      const kv = memoryKV()
      const A = makeHarness({ kv, manualResolve: true })
      A.controller.seed({ p1: null })
      A.controller.edit('p1', 'A old text')
      await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
      expect(A.calls.length).toBe(1) // A's save is on the wire
      A.controller.dispose() // navigation / unmount

      const B = makeHarness({ kv, online: () => false })
      B.controller.seed({ p1: null })
      expect(B.controller.textFor('p1')).toBe('A old text') // adopted, not lost
      B.controller.edit('p1', 'B newer text')

      A.pendingResolvers.shift()?.(lateResult) // the stale completion lands
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(60_000) // no retry may fire for A
      await flushMicrotasks()

      expect(A.calls.length).toBe(1)
      expect(loadPersistedStore('pack-1', kv).entries.p1.text).toBe('B newer text')
      expect(Object.keys(loadPersistedStore('pack-1', kv).orphans)).toEqual([])
      expect(B.controller.textFor('p1')).toBe('B newer text')
      expect(B.controller.statusFor('p1')).toBe('offline') // still honestly unsynced
    },
  )
})

describe('REV 6 (b) — same controller: an old generation can never clear/conflict the new one', () => {
  it.each(STALE_RESULTS.slice(0, 2))(
    'seed -> pending save -> dispose -> seed -> edit -> old %s is inert, then the NEW text is sent',
    async (_label, lateResult) => {
      const { controller, calls, pendingResolvers, persisted } = makeHarness({ manualResolve: true })
      controller.seed({ p1: null })
      const gen1 = controller.currentGeneration()
      controller.edit('p1', 'generation one')
      await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
      expect(calls.length).toBe(1)

      controller.dispose() // Strict Mode cleanup
      controller.seed({ p1: null }) // Strict Mode re-run; server still blank
      expect(controller.currentGeneration()).toBeGreaterThan(gen1)
      controller.edit('p1', 'generation two')
      await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
      // Single-flight holds ACROSS generations: no concurrent request.
      expect(calls.length).toBe(1)
      expect(controller.statusFor('p1')).toBe('saving')

      pendingResolvers.shift()?.(lateResult) // generation one's result
      await flushMicrotasks()
      expect(controller.textFor('p1')).toBe('generation two')
      expect(controller.statusFor('p1')).not.toBe('clean') // NOT cleared
      expect(controller.statusFor('p1')).not.toBe('conflict') // NOT conflicted
      expect(persisted.current?.p1.text).toBe('generation two') // device untouched

      // RESUME: the current generation's dirty caption is sent now.
      await vi.advanceTimersByTimeAsync(10)
      expect(calls.length).toBe(2)
      expect(calls[1]).toEqual({ photoId: 'p1', note: 'generation two', expected: '' })
      pendingResolvers.shift()?.({ ok: true })
      await flushMicrotasks()
      expect(controller.statusFor('p1')).toBe('clean')
      expect(persisted.current).toBeNull() // only now, for the exact edit saved
    },
  )

  it('a disposed controller schedules nothing when its last save settles', async () => {
    const { controller, calls, pendingResolvers } = makeHarness({ manualResolve: true })
    controller.seed({ p1: null })
    controller.edit('p1', 'typed')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    controller.dispose()
    pendingResolvers.shift()?.({ ok: false, error: 'boom', retryable: true })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.length).toBe(1)
  })
})

describe('REV 6 (c) — two editors, DIFFERENT photos: both drafts survive', () => {
  it('neither editor’s persist removes the other’s record; a refresh restores both', () => {
    const kv = memoryKV()
    const A = makeHarness({ kv, online: () => false })
    const B = makeHarness({ kv, online: () => false })
    A.controller.seed({ p1: null, p2: null })
    B.controller.seed({ p1: null, p2: null })
    A.controller.edit('p1', 'A on photo 1')
    B.controller.edit('p2', 'B on photo 2')
    A.controller.edit('p1', 'A on photo 1, again') // A persists again
    const onDevice = loadPersistedStore('pack-1', kv).entries
    expect(onDevice.p1.text).toBe('A on photo 1, again')
    expect(onDevice.p2.text).toBe('B on photo 2')

    const refreshed = makeHarness({ kv, online: () => false })
    refreshed.controller.seed({ p1: null, p2: null })
    expect(refreshed.controller.textFor('p1')).toBe('A on photo 1, again')
    expect(refreshed.controller.textFor('p2')).toBe('B on photo 2')
  })
})

describe('REV 6 (d) — two editors, SAME photo: no draft is silently discarded', () => {
  it('both records stay; a refresh shows the newest as the draft and keeps the other for recovery', () => {
    const kv = memoryKV()
    const A = makeHarness({ kv, online: () => false })
    const B = makeHarness({ kv, online: () => false })
    A.controller.seed({ p1: null })
    B.controller.seed({ p1: null })
    A.controller.edit('p1', 'from tab A')
    vi.advanceTimersByTime(5)
    B.controller.edit('p1', 'from tab B')
    expect(journalKeys(kv, 'pack-1')).toHaveLength(2) // one record per edit identity

    const refreshed = makeHarness({ kv, online: () => false })
    refreshed.controller.seed({ p1: null })
    expect(refreshed.controller.textFor('p1')).toBe('from tab B') // newest = live draft
    const kept = Object.values(refreshed.controller.getOrphans())
    expect(kept).toEqual([
      expect.objectContaining({ photoId: 'p1', text: 'from tab A', reason: 'competing' }),
    ])
    expect(refreshed.controller.pageStatus().blocking).toBe(true) // the draft is unsynced
    // Still both texts on the device after the adoption.
    const store = loadPersistedStore('pack-1', kv)
    expect(store.entries.p1.text).toBe('from tab B')
    expect(orphanTexts(store.orphans, 'p1')).toEqual(['from tab A'])
  })

  it('identical text from two editors collapses to one copy (nothing to recover)', () => {
    const kv = memoryKV()
    const A = makeHarness({ kv, online: () => false })
    const B = makeHarness({ kv, online: () => false })
    A.controller.seed({ p1: null })
    B.controller.seed({ p1: null })
    A.controller.edit('p1', 'same words')
    B.controller.edit('p1', 'same words')
    const refreshed = makeHarness({ kv, online: () => false })
    refreshed.controller.seed({ p1: null })
    expect(refreshed.controller.textFor('p1')).toBe('same words')
    expect(refreshed.controller.getOrphans()).toEqual({})
  })
})

describe('REV 6 (e) — an acknowledgement clears ONLY the exact edit it saved', () => {
  it("A's successful save removes A's record only; B's different edit stays on the device", async () => {
    const kv = memoryKV()
    let aOnline = false
    const A = makeHarness({ kv, online: () => aOnline })
    const B = makeHarness({ kv, online: () => false })
    A.controller.seed({ p1: null })
    B.controller.seed({ p1: null })
    A.controller.edit('p1', 'A text')
    B.controller.edit('p1', 'B text')
    aOnline = true
    A.controller.notifyOnline()
    await vi.advanceTimersByTimeAsync(10)
    await flushMicrotasks()
    expect(A.calls.map((c) => c.note)).toEqual(['A text'])
    expect(A.controller.statusFor('p1')).toBe('clean')
    expect(journalKeys(kv, 'pack-1')).toHaveLength(1)
    expect(loadPersistedStore('pack-1', kv).entries.p1.text).toBe('B text')
  })

  it("A's submit acknowledgement cannot clear B's record either", () => {
    const kv = memoryKV()
    const A = makeHarness({ kv, online: () => false })
    const B = makeHarness({ kv, online: () => false })
    A.controller.seed({ p1: null })
    B.controller.seed({ p1: null })
    A.controller.edit('p1', 'shared wording')
    B.controller.edit('p1', 'B kept typing')
    A.controller.acknowledgeSubmitted([{ photoId: 'p1', note: 'shared wording' }])
    expect(loadPersistedStore('pack-1', kv).entries.p1.text).toBe('B kept typing')
  })
})

describe('REV 6 — adoption is fail-closed', () => {
  it('if the adopting copy cannot be written, every source record stays on the device', () => {
    const kv = memoryKV()
    writeJournal(kv, 'pack-1', { p1: { text: 'only copy', editedAt: 3, savedText: '', savedEditedAt: 0 } })
    const before = journalKeys(kv, 'pack-1')
    kv.failWrites = true
    const { controller } = makeHarness({ kv })
    controller.seed({ p1: null })
    expect(controller.textFor('p1')).toBe('only copy')
    expect(controller.pageStatus().deviceDurable).toBe(false)
    expect(journalKeys(kv, 'pack-1')).toEqual(before) // nothing removed
  })

  it('a refresh adopts the old record and leaves exactly ONE copy (no growth per reload)', () => {
    const kv = memoryKV()
    for (let i = 0; i < 3; i += 1) {
      const h = makeHarness({ kv, online: () => false })
      h.controller.seed({ p1: null })
      if (i === 0) h.controller.edit('p1', 'typed once')
      h.controller.dispose()
    }
    expect(journalKeys(kv, 'pack-1')).toHaveLength(1)
    expect(loadPersistedStore('pack-1', kv).entries.p1.text).toBe('typed once')
  })
})

// ----------------------------------------------------------------
// rev 6.1 — the two regressions chat's final review found.
// ----------------------------------------------------------------

/** A stateful fake server that ENFORCES compare-and-set exactly like
 *  set_prearrival_photo_caption: same text -> 'unchanged' (ok); expected !=
 *  current -> 'stale' with zero writes; else write. Requests can be held. */
function casServer(initial: Record<string, string>) {
  const server = { ...initial }
  const held: Array<() => void> = []
  let holdNext = 0
  const save = (photoId: string, note: string, expected: string): Promise<CaptionSaveResult> => {
    const decide = (): CaptionSaveResult => {
      const cur = server[photoId] ?? ''
      if (note.trim() === cur.trim()) return { ok: true }
      if (expected.trim() !== cur.trim()) {
        return { ok: false, code: 'stale', error: 'changed elsewhere', serverNotes: cur }
      }
      server[photoId] = note
      return { ok: true }
    }
    if (holdNext > 0) {
      holdNext -= 1
      return new Promise((resolve) => held.push(() => resolve(decide())))
    }
    return Promise.resolve(decide())
  }
  return {
    server,
    save,
    holdNextRequest: () => {
      holdNext += 1
    },
    releaseHeld: () => held.shift()?.(),
  }
}

describe('REV 6.1 BLOCKER 1 — typing while a save is in flight never creates a false conflict', () => {
  it('request 2 expects request 1’s text; final server text is the newest; no conflict', async () => {
    const fake = casServer({ p1: '' })
    const calls: Array<{ note: string; expected: string }> = []
    const kv = memoryKV()
    const controller = new CaptionAutosave({
      packId: 'pack-1',
      save: (photoId, note, expected) => {
        calls.push({ note, expected })
        return fake.save(photoId, note, expected)
      },
      onChange: () => {},
      isOnline: () => true,
      kv,
    })
    controller.seed({ p1: null })
    fake.holdNextRequest() // request 1 is delayed
    controller.edit('p1', 'old text')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    expect(calls).toEqual([{ note: 'old text', expected: '' }])

    controller.edit('p1', 'newer text') // typed while request 1 is pending
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    expect(calls.length).toBe(1) // single flight

    fake.releaseHeld() // request 1 succeeds: server holds 'old text'
    await flushMicrotasks()
    expect(fake.server.p1).toBe('old text')
    // The newest device draft is still there (its OWN ack has not happened).
    expect(loadPersistedStore('pack-1', kv).entries.p1.text).toBe('newer text')
    expect(controller.statusFor('p1')).not.toBe('clean')

    await vi.advanceTimersByTimeAsync(10) // settle-rechain
    await flushMicrotasks()
    expect(calls[1]).toEqual({ note: 'newer text', expected: 'old text' })
    expect(fake.server.p1).toBe('newer text')
    expect(controller.statusFor('p1')).toBe('clean')
    expect(controller.pageStatus().conflicts).toBe(0)
    expect(journalKeys(kv, 'pack-1')).toEqual([]) // removed only after its exact ack
  })

  it('a superseded generation’s ack still changes NOTHING (generation guard intact)', async () => {
    const { controller, calls, pendingResolvers, persisted } = makeHarness({ manualResolve: true })
    controller.seed({ p1: null })
    controller.edit('p1', 'gen one')
    await vi.advanceTimersByTimeAsync(CAPTION_DEBOUNCE_MS + 10)
    controller.dispose()
    controller.seed({ p1: null })
    controller.edit('p1', 'gen two')
    pendingResolvers.shift()?.({ ok: true })
    await flushMicrotasks()
    // Baseline NOT advanced by the old generation: the resumed request still
    // expects what THIS generation believes ('').
    await vi.advanceTimersByTimeAsync(10)
    expect(calls[1]).toEqual({ photoId: 'p1', note: 'gen two', expected: '' })
    expect(persisted.current?.p1.savedText).toBe('')
  })
})

describe('REV 6.1 BLOCKER 2 — a failed replacement write never deletes the last safe copy', () => {
  it('A stored -> writes fail -> type B -> A still on device; storage recovers -> B written BEFORE A removed', () => {
    const { controller, kv } = makeHarness({ online: () => false })
    controller.seed({ p1: null })
    // (a) caption A stored successfully.
    controller.edit('p1', 'caption A')
    const keyA = journalKeys(kv, 'pack-1')
    expect(keyA).toHaveLength(1)
    expect(controller.pageStatus().deviceDurable).toBe(true)

    // (b) setItem fails, removeItem still works. (c) type caption B.
    kv.failWrites = true
    controller.edit('p1', 'caption B')
    // (d) honest state; B in memory; A PHYSICALLY still in the journal.
    expect(controller.pageStatus().deviceDurable).toBe(false)
    expect(controller.textFor('p1')).toBe('caption B')
    expect(journalKeys(kv, 'pack-1')).toEqual(keyA)
    expect(loadPersistedStore('pack-1', kv).entries.p1.text).toBe('caption A')
    // A further failed keystroke still removes nothing.
    controller.edit('p1', 'caption B!')
    expect(journalKeys(kv, 'pack-1')).toEqual(keyA)

    // (e) storage recovers; the next persistence happens.
    kv.failWrites = false
    kv.ops.length = 0
    controller.edit('p1', 'caption B!!')
    // (f) newest durable FIRST, only then the obsolete A retired.
    expect(controller.pageStatus().deviceDurable).toBe(true)
    const setIdx = kv.ops.findIndex((o) => o.op === 'set')
    const removeA = kv.ops.findIndex((o) => o.op === 'remove' && o.key === keyA[0])
    expect(setIdx).toBeGreaterThan(-1)
    expect(removeA).toBeGreaterThan(setIdx)
    expect(journalKeys(kv, 'pack-1')).not.toContain(keyA[0])
    expect(loadPersistedStore('pack-1', kv).entries.p1.text).toBe('caption B!!')
    expect(journalKeys(kv, 'pack-1')).toHaveLength(1)
  })
})
