import { describe, it, expect } from 'vitest'
import {
  describeQueue,
  MAX_AUTO_RETRY_ATTEMPTS,
  missingScopeFields,
  msUntilNextRetry,
  nextDiscardable,
  nextStageable,
  nextUploadable,
  thumbBadge,
  packScopeError,
  recordMatchesScope,
  retryDelayMs,
  summarizeQueue,
  type QueuedPhotoMeta,
  type QueuedPhotoState,
} from '@/lib/photos/photo-queue-state'

let seq = 0
function rec(state: QueuedPhotoState, o: Partial<QueuedPhotoMeta> = {}): QueuedPhotoMeta {
  seq += 1
  return {
    id: o.id ?? `photo-${seq}`,
    userId: 'u1',
    companyId: 'co1',
    propertyId: 'prop1',
    packId: 'pack1',
    capturedAt: '2026-07-19T15:00:00.000Z',
    note: null,
    width: 100,
    height: 100,
    sizeBytes: 1000,
    state,
    lastError: null,
    attempts: 0,
    lastAttemptAt: null,
    createdAt: o.createdAt ?? `2026-07-19T15:00:0${seq}.000Z`,
    updatedAt: '2026-07-19T15:00:00.000Z',
    ...o,
  }
}

describe('durable discard lifecycle (remove-vs-staging races)', () => {
  const NOW = 1_000_000

  it('NO INTENT AFTER DISCARD: a removed photo is invisible to every work picker', () => {
    // Covers: remove before intent creation / during slot request / during
    // object upload / after bytes staged. Whatever pipeline stage the record
    // is in, once discardRequested is persisted no picker may hand it to the
    // upload or staging path again — only the discard path may touch it.
    const stages: Partial<QueuedPhotoMeta>[] = [
      { state: 'saved_local' }, // before intent creation
      { state: 'saved_local', intentRequested: true }, // during slot request
      { state: 'saved_local', intentRequested: true, attempts: 1, lastAttemptAt: null }, // mid-upload retry
      { state: 'saved_local', intentRequested: true, bytesStaged: true }, // bytes staged
      { state: 'queued' }, // even released
      { state: 'failed', attempts: 1, lastAttemptAt: null }, // even failed
    ]
    for (const s of stages) {
      const r = rec(s.state as QueuedPhotoState, { ...s, discardRequested: true })
      expect(nextStageable([r], NOW)).toBeNull()
      expect(nextUploadable([r], NOW)).toBeNull()
      expect(nextDiscardable([r], NOW)?.id).toBe(r.id)
    }
  })

  it('discard outranks uploads: it is picked even when released work waits', () => {
    // The drain loop asks nextDiscardable FIRST; assert both have work so the
    // ordering in the loop is what resolves the removal before new uploads.
    const removed = rec('saved_local', { discardRequested: true })
    const released = rec('queued')
    expect(nextDiscardable([released, removed], NOW)?.id).toBe(removed.id)
  })

  it('failed/offline discard stays retryable and books a wake-up — never hidden', () => {
    const failing = rec('saved_local', {
      discardRequested: true,
      attempts: 3,
      lastAttemptAt: NOW,
      lastError: 'Removing photo timed out — will retry automatically',
    })
    // Inside backoff: not picked yet…
    expect(nextDiscardable([failing], NOW)).toBeNull()
    // …but a wake-up IS booked, and after backoff it is picked again.
    expect(msUntilNextRetry([failing], NOW)).toBe(retryDelayMs(3))
    expect(nextDiscardable([failing], NOW + retryDelayMs(3))?.id).toBe(failing.id)
  })

  it('discard retries have NO attempts cap — cleanup may never be abandoned', () => {
    const stubborn = rec('saved_local', {
      discardRequested: true,
      attempts: MAX_AUTO_RETRY_ATTEMPTS + 5,
      lastAttemptAt: NOW,
    })
    const delay = retryDelayMs(MAX_AUTO_RETRY_ATTEMPTS + 5)
    expect(nextDiscardable([stubborn], NOW + delay)?.id).toBe(stubborn.id)
    expect(msUntilNextRetry([stubborn], NOW)).toBe(delay)
  })

  it('summary: removed photos count as cleanup, not attachable photos, and still block', () => {
    const s = summarizeQueue([
      rec('saved_local'),
      rec('saved_local', { discardRequested: true }),
      rec('failed', { discardRequested: true }),
    ])
    expect(s).toMatchObject({ total: 3, savedLocal: 1, failed: 0, discarding: 2, blocking: true })
  })

  it('cleanup-only queue reads "Removing…", not "saved on device"', () => {
    const s = summarizeQueue([rec('saved_local', { discardRequested: true })])
    const d = describeQueue(s, true)
    expect(d.text).toContain('Removing 1 photo')
  })

  it('reload/close with unreleased staged photos: records still surface for recovery', () => {
    // The chosen durable outcome: saved_local records survive close/reload and
    // the queue panel offers them for attach. Nothing about a staged-but-
    // unreleased photo may look "done" or disappear.
    const s = summarizeQueue([
      rec('saved_local', { intentRequested: true, bytesStaged: true }),
      rec('saved_local'),
    ])
    expect(s).toMatchObject({ total: 2, savedLocal: 2, blocking: true })
    expect(describeQueue(s, true).text).toContain('2 photos saved on this device')
  })
})

