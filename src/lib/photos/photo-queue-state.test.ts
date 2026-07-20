import { describe, it, expect } from 'vitest'
import {
  describeQueue,
  missingScopeFields,
  nextUploadable,
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
