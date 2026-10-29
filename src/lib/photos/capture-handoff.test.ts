import { describe, it, expect, vi } from 'vitest'
import {
  CAPTION_UNSAFE_MESSAGE,
  CaptureExitGate,
  failedPhotosMessage,
  hasUnsavedCaptureWork,
  photosToWarnOnClose,
  planCaptureExit,
  preparingMessage,
  type CapturePhotoLite,
  type CaptureToken,
  applyHandoffOutcome,
  handOffPackRelease,
  idsToHandOff,
  packRowStatus,
  type HandoffDeps,
} from './capture-handoff'
import { CAPTION_TOO_LONG_MESSAGE } from './caption-canonical'

/**
 * PACK PHOTO HANDOFF (rev 5) — the single fail-closed decision behind BOTH
 * EvidenceCapture pack call sites (Attach and the Report-issue shortcut).
 */

const okSecure: HandoffDeps['secureRelease'] = async (notes) => ({
  ok: true,
  edits: Object.fromEntries(Object.keys(notes).map((id, i) => [id, { v: 100 + i, editId: `e${i}` }])),
  unsafeIds: [],
})

describe('ITEM 1 — length limit refuses BEFORE anything is released', () => {
  it('2,001 characters: refused, nothing secured, nothing released', async () => {
    const secure = vi.fn(okSecure)
    const release = vi.fn(async () => ({ failedIds: [] as string[] }))
    const res = await handOffPackRelease({
      packId: 'p',
      notes: { a: 'x'.repeat(2001), b: 'fine' },
      secureRelease: secure,
      release,
    })
    expect(res).toEqual({
      ok: false,
      reason: 'caption_too_long',
      failedIds: ['a'],
      handedOffIds: [],
      message: CAPTION_TOO_LONG_MESSAGE,
    })
    expect(secure).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('2,001 WHITESPACE characters are refused too (raw length, not canonical)', async () => {
    const release = vi.fn(async () => ({ failedIds: [] as string[] }))
    const res = await handOffPackRelease({ packId: 'p', notes: { a: ' '.repeat(2001) }, release })
    expect(res.ok).toBe(false)
    expect(release).not.toHaveBeenCalled()
  })

  it('exactly 2,000 characters proceeds', async () => {
    const release = vi.fn(async () => ({ failedIds: [] as string[] }))
    const res = await handOffPackRelease({
      packId: 'p',
      notes: { a: 'x'.repeat(2000) },
      secureRelease: okSecure,
      release,
    })
    expect(res).toEqual({ ok: true })
    expect(release).toHaveBeenCalledTimes(1)
  })
})

describe('ITEM 4 — release waits for PROVEN caption durability', () => {
  it('unsafe captions: NOTHING is released and nothing is claimed safe', async () => {
    const release = vi.fn(async () => ({ failedIds: [] as string[] }))
    const res = await handOffPackRelease({
      packId: 'p',
      notes: { a: 'caption' },
      secureRelease: async () => ({ ok: false, edits: {}, unsafeIds: ['a'] }),
      release,
    })
    expect(res).toEqual({
      ok: false,
      reason: 'caption_unsafe',
      failedIds: ['a'],
      handedOffIds: [],
      message: CAPTION_UNSAFE_MESSAGE,
    })
    expect(release).not.toHaveBeenCalled()
  })

  it('a throwing secure step is unsafe, not success', async () => {
    const release = vi.fn(async () => ({ failedIds: [] as string[] }))
    const res = await handOffPackRelease({
      packId: 'p',
      notes: { a: 'caption' },
      secureRelease: async () => {
        throw new Error('IndexedDB gone')
      },
      release,
    })
    expect(res).toMatchObject({ ok: false, reason: 'caption_unsafe' })
    expect(release).not.toHaveBeenCalled()
  })

  it('TERMINATION before the IndexedDB proof completes: release never started', async () => {
    let resolveProof!: (v: { ok: boolean; edits: Record<string, { v: number; editId: string }>; unsafeIds: string[] }) => void
    const release = vi.fn(async () => ({ failedIds: [] as string[] }))
    const pending = handOffPackRelease({
      packId: 'p',
      notes: { a: 'caption' },
      secureRelease: () => new Promise((r) => (resolveProof = r)),
      release,
    })
    await new Promise((r) => setTimeout(r, 10))
    // The app is killed HERE (proof still in flight): nothing was released,
    // nothing was reported safe — the handoff has not even resolved.
    expect(release).not.toHaveBeenCalled()
    let settled = false
    void pending.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    resolveProof({ ok: false, edits: {}, unsafeIds: ['a'] })
    expect((await pending).ok).toBe(false)
  })
})

describe('ITEM 3 — release failures are failures (Report issue stays put)', () => {
  it('any photo left behind => release_failed with exactly those ids', async () => {
    const res = await handOffPackRelease({
      packId: 'p',
      notes: { a: '1', b: '2' },
      secureRelease: okSecure,
      release: async () => ({ failedIds: ['b'] }),
    })
    expect(res).toMatchObject({ ok: false, reason: 'release_failed', failedIds: ['b'] })
  })

  it('a thrown release => release_threw for every intended photo', async () => {
    const res = await handOffPackRelease({
      packId: 'p',
      notes: { a: '1', b: '2' },
      secureRelease: okSecure,
      release: async () => {
        throw new Error('storage hung')
      },
    })
    expect(res).toMatchObject({ ok: false, reason: 'release_threw', failedIds: ['a', 'b'] })
  })

  it('the secured edits are what the release receives', async () => {
    const release = vi.fn(async () => ({ failedIds: [] as string[] }))
    await handOffPackRelease({ packId: 'p', notes: { a: '1' }, secureRelease: okSecure, release })
    expect(release).toHaveBeenCalledWith('p', { a: '1' }, { a: { v: 100, editId: 'e0' } })
  })
})

describe('REV 8 — exact coverage is enforced by the handoff itself', () => {
  const run = (failedIds: unknown) =>
    handOffPackRelease({
      packId: 'p',
      notes: { a: 'A', b: 'B', c: 'C' },
      secureRelease: okSecure,
      release: async () => ({ failedIds }) as { failedIds: string[] },
    })

  it('duplicate reports collapse; failedIds and handedOffIds partition the intended set', async () => {
    const res = await run(['b', 'b'])
    expect(res).toMatchObject({ ok: false, reason: 'release_failed', failedIds: ['b'], handedOffIds: ['a', 'c'] })
  })

  it('a report naming ONLY an unknown id still fails the handoff, and proves nothing', async () => {
    const res = await run(['someone-else'])
    expect(res).toMatchObject({ ok: false, failedIds: ['a', 'b', 'c'], handedOffIds: [] })
  })

  it('a malformed release result is a failure, never success', async () => {
    const res = await run(undefined)
    expect(res).toMatchObject({ ok: false, failedIds: ['a', 'b', 'c'], handedOffIds: [] })
  })

  it('failure copy never claims the photos are safely stored', async () => {
    const res = await run(['a'])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).not.toMatch(/safe/i)
  })
})

describe('REV 8 — session bookkeeping shared by both call sites', () => {
  it('idsToHandOff: unique, and never a photo already proven handed off', () => {
    expect(idsToHandOff(['a', 'b', 'b', 'c'], new Set(['a']))).toEqual(['b', 'c'])
    expect(idsToHandOff(['a'], new Set(['a']))).toEqual([])
  })

  it('applyHandoffOutcome: ok => every intended id proven, done', () => {
    const o = applyHandoffOutcome(new Set(['old']), ['a', 'b'], { ok: true })
    expect([...o.handedOff].sort()).toEqual(['a', 'b', 'old'])
    expect(o).toMatchObject({ failedIds: [], next: 'done' })
  })

  it('applyHandoffOutcome: failure => only handedOffIds join; the rest stay for review', () => {
    const o = applyHandoffOutcome(new Set(), ['a', 'b'], {
      ok: false,
      reason: 'release_failed',
      failedIds: ['b'],
      handedOffIds: ['a'],
      message: 'x',
    })
    expect([...o.handedOff]).toEqual(['a'])
    expect(o).toMatchObject({ failedIds: ['b'], next: 'review' })
  })

  it('packRowStatus: a photo never proven handed off is never "attached", record or not', () => {
    expect(packRowStatus(false, undefined, true)).toBe('not_attached')
    expect(packRowStatus(false, { exhausted: false }, true)).toBe('not_attached')
    expect(packRowStatus(true, undefined, false)).toBe('pending')
    expect(packRowStatus(true, undefined, true)).toBe('attached')
    expect(packRowStatus(true, { exhausted: true }, true)).toBe('failed')
    expect(packRowStatus(true, { discardRequested: true, exhausted: false }, true)).toBe('removing')
    expect(packRowStatus(true, { exhausted: false }, true)).toBe('uploading')
  })
})

// ----------------------------------------------------------------
// rev 9 — capture exit plan, single-flight gate, close warning.
// ----------------------------------------------------------------

const ph = (id: string, state: CapturePhotoLite['state'], hasBytes = state !== 'compressing'): CapturePhotoLite => ({
  id,
  state,
  hasBytes,
})

describe('REV 9 — planCaptureExit never lets a partial subset through', () => {
  it('(A) zero ready + one compressing: blocked as processing', () => {
    const plan = planCaptureExit([ph('a', 'compressing')], new Set(), 'pack')
    expect(plan).toMatchObject({ allowed: false, eligibleIds: [], processingIds: ['a'] })
    expect(plan.blockedMessage).toBe(preparingMessage(1))
  })

  it('(B) one ready + one compressing: blocked — the ready one is NOT released alone', () => {
    for (const mode of ['pack', 'flag'] as const) {
      const plan = planCaptureExit([ph('a', 'ready'), ph('b', 'compressing')], new Set(), mode)
      expect(plan.allowed).toBe(false)
      expect(plan.processingIds).toEqual(['b'])
    }
  })

  it('(B) a "ready" photo whose bytes are not in memory yet is still processing', () => {
    const plan = planCaptureExit([ph('a', 'ready', false)], new Set(), 'pack')
    expect(plan).toMatchObject({ allowed: false, processingIds: ['a'] })
  })

  it('(B) a foreground flag upload in progress blocks too', () => {
    const plan = planCaptureExit([ph('a', 'uploading')], new Set(), 'flag')
    expect(plan).toMatchObject({ allowed: false, processingIds: ['a'] })
  })

  it('(C) one ready + one error: blocked with a truthful remove/retake message', () => {
    const plan = planCaptureExit([ph('a', 'ready'), ph('b', 'error')], new Set(), 'pack')
    expect(plan).toMatchObject({ allowed: false, failedIds: ['b'], eligibleIds: ['a'] })
    expect(plan.blockedMessage).toBe(failedPhotosMessage(1, 'pack'))
    expect(plan.blockedMessage).toMatch(/Remove or retake it before continuing/)
    expect(planCaptureExit([ph('b', 'error')], new Set(), 'flag').blockedMessage).toMatch(/Retry, remove or retake/)
  })

  it('(D) an empty session is allowed (report an issue without photos)', () => {
    expect(planCaptureExit([], new Set(), 'pack')).toMatchObject({ allowed: true, eligibleIds: [] })
    expect(planCaptureExit([], new Set(), 'flag')).toMatchObject({ allowed: true, eligibleIds: [] })
  })

  it('(E) photos already proven handed off (pack) / uploaded (flag) neither block nor resend', () => {
    expect(planCaptureExit([ph('a', 'ready'), ph('b', 'ready')], new Set(['a']), 'pack')).toMatchObject({
      allowed: true,
      eligibleIds: ['b'],
    })
    expect(planCaptureExit([ph('a', 'ready')], new Set(['a']), 'pack')).toMatchObject({
      allowed: true,
      eligibleIds: [],
    })
    expect(planCaptureExit([ph('a', 'uploaded'), ph('b', 'ready')], new Set(), 'flag')).toMatchObject({
      allowed: true,
      eligibleIds: ['b'],
    })
  })
})

describe('REV 9 — CaptureExitGate', () => {
  it('(F/G) single flight: the second claim fails until the first leaves', () => {
    const gate = new CaptureExitGate()
    expect(gate.tryEnter()).toBe(true)
    expect(gate.tryEnter()).toBe(false) // second tap, either button
    expect(gate.inFlight).toBe(true)
    gate.leave()
    expect(gate.tryEnter()).toBe(true)
  })

  it('(H) an OLDER completion recorded later can only ADD proven ids, never erase newer ones', () => {
    const gate = new CaptureExitGate()
    gate.record(['b'], { ok: true }) // newer round proven first
    const late = gate.record(['a'], {
      ok: false,
      reason: 'release_failed',
      failedIds: ['a'],
      handedOffIds: [],
      message: 'x',
    })
    expect([...late.handedOff]).toEqual(['b'])
    expect([...gate.handedOff()]).toEqual(['b'])
  })

  it('handedOff() is a snapshot: mutating it cannot corrupt the gate', () => {
    const gate = new CaptureExitGate()
    gate.record(['a'], { ok: true })
    ;(gate.handedOff() as Set<string>).delete('a')
    expect(gate.handedOff().has('a')).toBe(true)
  })

  it('forget / reset', () => {
    const gate = new CaptureExitGate()
    gate.record(['a', 'b'], { ok: true })
    gate.forget('a')
    expect([...gate.handedOff()]).toEqual(['b'])
    gate.tryEnter()
    gate.reset()
    expect(gate.handedOff().size).toBe(0)
    expect(gate.inFlight).toBe(false)
  })
})

describe('REV 9 (I) — close warning', () => {
  const photos = [ph('a', 'ready'), ph('b', 'ready')]
  it('batch COMPLETE: handed-off (attached) photos are not warned about', () => {
    expect(photosToWarnOnClose(photos, new Set(['a', 'b']), 'pack', true)).toEqual([])
  })
  it('not weakened while anything is outstanding', () => {
    expect(photosToWarnOnClose(photos, new Set(['a', 'b']), 'pack', false)).toEqual(['a', 'b'])
    expect(photosToWarnOnClose(photos, new Set(['a']), 'pack', true)).toEqual(['b'])
    expect(photosToWarnOnClose([ph('a', 'uploaded'), ph('b', 'error')], new Set(), 'flag', true)).toEqual(['b'])
  })
})

// ----------------------------------------------------------------
// rev 10 — the PRE-PENDING capture interval.
// `rig` follows EvidenceCapture's protocol step for step (pinned to the
// component by report-issue-contract.test.ts): a capture claims a token on
// the SAME gate before its first await (shutter: canvas.toBlob; gallery:
// the file loop), appends only while its token is current, and releases in
// finally; an exit claims the gate, plans, hands off, navigates/finishes;
// close refuses mid-exit or mid-capture.
// ----------------------------------------------------------------

function rig() {
  const gate = new CaptureExitGate()
  let photos: CapturePhotoLite[] = []
  let seq = 0
  const releases: string[][] = []
  const navigations: string[] = []
  let closes = 0

  /** Ingest one image: append as compressing, then durable/ready (or error). */
  const ingest = async (token: CaptureToken, fail = false) => {
    if (!gate.isCurrent(token)) return
    const id = `photo-${++seq}`
    photos = [...photos, { id, state: 'compressing', hasBytes: false }]
    await Promise.resolve() // compression + IndexedDB write
    if (!gate.isCurrent(token)) return
    photos = photos.map((p) =>
      p.id === id ? { ...p, state: fail ? 'error' : 'ready', hasBytes: !fail } : p,
    )
  }

  /** Shutter: claim, then wait for canvas.toBlob (controlled by the test). */
  const shutter = () => {
    const token = gate.beginCapture()
    if (!token) return null
    let deliver!: (blob: 'blob' | null | 'throw') => void
    const blob = new Promise<'blob' | null | 'throw'>((r) => (deliver = r))
    const done = (async () => {
      try {
        const b = await blob
        if (b === 'throw') throw new Error('toBlob failed')
        if (!b || !gate.isCurrent(token)) return
        await ingest(token)
      } finally {
        gate.endCapture(token)
      }
    })().catch(() => {})
    return { deliver, done }
  }

  /** Gallery: ONE claim for the whole selection. */
  const gallery = (count: number) => {
    const token = gate.beginCapture()
    if (!token) return null
    const gates: Array<() => void> = []
    const done = (async () => {
      try {
        for (let i = 0; i < count; i += 1) {
          if (!gate.isCurrent(token)) break
          await new Promise<void>((r) => gates.push(r)) // reading file i
          await ingest(token)
        }
      } finally {
        gate.endCapture(token)
      }
    })()
    const step = async () => {
      while (gates.length === 0) await Promise.resolve()
      gates.shift()!()
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    }
    return { step, done }
  }

  const exit = async (kind: 'attach' | 'report') => {
    if (!gate.tryEnter()) return 'busy'
    let navigating = false
    try {
      const plan = planCaptureExit(photos, gate.handedOff(), 'pack', gate.captureWork)
      if (!plan.allowed) return 'blocked'
      const intended = plan.eligibleIds.filter((id) => !gate.handedOff().has(id))
      if (intended.length > 0) {
        releases.push(intended)
        gate.record(intended, { ok: true })
      }
      if (kind === 'report') {
        navigating = true
        navigations.push('flags/new')
      }
      return 'proceeded'
    } finally {
      if (!navigating) gate.leave()
    }
  }

  const close = () => {
    if (gate.inFlight || gate.captureWork > 0) return false
    gate.reset()
    photos = []
    closes += 1
    return true
  }

  return {
    gate,
    shutter,
    gallery,
    exit,
    close,
    get photos() {
      return photos
    },
    releases,
    navigations,
    get closes() {
      return closes
    },
  }
}

const tick = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

describe('REV 10 — the pre-pending capture interval is protected', () => {
  it('(1) shutter started, toBlob unresolved: Report issue -> zero handoffs, zero navigations', async () => {
    const r = rig()
    const shot = r.shutter()!
    expect(r.photos).toEqual([]) // nothing in pending[] yet — the old blind spot
    expect(await r.exit('report')).toBe('busy')
    expect(r.releases).toEqual([])
    expect(r.navigations).toEqual([])
    shot.deliver('blob')
    await shot.done
  })

  it('(2) shutter started, toBlob unresolved: Close does not silently close', async () => {
    const r = rig()
    const shot = r.shutter()!
    expect(r.close()).toBe(false)
    expect(r.closes).toBe(0)
    shot.deliver('blob')
    await shot.done
    expect(r.photos.map((p) => p.state)).toEqual(['ready']) // the photo survived
  })

  it('(3) shutter started, then Attach: zero partial handoff', async () => {
    const r = rig()
    // One photo already durable...
    const first = r.shutter()!
    first.deliver('blob')
    await first.done
    // ...a second one still in the canvas callback.
    const second = r.shutter()!
    expect(await r.exit('attach')).toBe('busy')
    expect(r.releases).toEqual([])
    second.deliver('blob')
    await second.done
    expect(await r.exit('attach')).toBe('proceeded')
    expect(r.releases).toEqual([['photo-1', 'photo-2']]) // the WHOLE set, once
  })

  it('(4) an exit holding the gate refuses a new capture; nothing is appended or released', async () => {
    const r = rig()
    expect(r.gate.tryEnter()).toBe(true) // Attach/Report issue claimed first
    expect(r.shutter()).toBeNull()
    expect(r.gallery(2)).toBeNull()
    await tick()
    expect(r.photos).toEqual([])
    expect(r.gate.captureWork).toBe(0)
    r.gate.leave()
  })

  it('(5) close + reopen while an old capture completes: the new session is never contaminated', async () => {
    const r = rig()
    const old = r.shutter()!
    r.gate.reset() // the session is closed by any path
    const fresh = r.shutter()! // reopened session captures
    old.deliver('blob')
    await old.done
    expect(r.photos).toEqual([]) // the old photo did not join
    expect(r.gate.captureWork).toBe(1) // ...nor clear the new capture's protection
    expect(await r.exit('report')).toBe('busy')
    fresh.deliver('blob')
    await fresh.done
    expect(r.photos.length).toBe(1)
    expect(r.gate.captureWork).toBe(0)
  })

  it('(6) overlapping captures: the first completion cannot clear the second\u2019s protection', async () => {
    const r = rig()
    const a = r.shutter()!
    const b = r.shutter()!
    expect(r.gate.captureWork).toBe(2)
    a.deliver('blob')
    await a.done
    expect(r.gate.captureWork).toBe(1)
    expect(await r.exit('report')).toBe('busy')
    expect(r.navigations).toEqual([])
    b.deliver('blob')
    await b.done
    expect(await r.exit('report')).toBe('proceeded')
    expect(r.releases).toEqual([['photo-1', 'photo-2']])
  })

  it('(7) a gallery multi-select stays protected until EVERY file has ingested', async () => {
    const r = rig()
    const pick = r.gallery(3)!
    await pick.step()
    expect(r.photos.length).toBe(1)
    expect(await r.exit('report')).toBe('busy') // 2 files still unread
    await pick.step()
    expect(await r.exit('attach')).toBe('busy')
    await pick.step()
    await pick.done
    expect(r.gate.captureWork).toBe(0)
    expect(await r.exit('attach')).toBe('proceeded')
    expect(r.releases).toEqual([['photo-1', 'photo-2', 'photo-3']])
  })

  it('claims are released on a null blob and on a thrown capture error', async () => {
    const r = rig()
    const nothing = r.shutter()!
    nothing.deliver(null)
    await nothing.done
    const broken = r.shutter()!
    broken.deliver('throw')
    await broken.done
    expect(r.gate.captureWork).toBe(0)
    expect(await r.exit('report')).toBe('proceeded') // genuinely empty again
  })

  it('(8) compressing makes hasUnsavedWork true', () => {
    expect(hasUnsavedCaptureWork([{ id: 'a', state: 'compressing', hasBytes: false }], 0)).toBe(true)
  })

  it('(9) pre-pending capture work makes hasUnsavedWork true', () => {
    expect(hasUnsavedCaptureWork([], 1)).toBe(true)
    expect(hasUnsavedCaptureWork([], 0)).toBe(false)
    expect(hasUnsavedCaptureWork([{ id: 'a', state: 'uploaded', hasBytes: true }], 0)).toBe(false)
  })

  it('(10) a genuinely empty session still permits Report issue (no release)', async () => {
    const r = rig()
    expect(await r.exit('report')).toBe('proceeded')
    expect(r.releases).toEqual([])
    expect(r.navigations.length).toBe(1)
  })

  it('(11) normal capture -> durable ready -> Attach still works', async () => {
    const r = rig()
    const shot = r.shutter()!
    shot.deliver('blob')
    await shot.done
    expect(r.photos).toEqual([{ id: 'photo-1', state: 'ready', hasBytes: true }])
    expect(await r.exit('attach')).toBe('proceeded')
    expect(r.releases).toEqual([['photo-1']])
    expect(await r.exit('attach')).toBe('proceeded') // a second Attach never resends
    expect(r.releases).toEqual([['photo-1']])
  })

  it('planCaptureExit counts pre-pending work as "preparing"', () => {
    const plan = planCaptureExit([], new Set(), 'pack', 2)
    expect(plan).toMatchObject({ allowed: false, preparing: true, eligibleIds: [] })
    expect(plan.blockedMessage).toBe(preparingMessage(2))
  })
})