describe('thumbBadge — status must come from the record, never from "online"', () => {
  it('missing record: no badge at all', () => {
    expect(thumbBadge(undefined, true)).toBeNull()
    expect(thumbBadge(null, false)).toBeNull()
  })

  it('THE LIE THAT SHIPPED: a failing photo is FAILED even while online', () => {
    const failedStaging = rec('saved_local', {
      attempts: 2,
      lastError: 'Photo upload timed out — will retry automatically',
    })
    expect(thumbBadge(failedStaging, true)).toBe('failed')
    const failedReleased = rec('failed', { lastError: 'Photo upload failed (500)' })
    expect(thumbBadge(failedReleased, true)).toBe('failed')
  })

  it('maps every state truthfully', () => {
    expect(thumbBadge(rec('saved_local', { bytesStaged: true }), true)).toBe('uploaded')
    expect(thumbBadge(rec('saved_local'), true)).toBe('uploading')
    expect(thumbBadge(rec('saved_local'), false)).toBe('saved_device')
    expect(thumbBadge(rec('saved_local', { discardRequested: true }), true)).toBe('removing')
  })

  it('removing wins over everything else, uploaded over failure history', () => {
    expect(
      thumbBadge(rec('saved_local', { discardRequested: true, bytesStaged: true }), true),
    ).toBe('removing')
    // A staged photo that once failed is still safely on the server.
    expect(thumbBadge(rec('saved_local', { bytesStaged: true, lastError: 'old' }), true)).toBe(
      'uploaded',
    )
  })
})

describe('nextStageable — upload early, attach late', () => {
  const NOW = 1_000_000

  it('picks the oldest unreleased, unstaged capture', () => {
    const a = rec('saved_local', { createdAt: '2026-07-20T10:00:01.000Z' })
    const b = rec('saved_local', { createdAt: '2026-07-20T10:00:00.000Z' })
    expect(nextStageable([a, b], NOW)?.id).toBe(b.id)
  })

  it('never re-stages and never touches released/terminal work', () => {
    expect(nextStageable([rec('saved_local', { bytesStaged: true })], NOW)).toBeNull()
    for (const st of ['queued', 'uploading', 'attaching', 'failed'] as const) {
      expect(nextStageable([rec(st)], NOW)).toBeNull()
    }
  })

  it('released work outranks staging by construction', () => {
    // The worker only asks for staging work when nextUploadable returned null.
    const released = rec('queued')
    const unstaged = rec('saved_local')
    expect(nextUploadable([released, unstaged], NOW)?.id).toBe(released.id)
    expect(nextStageable([unstaged], NOW)?.id).toBe(unstaged.id)
  })

  it('a failed staging attempt backs off instead of hammering the radio', () => {
    const r = rec('saved_local', { attempts: 1, lastAttemptAt: NOW })
    expect(nextStageable([r], NOW)).toBeNull()
    expect(nextStageable([r], NOW + retryDelayMs(1))?.id).toBe(r.id)
  })

  it('gives up auto-staging at the cap — release still uploads it the old way', () => {
    const spent = rec('saved_local', { attempts: MAX_AUTO_RETRY_ATTEMPTS, lastAttemptAt: NOW })
    expect(nextStageable([spent], NOW + 10_000_000)).toBeNull()
    // The safety valve: once RELEASED, attempts are irrelevant — the full
    // upload pipeline runs at attach. Staging can only ever speed things up.
    expect(nextUploadable([{ ...spent, state: 'queued' }], NOW)).not.toBeNull()
  })
})

