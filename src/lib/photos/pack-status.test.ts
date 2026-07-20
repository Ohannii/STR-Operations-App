import { describe, it, expect } from 'vitest'
import {
  canSubmitPack,
  describePackStatus,
  shouldSuppressPackStatusBanner,
  type PackStatusInput,
} from '@/lib/photos/pack-status'

function s(o: Partial<PackStatusInput> = {}): PackStatusInput {
  return {
    linked: 0,
    intended: 0,
    pending: 0,
    failed: 0,
    serverUnresolved: 0,
    queuedLocal: 0,
    ...o,
  }
}

describe('fail-closed on unknown server state (Outcome 3, req 13)', () => {
  it('blocks when the intent state could not be read (null, not zero)', () => {
    expect(canSubmitPack(s({ linked: 4, intended: 4, serverUnresolved: null }))).toBe(false)
  })

  it('says so plainly rather than looking safe', () => {
    const d = describePackStatus(s({ linked: 4, intended: 4, serverUnresolved: null }))
    expect(d.tone).toBe('unknown')
    expect(d.text).toContain('Cannot confirm')
  })

  it('an unreadable intent table never becomes "zero unresolved"', () => {
    // Same inputs, only the knowledge differs.
    expect(canSubmitPack(s({ linked: 4, intended: 4, serverUnresolved: 0 }))).toBe(true)
    expect(canSubmitPack(s({ linked: 4, intended: 4, serverUnresolved: null }))).toBe(false)
  })
})

describe('banner suppression (PackQueuePanel is authoritative)', () => {
  it('hides the banner while the device queue has records', () => {
    expect(shouldSuppressPackStatusBanner({ queuedLocal: 1 })).toBe(true)
    expect(shouldSuppressPackStatusBanner({ queuedLocal: 40 })).toBe(true)
  })

  it('hides the banner when device storage is unusable', () => {
    expect(shouldSuppressPackStatusBanner({ hasStorageError: true })).toBe(true)
  })

  it('shows the banner when there is no local queue to cover it', () => {
    expect(shouldSuppressPackStatusBanner({ queuedLocal: 0 })).toBe(false)
    expect(shouldSuppressPackStatusBanner({})).toBe(false)
  })

  it('server-unknown / unresolved still surfaces when no queue panel is shown', () => {
    expect(shouldSuppressPackStatusBanner({ queuedLocal: 0 })).toBe(false)
    expect(describePackStatus(s({ linked: 4, intended: 4, serverUnresolved: null })).tone).toBe(
      'unknown',
    )
    expect(
      describePackStatus(s({ linked: 4, intended: 4, serverUnresolved: 2 })).tone,
    ).toBe('failed')
  })

  it('SUPPRESSION IS VISUAL ONLY — submission stays blocked', () => {
    const queued = s({ linked: 25, intended: 25, queuedLocal: 1 })
    expect(shouldSuppressPackStatusBanner({ queuedLocal: 1 })).toBe(true)
    expect(canSubmitPack(queued)).toBe(false)
  })
})

describe('queue and submit gate can never disagree', () => {
  it('any queued photo blocks, and the banner never reads "ready"', () => {
    for (const queuedLocal of [1, 5, 40]) {
      const input = s({ linked: 25, intended: 25, queuedLocal })
      expect(canSubmitPack(input)).toBe(false)
      expect(describePackStatus(input).tone).not.toBe('ready')
    }
  })

  it('gate and status agree across every combination', () => {
    const values = [0, 1]
    for (const queuedLocal of values) {
      for (const pending of values) {
        for (const failed of values) {
          for (const serverUnresolved of [0, 1, null]) {
            for (const linked of [0, 2]) {
              const input = s({
                linked,
                intended: linked,
                pending,
                failed,
                serverUnresolved,
                queuedLocal,
              })
              // "ready" is the ONLY submittable state, always.
              expect(canSubmitPack(input)).toBe(describePackStatus(input).tone === 'ready')
            }
          }
        }
      }
    }
  })
})

describe('durable device queue blocks submission (Outcome 3, req 10)', () => {
  it('blocks while photos are held on the device but not attached', () => {
    expect(canSubmitPack(s({ linked: 25, intended: 25, queuedLocal: 40 }))).toBe(false)
  })

  it('says the bytes are safe and queued, and that upload resumes on return', () => {
    const d = describePackStatus(s({ linked: 25, intended: 25, queuedLocal: 40 }))
    expect(d.tone).toBe('uploading')
    expect(d.text).toContain('40 photos saved on this device')
    expect(d.text).toContain('queued for upload')
    expect(d.text).toContain('resumes automatically when you return')
  })

  it('NEVER tells the inspector to keep the page open (there is no service worker)', () => {
    // Upload does not progress while the page is closed; it resumes on return.
    // Promising otherwise would be a lie, and telling them to stay put defeats
    // the entire point of the durable queue.
    const cases: PackStatusInput[] = [
      s({ linked: 25, intended: 25, queuedLocal: 40 }),
      s({ linked: 3, intended: 5, pending: 2 }),
      s({ linked: 3, intended: 5, pending: 2, failed: 1 }),
      s({ linked: 13, intended: 15 }),
      s({ linked: 4, intended: 4, serverUnresolved: 2 }),
      s({ linked: 4, intended: 4, serverUnresolved: null }),
      s(),
      s({ linked: 4, intended: 4 }),
    ]
    for (const c of cases) {
      expect(describePackStatus(c).text.toLowerCase()).not.toContain('keep this page open')
    }
  })

  it('in-flight wording promises resume, not vigilance', () => {
    const d = describePackStatus(s({ linked: 3, intended: 5, pending: 2 }))
    expect(d.text).toContain('Uploading 2 of 5 photos')
    expect(d.text).toContain('safe to leave')
    expect(d.text).toContain('resumes automatically when you return')
  })

  it('unblocks once the queue drains and the server agrees', () => {
    expect(canSubmitPack(s({ linked: 65, intended: 65, queuedLocal: 0 }))).toBe(true)
  })
})

