/**
 * Hard deadline for promises that may NEVER settle (P0, 22 Jul evening).
 *
 * WHY: iOS Safari IndexedDB transactions can hang without firing oncomplete
 * OR onabort (a long-known WebKit defect, aggravated by rapid connection
 * open/close churn). An unbounded `await` on such a transaction froze
 * releaseQueued -- the Attach screen sat on "Uploading 0... (0/25 done)" for
 * four minutes -- and froze drain workers WHILE they held the per-pack
 * running guard, so every automatic resume no-oped and only a page refresh
 * (fresh JS context) recovered. Bounding every storage operation converts a
 * silent permanent hang into an ordinary caught failure that the existing
 * retry/backoff/wake machinery already knows how to handle.
 */
export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not complete within ${Math.round(ms / 1000)}s`)
    this.name = 'DeadlineError'
  }
}

export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms)
    }),
  ])
}