describe('msUntilNextRetry — the worker must always book its own wake-up', () => {
  const NOW = 1_000_000

  it('returns null when nothing is waiting to retry', () => {
    expect(msUntilNextRetry([], NOW)).toBeNull()
    expect(msUntilNextRetry([rec('queued'), rec('uploading'), rec('saved_local')], NOW)).toBeNull()
  })

  it('THE STALL BUG: a backed-off record always yields a finite wake-up', () => {
    // nextUploadable refuses this record (still inside backoff), which makes
    // the drain loop exit. Before this helper nothing rebooked the worker and
    // the banner said "Uploading" forever.
    const r = rec('failed', { attempts: 1, lastAttemptAt: NOW })
    expect(nextUploadable([r], NOW)).toBeNull()
    expect(msUntilNextRetry([r], NOW)).toBe(retryDelayMs(1))
  })

  it('counts down as time passes and never goes negative', () => {
    const r = rec('failed', { attempts: 1, lastAttemptAt: NOW })
    const delay = retryDelayMs(1)
    expect(msUntilNextRetry([r], NOW + delay / 2)).toBe(delay / 2)
    expect(msUntilNextRetry([r], NOW + delay)).toBe(0)
    expect(msUntilNextRetry([r], NOW + delay * 10)).toBe(0)
  })

  it('wakes for the SOONEST record, not the first one seen', () => {
    const soon = rec('failed', { attempts: 1, lastAttemptAt: NOW })
    const later = rec('failed', { attempts: 5, lastAttemptAt: NOW })
    expect(msUntilNextRetry([later, soon], NOW)).toBe(retryDelayMs(1))
  })

  it('a failed record that never ran is due immediately', () => {
    expect(msUntilNextRetry([rec('failed', { attempts: 0, lastAttemptAt: null })], NOW)).toBe(0)
  })

  it('stops waking the radio after the auto-retry cap', () => {
    const spent = rec('failed', { attempts: MAX_AUTO_RETRY_ATTEMPTS, lastAttemptAt: NOW })
    expect(msUntilNextRetry([spent], NOW + 10_000_000)).toBeNull()
  })

  it('the cap never blocks the inspector’s explicit Retry', () => {
    // retryFailed() puts the record back to 'queued', which is always uploadable
    // regardless of how many attempts it has already burned.
    const revived = rec('queued', { attempts: MAX_AUTO_RETRY_ATTEMPTS + 3, lastAttemptAt: NOW })
    expect(nextUploadable([revived], NOW)).not.toBeNull()
  })

  it('an exhausted record does not mask a still-retryable one', () => {
    const spent = rec('failed', { attempts: MAX_AUTO_RETRY_ATTEMPTS, lastAttemptAt: NOW })
    const live = rec('failed', { attempts: 2, lastAttemptAt: NOW })
    expect(msUntilNextRetry([spent, live], NOW)).toBe(retryDelayMs(2))
  })
})

describe('summarizeQueue', () => {
  it('an empty queue blocks nothing', () => {
    expect(summarizeQueue([])).toMatchObject({ total: 0, blocking: false })
  })

  it('ANY record blocks — records only vanish after the server confirms', () => {
    for (const st of [
      'saved_local',
      'queued',
      'uploading',
      'attaching',
      'failed',
    ] as QueuedPhotoState[]) {
      expect(summarizeQueue([rec(st)]).blocking).toBe(true)
    }
  })

  it('counts each state', () => {
    const s = summarizeQueue([
      rec('saved_local'),
      rec('queued'),
      rec('queued'),
      rec('uploading'),
      rec('attaching'),
      rec('failed'),
    ])
    expect(s).toMatchObject({
      total: 6,
      savedLocal: 1,
      queued: 2,
      uploading: 1,
      attaching: 1,
      failed: 1,
      blocking: true,
    })
  })
})

