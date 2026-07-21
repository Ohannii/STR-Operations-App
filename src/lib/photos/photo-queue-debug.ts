'use client'

/**
 * TEMPORARY upload diagnostics — enabled ONLY by adding ?debug_uploads=1 to
 * the URL. Off by default; delete this file and its call sites after the
 * P0 verification (21 Jul 2026).
 *
 * Records per stable photo id: compression duration + output bytes, staging
 * PUT duration, attach duration, state transitions, retry count and reason,
 * and total batch duration. NEVER logs signed URLs, image contents, captions
 * or any personal data — ids, milliseconds and byte counts only.
 *
 * Read results in the console (prefixed [upload-debug]) or dump everything:
 *   JSON.stringify(window.__uploadDebug)
 */

type DebugEvent = {
  t: number
  photoId: string | null
  event: string
  ms?: number
  bytes?: number
  detail?: string
}

declare global {
  interface Window {
    __uploadDebug?: DebugEvent[]
  }
}

export function uploadDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).has('debug_uploads')
  } catch {
    return false
  }
}

export function dbg(
  event: string,
  data: { photoId?: string | null; ms?: number; bytes?: number; detail?: string } = {},
): void {
  if (!uploadDebugEnabled()) return
  const entry: DebugEvent = {
    t: Date.now(),
    photoId: data.photoId ?? null,
    event,
    ...(data.ms !== undefined ? { ms: Math.round(data.ms) } : {}),
    ...(data.bytes !== undefined ? { bytes: data.bytes } : {}),
    ...(data.detail !== undefined ? { detail: data.detail } : {}),
  }
  window.__uploadDebug = window.__uploadDebug ?? []
  window.__uploadDebug.push(entry)
  console.log('[upload-debug]', entry.event, entry)
}

/** Time an async step and record it under `event`. Rethrows on failure with
 *  the failure recorded as `<event>:failed`. */
export async function timed<T>(
  event: string,
  photoId: string | null,
  work: () => Promise<T>,
): Promise<T> {
  if (!uploadDebugEnabled()) return work()
  const start = performance.now()
  try {
    const out = await work()
    dbg(event, { photoId, ms: performance.now() - start })
    return out
  } catch (err) {
    dbg(`${event}:failed`, {
      photoId,
      ms: performance.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}