describe('canSubmitPack', () => {
  it('blocks an empty pack', () => {
    expect(canSubmitPack(s())).toBe(false)
  })

  it('allows a complete, quiet pack', () => {
    expect(canSubmitPack(s({ linked: 4, intended: 4 }))).toBe(true)
  })

  it('blocks while anything is in flight or failed this session', () => {
    expect(canSubmitPack(s({ linked: 4, intended: 5, pending: 1 }))).toBe(false)
    expect(canSubmitPack(s({ linked: 4, intended: 5, pending: 1, failed: 1 }))).toBe(false)
  })

  it('blocks on ANY unresolved server intent, even when this browser is idle', () => {
    // The cross-device / post-reload case: local state is clean, server is not.
    expect(canSubmitPack(s({ linked: 4, intended: 4, serverUnresolved: 1 }))).toBe(false)
  })

  it('blocks 10 existing + 5 intended when only 3 new saved (13 of 15)', () => {
    expect(canSubmitPack(s({ linked: 13, intended: 15 }))).toBe(false)
  })

  it('allows when linked meets or exceeds intent', () => {
    expect(canSubmitPack(s({ linked: 15, intended: 15 }))).toBe(true)
    expect(canSubmitPack(s({ linked: 16, intended: 15 }))).toBe(true)
  })
})

describe('durable authority: server intents, never stale local state', () => {
  // After a reload the in-memory session map is empty by design, so `intended`
  // collapses to the server-linked baseline. These cases model that.
  const afterReload = (linked: number, serverUnresolved: number) =>
    s({ linked, intended: linked, serverUnresolved })

  it('discarding the LAST pending intent unblocks the pack', () => {
    // 4 linked, 1 promised photo still unresolved -> blocked.
    expect(canSubmitPack(afterReload(4, 1))).toBe(false)
    // Inspector discards it (audited, server-side): unresolved clears.
    expect(canSubmitPack(afterReload(4, 0))).toBe(true)
  })

  it('recovering a pending intent raises linked and clears unresolved', () => {
    expect(canSubmitPack(afterReload(4, 1))).toBe(false)
    // Recovery completes the intent from Storage: linked 4 -> 5, unresolved 0.
    expect(canSubmitPack(afterReload(5, 0))).toBe(true)
  })

  it('stale local state cannot deadlock a server-complete pack', () => {
    // The old localStorage high-water would have kept intended at 15 forever.
    // Post-reload the gate derives intent from the server-linked count, so a
    // pack the server considers complete is submittable.
    expect(canSubmitPack(afterReload(13, 0))).toBe(true)
    expect(describePackStatus(afterReload(13, 0)).tone).toBe('ready')
  })

  it("another browser's pending intent still blocks this one", () => {
    // Nothing in flight locally, but the server knows a photo was promised.
    expect(canSubmitPack(s({ linked: 4, intended: 4, serverUnresolved: 2 }))).toBe(false)
  })

  it('live session work still blocks before any reload', () => {
    // 10 already linked + 5 committed this session, only 3 saved.
    expect(canSubmitPack(s({ linked: 13, intended: 15, pending: 2, failed: 2 }))).toBe(false)
  })
})

describe('describePackStatus', () => {
  it('server-unresolved takes precedence when the session looks idle', () => {
    const d = describePackStatus(s({ linked: 4, intended: 4, serverUnresolved: 2 }))
    expect(d.tone).toBe('failed')
    expect(d.text).toContain('2 photos did not finish saving')
  })

  it('reports local failures', () => {
    const d = describePackStatus(s({ linked: 3, intended: 5, pending: 2, failed: 2 }))
    expect(d).toEqual({
      tone: 'failed',
      text: '2 photos failed to save — retry before submitting',
    })
  })

  it('reports in-flight progress against the intended total', () => {
    const d = describePackStatus(s({ linked: 3, intended: 5, pending: 2, failed: 0 }))
    expect(d.tone).toBe('uploading')
    expect(d.text).toContain('Uploading 2 of 5 photos')
    // Wording deliberately changed: there is no service worker, so the honest
    // promise is resume-on-return, not vigilance. Asserted fully above in
    // "in-flight wording promises resume, not vigilance".
    expect(d.text).toContain('resumes automatically when you return')
  })

  it('reports missing photos when the session is idle but short', () => {
    const d = describePackStatus(s({ linked: 13, intended: 15 }))
    expect(d.tone).toBe('failed')
    expect(d.text).toContain('2 photos not saved')
  })

  it('reports the empty state', () => {
    expect(describePackStatus(s())).toEqual({
      tone: 'empty',
      text: 'Add at least one photo before submitting',
    })
  })

  it('reports the safe state with correct singular/plural', () => {
    expect(describePackStatus(s({ linked: 4, intended: 4 })).text).toBe('4 photos safely saved')
    expect(describePackStatus(s({ linked: 1, intended: 1 })).text).toBe('1 photo safely saved')
  })

  it('status and gate agree: only "ready" is submittable', () => {
    const cases: PackStatusInput[] = [
      s(),
      s({ linked: 4, intended: 4 }),
      s({ linked: 4, intended: 4, serverUnresolved: 1 }),
      s({ linked: 3, intended: 5, pending: 2 }),
      s({ linked: 3, intended: 5, pending: 2, failed: 2 }),
      s({ linked: 13, intended: 15 }),
    ]
    for (const c of cases) {
      expect(canSubmitPack(c)).toBe(describePackStatus(c).tone === 'ready')
    }
  })
})