describe('nextUploadable (sequential, concurrency 1)', () => {
  it('never picks a saved_local record (note still editable)', () => {
    expect(nextUploadable([rec('saved_local')], Date.now())).toBeNull()
  })

  it('picks the oldest queued record', () => {
    const a = rec('queued', { id: 'a', createdAt: '2026-07-19T15:00:02.000Z' })
    const b = rec('queued', { id: 'b', createdAt: '2026-07-19T15:00:01.000Z' })
    expect(nextUploadable([a, b], Date.now())?.id).toBe('b')
  })

  it('holds a failed record until its backoff elapses, then retries it', () => {
    const now = 1_000_000
    const f = rec('failed', { attempts: 3, lastAttemptAt: now })
    expect(nextUploadable([f], now)).toBeNull()
    expect(nextUploadable([f], now + retryDelayMs(3))?.id).toBe(f.id)
  })

  it('a failed record with no recorded attempt time is retryable immediately', () => {
    expect(nextUploadable([rec('failed', { lastAttemptAt: null })], Date.now())).not.toBeNull()
  })

  it('backoff grows then caps at 60s', () => {
    expect(retryDelayMs(0)).toBe(0)
    expect(retryDelayMs(1)).toBe(1000)
    expect(retryDelayMs(2)).toBe(2000)
    expect(retryDelayMs(99)).toBe(60_000)
  })
})

describe('recordMatchesScope', () => {
  const scope = { userId: 'u1', companyId: 'co1', propertyId: 'prop1', packId: 'pack1' }

  it('matches an exact scope', () => {
    expect(recordMatchesScope(rec('queued'), scope)).toBe(true)
  })

  it('rejects a different user, company, property or pack', () => {
    expect(recordMatchesScope(rec('queued', { userId: 'other' }), scope)).toBe(false)
    expect(recordMatchesScope(rec('queued', { companyId: 'other' }), scope)).toBe(false)
    expect(recordMatchesScope(rec('queued', { propertyId: 'other' }), scope)).toBe(false)
    expect(recordMatchesScope(rec('queued', { packId: 'other' }), scope)).toBe(false)
  })
})

describe('pack scope assertion (no silent memory-only bypass)', () => {
  const full = { userId: 'u', companyId: 'c', propertyId: 'p', packId: 'k' }

  it('accepts a complete scope', () => {
    expect(missingScopeFields(full)).toEqual([])
    expect(packScopeError(full)).toBeNull()
  })

  it('names every missing field', () => {
    expect(missingScopeFields({})).toEqual(['user', 'company', 'property', 'pack'])
    expect(missingScopeFields({ ...full, userId: null })).toEqual(['user'])
    expect(missingScopeFields({ ...full, packId: '' })).toEqual(['pack'])
  })

  it('fails closed with a plain-language blocking message', () => {
    const msg = packScopeError({ ...full, companyId: undefined })
    expect(msg).toContain('cannot be saved safely')
    expect(msg).toContain('do not take photos')
  })
})

describe('describeQueue', () => {
  it('reports the all-clear only when the queue is empty', () => {
    expect(describeQueue(summarizeQueue([]), true)).toEqual({
      tone: 'ok',
      text: 'All photos attached safely',
    })
  })

  it('failures win and always mention the device copy + Retry', () => {
    const d = describeQueue(summarizeQueue([rec('failed'), rec('queued')]), true)
    expect(d.tone).toBe('error')
    expect(d.text).toContain('saved on this device')
    expect(d.text).toContain('Retry')
  })

  it('reports in-flight uploads', () => {
    expect(describeQueue(summarizeQueue([rec('uploading'), rec('attaching')]), true)).toMatchObject(
      { tone: 'busy' },
    )
  })

  it('offline queued photos are described as waiting, not lost', () => {
    const d = describeQueue(summarizeQueue([rec('queued'), rec('queued')]), false)
    expect(d.tone).toBe('waiting')
    expect(d.text).toContain('waiting for connection')
    expect(d.text).toContain('safe on this device')
  })

  it('captured-but-unreleased photos read as saved, not attached', () => {
    const d = describeQueue(summarizeQueue([rec('saved_local')]), true)
    expect(d.text).toContain('saved on this device')
    expect(d.text).toContain('not attached yet')
  })
})
