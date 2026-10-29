import { describe, it, expect, vi } from 'vitest'
import { CaptionAutosave, type CaptionSaveResult } from './caption-autosave'
import { loadPersistedStore } from './caption-drafts'
import { memoryKV, writeJournal } from './caption-journal-test-kv'
import { runSaveAndSubmit, type SubmitActionResult } from './caption-submit'

/**
 * BEHAVIOURAL proof of save-and-submit ordering (blockers 4 + 5, rev 3),
 * driving the REAL CaptionAutosave controller — only the network edges are
 * faked. Real timers are used; saves resolve immediately.
 */

function makeController(save: (photoId: string, note: string) => Promise<CaptionSaveResult>) {
  // The REAL device journal over an in-memory Storage.
  const kv = memoryKV()
  const device = {
    get current() {
      return loadPersistedStore('pack-s', kv).entries
    },
  }
  const controller = new CaptionAutosave({
    packId: 'pack-s',
    save: (photoId, note) => save(photoId, note),
    onChange: () => {},
    isOnline: () => true,
    kv,
  })
  return { controller, device, kv }
}

describe('failed flush NEVER calls submit', () => {
  it('a caption that cannot be saved stops the submission before the server is asked', async () => {
    const { controller, device } = makeController(async () => ({
      ok: false,
      error: 'offline',
      retryable: false,
    }))
    controller.seed({ p1: null })
    controller.edit('p1', 'not saved to the server')
    const submit = vi.fn(async (): Promise<SubmitActionResult> => ({ ok: true, code: 'submitted' }))
    const outcome = await runSaveAndSubmit(controller, submit)
    expect(outcome.kind).toBe('flush_failed')
    expect(submit).not.toHaveBeenCalled()
    expect(device.current.p1.text).toBe('not saved to the server') // kept on device
    expect(controller.isFrozen()).toBe(false) // unfrozen afterwards
  })

  it('an unresolved conflict also stops submission', async () => {
    const { controller, kv } = makeController(async () => ({ ok: true }))
    writeJournal(kv, 'pack-s', { p1: { text: 'mine', editedAt: 1, savedText: 'old', savedEditedAt: 0 } })
    controller.seed({ p1: 'theirs' })
    const submit = vi.fn(async (): Promise<SubmitActionResult> => ({ ok: true, code: 'submitted' }))
    expect((await runSaveAndSubmit(controller, submit)).kind).toBe('flush_failed')
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('the manifest is complete and carries baselines', () => {
  it('sends every photo with note + expected server baseline', async () => {
    const { controller } = makeController(async () => ({ ok: true }))
    controller.seed({ p1: 'kept', p2: null })
    controller.edit('p2', 'new caption')
    const submit = vi.fn(async (): Promise<SubmitActionResult> => ({ ok: true, code: 'submitted' }))
    const outcome = await runSaveAndSubmit(controller, submit)
    expect(outcome).toEqual({ kind: 'submitted', leftover: [] })
    // After the flush, p2's baseline IS 'new caption' (autosave confirmed it).
    expect(submit).toHaveBeenCalledWith([
      { photoId: 'p1', note: 'kept', expected: 'kept' },
      { photoId: 'p2', note: 'new caption', expected: 'new caption' },
    ])
  })
})

describe('caption_conflict keeps every draft and marks the photos', () => {
  it('another device changed a caption between autosave and submit', async () => {
    const { controller, device } = makeController(async () => ({ ok: true }))
    controller.seed({ p1: null })
    controller.edit('p1', 'my caption')
    const outcome = await runSaveAndSubmit(controller, async () => ({
      ok: false,
      code: 'caption_conflict',
      packSubmitted: false,
      error: 'changed elsewhere',
      conflicts: [{ photoId: 'p1', serverNotes: 'other device caption' }],
    }))
    expect(outcome).toEqual({ kind: 'conflict', error: 'changed elsewhere', packSubmitted: false })
    expect(controller.statusFor('p1')).toBe('conflict')
    expect(controller.textFor('p1')).toBe('my caption')
    // Persisted: survives a refresh, so it can never be silently overwritten.
    expect(device.current.p1.conflictServer).toBe('other device caption')
  })

  it('submitted elsewhere: nothing acknowledged, drafts retained for backup', async () => {
    const { controller, kv } = makeController(async () => ({ ok: true }))
    writeJournal(kv, 'pack-s', { p1: { text: 'unsent', editedAt: 1, savedText: '', savedEditedAt: 0 } })
    controller.seed({ p1: null })
    // Flush would save it; make the SUBMIT report the pack as submitted elsewhere.
    const outcome = await runSaveAndSubmit(controller, async () => ({
      ok: false,
      code: 'caption_conflict',
      packSubmitted: true,
      error: 'submitted elsewhere',
      conflicts: [],
    }))
    expect(outcome.kind).toBe('conflict')
    expect(controller.snapshotAll()).toContainEqual({ photoId: 'p1', note: 'unsent' })
  })
})

describe('BLOCKER 5 — delayed submit + an attempted later edit is never silently lost', () => {
  it('editing is refused during the in-flight submit, and nothing newer is ever cleared', async () => {
    const { controller, device } = makeController(async () => ({ ok: true }))
    controller.seed({ p1: null })
    controller.edit('p1', 'submitted text')

    let release!: (r: SubmitActionResult) => void
    const slowSubmit = () =>
      new Promise<SubmitActionResult>((resolve) => {
        release = resolve
      })
    const running = runSaveAndSubmit(controller, slowSubmit)

    // Wait until the submit request is actually in flight.
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(controller.isFrozen()).toBe(true)
    // The inspector tries to keep typing while the request is slow:
    const accepted = controller.edit('p1', 'typed during the slow submit')
    expect(accepted).toBe(false) // refused — the UI shows it read-only
    expect(controller.textFor('p1')).toBe('submitted text') // no hidden divergence

    release({ ok: true, code: 'submitted' })
    const outcome = await running
    expect(outcome).toEqual({ kind: 'submitted', leftover: [] })
    expect(controller.isFrozen()).toBe(false)
    expect(device.current).toEqual({}) // only the exact submitted text was cleared
  })

  it('defence in depth: if newer text somehow exists at ack time, it is kept and reported', async () => {
    const { controller, device } = makeController(async () => ({ ok: true }))
    controller.seed({ p1: null })
    controller.edit('p1', 'submitted text')
    const outcome = await runSaveAndSubmit(controller, async () => {
      // Simulate a bypass of the freeze (e.g. a future bug) mid-request:
      controller.setFrozen(false)
      controller.edit('p1', 'NEWER text')
      controller.setFrozen(true)
      return { ok: true, code: 'submitted' }
    })
    expect(outcome).toEqual({ kind: 'submitted', leftover: ['p1'] })
    expect(device.current.p1.text).toBe('NEWER text') // never cleared
    controller.dispose() // stop the bypassed edit's debounce timer
  })
})

describe('BLOCKER 3 (rev 4) — photo removed under a live editor, then submit', () => {
  it('submits the remaining EXACT manifest without a hard reload', async () => {
    const { controller } = makeController(async () => ({ ok: true }))
    controller.seed({ p1: null, p2: null, p3: null })
    controller.edit('p1', 'kept one')
    controller.edit('p2', 'photo to be removed')
    // Server action removed p2; the refreshed server data reaches the editor.
    controller.reconcileManifest({ p1: null, p3: null })
    const submit = vi.fn(async (): Promise<SubmitActionResult> => ({ ok: true, code: 'submitted' }))
    const outcome = await runSaveAndSubmit(controller, submit)
    expect(outcome).toEqual({ kind: 'submitted', leftover: [] })
    expect(submit).toHaveBeenCalledWith([
      { photoId: 'p1', note: 'kept one', expected: 'kept one' },
      { photoId: 'p3', note: '', expected: '' },
    ])
    controller.dispose()
  })
})
