import { describe, it, expect } from 'vitest'
import { DeadlineError, withDeadline } from '@/lib/util/deadline'
import { isCurrentOpenAttempt } from '@/lib/photos/photo-queue-db'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('withDeadline -- the Safari IndexedDB hang guard', () => {
  it('passes through a promise that settles in time', async () => {
    await expect(withDeadline(sleep(10).then(() => 'ok'), 200, 'op')).resolves.toBe('ok')
  })

  it('THE HANG CASE: a promise that never settles becomes a caught error, not a frozen await', async () => {
    // This is the exact failure mode from the field: an IndexedDB
    // transaction that fires neither oncomplete nor onabort. Before this
    // guard, the await hung forever -- Attach stuck on "0/25 done", the
    // drain worker frozen while holding the running guard.
    const never = new Promise<never>(() => {})
    await expect(withDeadline(never, 30, 'Claiming photo on device')).rejects.toThrow(
      DeadlineError,
    )
    await expect(withDeadline(never, 30, 'Claiming photo on device')).rejects.toThrow(
      'Claiming photo on device did not complete',
    )
  })

  it('propagates the underlying rejection when the work fails before the deadline', async () => {
    await expect(
      withDeadline(Promise.reject(new Error('real failure')), 200, 'op'),
    ).rejects.toThrow('real failure')
  })
})

describe('cached-open race guard (audit item 4)', () => {
  it('a late success from a condemned open attempt must NOT be adopted', () => {
    // Timeline: attempt starts at generation 3; the deadline fires and
    // dropCachedDb bumps to 4; the browser then fires onsuccess anyway.
    // The adoption rule refuses it — the zombie connection gets closed,
    // never re-cached.
    expect(isCurrentOpenAttempt(3, 4)).toBe(false)
    // The healthy case: nothing dropped since the attempt began.
    expect(isCurrentOpenAttempt(3, 3)).toBe(true)
    // Multiple drops while the attempt was in flight: still refused.
    expect(isCurrentOpenAttempt(3, 7)).toBe(false)
  })
})
