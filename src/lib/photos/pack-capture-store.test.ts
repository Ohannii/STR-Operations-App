import { describe, it, expect } from 'vitest'
import { packCapture } from '@/lib/photos/pack-capture-store'

/**
 * Exercises the REAL store module (not just pack-status inputs).
 *
 * The store is a module singleton keyed by pack id, so each test uses a fresh
 * pack id. A brand-new pack id is exactly what a page reload produces: no
 * persisted state anywhere, which is the property that prevents the old
 * localStorage high-water deadlock.
 */
let n = 0
const freshPack = () => `pack-${++n}`

describe('pack-capture-store: baseline + derived totals', () => {
  it('a brand-new pack starts completely empty (nothing is persisted)', () => {
    const s = packCapture.snapshot(freshPack())
    expect(s).toEqual({
      intendedTotal: 0,
      blocking: false,
      pending: 0,
      failed: 0,
      saved: 0,
    })
  })

  it('seeds intent from the server-linked baseline while nothing is committed', () => {
    const p = freshPack()
    packCapture.syncBaseline(p, 10)
    expect(packCapture.snapshot(p).intendedTotal).toBe(10)
    expect(packCapture.snapshot(p).blocking).toBe(false)
  })

  it('10 linked + 5 committed = intended 15, and blocks until all are saved', () => {
    const p = freshPack()
    packCapture.syncBaseline(p, 10)
    for (let i = 0; i < 5; i++) packCapture.commit(p, `photo-${i}`)
    expect(packCapture.snapshot(p).intendedTotal).toBe(15)
    expect(packCapture.snapshot(p).blocking).toBe(true)

    // 3 save, 2 fail -> still blocking, and intent stays 15.
    packCapture.mark(p, 'photo-0', 'saved')
    packCapture.mark(p, 'photo-1', 'saved')
    packCapture.mark(p, 'photo-2', 'saved')
    packCapture.mark(p, 'photo-3', 'failed')
    packCapture.mark(p, 'photo-4', 'failed')
    const s = packCapture.snapshot(p)
    expect(s).toMatchObject({ intendedTotal: 15, blocking: true, failed: 2, saved: 3 })
  })

  it('freezes the baseline once work is committed (no double counting)', () => {
    const p = freshPack()
    packCapture.syncBaseline(p, 10)
    packCapture.commit(p, 'a')
    // The server count grows as the photo lands; intent must NOT become 12.
    packCapture.syncBaseline(p, 11)
    expect(packCapture.snapshot(p).intendedTotal).toBe(11)
  })

  it('tracks the full per-photo lifecycle', () => {
    const p = freshPack()
    packCapture.syncBaseline(p, 0)
    packCapture.commit(p, 'x')
    expect(packCapture.snapshot(p)).toMatchObject({ pending: 1, blocking: true })
    for (const st of ['uploading', 'attaching'] as const) {
      packCapture.mark(p, 'x', st)
      expect(packCapture.snapshot(p).blocking).toBe(true)
    }
    packCapture.mark(p, 'x', 'saved')
    expect(packCapture.snapshot(p)).toMatchObject({
      blocking: false,
      pending: 0,
      saved: 1,
      intendedTotal: 1,
    })
  })

  it('removing a committed photo drops it from intent (no lingering high-water)', () => {
    const p = freshPack()
    packCapture.syncBaseline(p, 4)
    packCapture.commit(p, 'gone')
    packCapture.mark(p, 'gone', 'failed')
    expect(packCapture.snapshot(p)).toMatchObject({ intendedTotal: 5, blocking: true })

    packCapture.remove(p, 'gone')
    // Back to the server baseline — nothing durable is left behind.
    expect(packCapture.snapshot(p)).toMatchObject({ intendedTotal: 4, blocking: false })
  })
})

describe('REGRESSION: a background uploader MUST report back or the pack sticks', () => {
  // Live incident, 20 Jul 2026. The server had stored the pack completely
  // (linked 8, completed_intents 8, unresolved 0) while the screen read
  // "Uploading 3 of 13" for over an hour and Submit stayed disabled. Cause:
  // evidence-capture committed each released photo here as 'pending', then the
  // durable queue took over uploading and nothing ever marked them saved.
  // Only a page reload cleared it.
  it('committed-but-never-marked photos block FOREVER — this is the trap', () => {
    const p = freshPack()
    packCapture.syncBaseline(p, 10)
    for (const id of ['a', 'b', 'c']) packCapture.commit(p, id)
    // No amount of elapsed time or server success changes this on its own.
    expect(packCapture.snapshot(p)).toMatchObject({
      intendedTotal: 13,
      pending: 3,
      blocking: true,
    })
  })

  it('marking saved — what the queue now does — releases the pack', () => {
    const p = freshPack()
    packCapture.syncBaseline(p, 10)
    for (const id of ['a', 'b', 'c']) packCapture.commit(p, id)
    for (const id of ['a', 'b', 'c']) packCapture.mark(p, id, 'saved')
    expect(packCapture.snapshot(p)).toMatchObject({
      intendedTotal: 13,
      pending: 0,
      saved: 3,
      blocking: false,
    })
  })

  it('a partially reported batch still blocks on exactly the stragglers', () => {
    const p = freshPack()
    packCapture.syncBaseline(p, 10)
    for (const id of ['a', 'b', 'c']) packCapture.commit(p, id)
    packCapture.mark(p, 'a', 'saved')
    packCapture.mark(p, 'b', 'failed')
    expect(packCapture.snapshot(p)).toMatchObject({ pending: 2, failed: 1, blocking: true })
  })

  it('reporting an id this session never committed is a safe no-op', () => {
    // Resumed-after-reload records: the queue addresses photos the fresh store
    // has never seen. It must not invent local work and re-block the pack.
    const p = freshPack()
    packCapture.syncBaseline(p, 8)
    packCapture.mark(p, 'from-a-previous-session', 'saved')
    packCapture.mark(p, 'from-a-previous-session', 'failed')
    expect(packCapture.snapshot(p)).toMatchObject({
      intendedTotal: 8,
      pending: 0,
      blocking: false,
    })
  })
})

describe('pack-capture-store: no persistence => no deadlock after reload', () => {
  it('a reload (fresh store entry) derives intent from the server, not history', () => {
    // Session 1: commit 5 on top of 10, only 3 land, then the tab is closed.
    const before = freshPack()
    packCapture.syncBaseline(before, 10)
    for (let i = 0; i < 5; i++) packCapture.commit(before, `p${i}`)
    expect(packCapture.snapshot(before).intendedTotal).toBe(15)

    // Session 2 (reload): a new store entry, seeded ONLY from the server's
    // linked count. The old high-water of 15 must not survive, otherwise a
    // pack the server considers complete could never be submitted.
    const after = freshPack()
    packCapture.syncBaseline(after, 13)
    expect(packCapture.snapshot(after)).toMatchObject({
      intendedTotal: 13,
      blocking: false,
    })
  })

  it('after a server-audited discard the store never blocks on its own', () => {
    // The discard happens server-side; this browser simply has no session work.
    const p = freshPack()
    packCapture.syncBaseline(p, 4)
    expect(packCapture.snapshot(p).blocking).toBe(false)
    expect(packCapture.snapshot(p).intendedTotal).toBe(4)
    // Any remaining block must therefore come from server unresolved intents,
    // which is what PackSubmitButton/PackStatusBanner consume.
  })
})
