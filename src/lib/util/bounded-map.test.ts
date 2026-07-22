import { describe, it, expect } from 'vitest'
import { mapBounded } from '@/lib/util/bounded-map'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mapBounded -- the batch-attach stall fix (bounded, ordered)', () => {
  it('25 delayed operations run CONCURRENTLY within the bound, not sequentially', async () => {
    let active = 0
    let peak = 0
    const start = Date.now()
    await mapBounded(Array.from({ length: 25 }, (_, i) => i), 5, async () => {
      active += 1
      peak = Math.max(peak, active)
      await sleep(20)
      active -= 1
      return true
    })
    const elapsed = Date.now() - start
    expect(peak).toBeGreaterThan(1) // genuinely parallel...
    expect(peak).toBeLessThanOrEqual(5) // ...but never past the bound
    // Sequential would be >= 25 x 20 = 500ms; bounded-5 is ~5 waves ~ 100ms.
    expect(elapsed).toBeLessThan(400)
  })

  it('maximum active work NEVER exceeds the configured limit', async () => {
    let active = 0
    const violations: number[] = []
    await mapBounded(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active += 1
      if (active > 3) violations.push(active)
      await sleep(5 + Math.random() * 10)
      active -= 1
      return true
    })
    expect(violations).toEqual([])
  })

  it('scrambled completion order still returns results matched to input order', async () => {
    const delays = [30, 5, 20, 1, 15]
    const results = await mapBounded(delays, 5, async (d, i) => {
      await sleep(d)
      return `item-${i}-delay-${d}`
    })
    expect(results).toEqual([
      'item-0-delay-30',
      'item-1-delay-5',
      'item-2-delay-20',
      'item-3-delay-1',
      'item-4-delay-15',
    ])
  })

  it('DOCUMENTED SEMANTICS: a thrown task rejects the whole call -- isolation is the CALLER\'s job', async () => {
    // This is why attachEvidencePhotosBatch wraps each item in try/catch and
    // returns { ok: false, error } instead of throwing. The helper itself
    // does not swallow rejections, and this test pins that contract so the
    // doc comment can never silently drift from reality.
    await expect(
      mapBounded([1, 2, 3], 2, async (n) => {
        await sleep(5)
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })

  it('one failed item does not block successful items WHEN the caller uses result objects', async () => {
    // The batch action's pattern: convert per-item failure into a result.
    const results = await mapBounded([1, 2, 3, 4], 2, async (n) => {
      await sleep(5)
      try {
        if (n === 3) throw new Error('boom')
        return { ok: true as const, n }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : 'x' }
      }
    })
    expect(results.filter((r) => r.ok)).toHaveLength(3)
    expect(results[2]).toEqual({ ok: false, error: 'boom' })
  })

  it('degenerate bounds behave: limit 1 is sequential, oversized limit is clamped', async () => {
    let active = 0
    let peak = 0
    await mapBounded([1, 2, 3], 1, async () => {
      active += 1
      peak = Math.max(peak, active)
      await sleep(5)
      active -= 1
      return true
    })
    expect(peak).toBe(1)
    const few = await mapBounded([1, 2], 99, async (n) => n * 2)
    expect(few).toEqual([2, 4])
  })
})
