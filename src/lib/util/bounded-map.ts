/**
 * Bounded-concurrency map (P0 batch-attach stall, 22 Jul).
 *
 * WHY: the batch attach action awaited 25 RPCs strictly sequentially, making
 * its duration O(n x RPC latency) -- long enough to trip serverless response
 * limits, whose lost responses sent the client into silent 30-second retry
 * cycles ("stuck for two minutes, fine after refresh"). Bounded concurrency
 * caps the wall clock at O(n/limit) without the thundering herd of an
 * unbounded Promise.all.
 *
 * GUARANTEES (unit-tested):
 *   - never more than `limit` tasks in flight at once;
 *   - results return in INPUT ORDER regardless of completion order.
 *
 * REJECTION SEMANTICS (audit correction, 22 Jul): a task that THROWS rejects
 * the whole mapBounded call -- this helper does not swallow rejections.
 * Callers that need per-item failure isolation MUST catch inside their
 * callback and return a result object ({ ok: false, error }) instead of
 * throwing, exactly as attachEvidencePhotosBatch does.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const bound = Math.max(1, Math.min(limit, items.length))
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: bound }, async () => {
    for (;;) {
      const index = next
      if (index >= items.length) return
      next += 1
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}
