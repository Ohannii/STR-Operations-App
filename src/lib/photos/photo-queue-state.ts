/**
 * Pure state logic for the durable pre-arrival photo queue (Outcome 3).
 *
 * WHY: an Android phone call evicted the browser page mid-batch and destroyed
 * 40 compressed photos that existed only in React state. Bytes must survive
 * the process, so every captured photo is written to app-private IndexedDB
 * BEFORE it is ever shown as "captured" and before any network call. This
 * module holds the decisions about that queue; the IndexedDB adapter and the
 * upload worker are thin shells around it, so the logic is unit-testable
 * without an IndexedDB test dependency.
 *
 * AUTHORITY: IndexedDB protects BYTES. It is never the source of truth for
 * whether a pack may submit — that remains the server (Outcome 1 submit guard
 * + Outcome 2 intents / finalise RPC).
 *
 * A record is deleted ONLY after the server confirms the photo is attached
 * (completed / already_completed), or after an explicit, audited discard.
 * There is no TTL sweep and no implicit cleanup.
 */

export type QueuedPhotoState =
  /** Bytes are safe on this device; the inspector may still edit its note. */
  | 'saved_local'
  /** Released for upload by the inspector. */
  | 'queued'
  | 'uploading'
  | 'attaching'
  /** A previous attempt failed; retryable with the SAME uuid and paths. */
  | 'failed'

/** Metadata half of a queue record (the blobs live alongside it in IndexedDB). */
export type QueuedPhotoMeta = {
  /** Logical photo UUID — stable across every retry, and the future photos.id. */
  id: string
  /** Scope. A record is only ever processed for this exact context. */
  userId: string
  companyId: string
  propertyId: string
  packId: string
  capturedAt: string
  note: string | null
  width: number
  height: number
  sizeBytes: number
  state: QueuedPhotoState
  lastError: string | null
  attempts: number
  /** Epoch ms of the last attempt, for backoff. */
  lastAttemptAt: number | null
  createdAt: string
  updatedAt: string
}

export type QueueSummary = {
  total: number
  savedLocal: number
  queued: number
  uploading: number
  attaching: number
  failed: number
  /** Any record at all means unresolved local evidence. */
  blocking: boolean
}

export function summarizeQueue(records: { state: QueuedPhotoState }[]): QueueSummary {
  let savedLocal = 0
  let queued = 0
  let uploading = 0
  let attaching = 0
  let failed = 0
  for (const r of records) {
    switch (r.state) {
      case 'saved_local':
        savedLocal += 1
        break
      case 'queued':
        queued += 1
        break
      case 'uploading':
        uploading += 1
        break
      case 'attaching':
        attaching += 1
        break
      case 'failed':
        failed += 1
        break
    }
  }
  return {
    total: records.length,
    savedLocal,
    queued,
    uploading,
    attaching,
    failed,
    // Records only disappear once the SERVER confirms the attach, so the mere
    // presence of a record means the photo is not yet safely stored.
    blocking: records.length > 0,
  }
}

/** Capped exponential backoff so a persistent failure can't hammer the radio. */
export function retryDelayMs(attempts: number): number {
  if (attempts <= 0) return 0
  const ms = 1000 * 2 ** Math.min(attempts - 1, 6) // 1s … 64s
  return Math.min(ms, 60_000)
}

/**
 * Automatic retries stop after this many attempts. The record stays `failed`
 * and visible, and the inspector's explicit Retry button still works — we just
 * stop waking the radio on our own. Without a cap, a permanently broken photo
 * would retry every 60s for the life of the session.
 */
export const MAX_AUTO_RETRY_ATTEMPTS = 6

/**
 * How long until a backed-off record becomes uploadable again, or null if
 * nothing is waiting.
 *
 * WHY THIS EXISTS: `nextUploadable` correctly refuses to return a record that
 * is inside its backoff window, which makes the worker exit. Without a
 * scheduled wake-up, that record waits for a mount / pageshow / visibility /
 * online event that may never fire while the inspector is looking straight at
 * the page — the queue looks like it is uploading forever. This gives the
 * worker exactly one timer to come back on, which is not polling.
 */
export function msUntilNextRetry(
  records: QueuedPhotoMeta[],
  nowMs: number,
): number | null {
  let best: number | null = null
  for (const r of records) {
    if (r.state !== 'failed') continue
    if (r.attempts >= MAX_AUTO_RETRY_ATTEMPTS) continue
    const remaining =
      r.lastAttemptAt == null ? 0 : retryDelayMs(r.attempts) - (nowMs - r.lastAttemptAt)
    const ms = Math.max(0, remaining)
    if (best === null || ms < best) best = ms
  }
  return best
}

/**
 * Sequential pick (concurrency 1): the oldest record that is ready to run.
 * 'saved_local' is intentionally NOT uploadable — the inspector has not
 * released it yet (they may still be adding a note).
 */
export function nextUploadable(
  records: QueuedPhotoMeta[],
  nowMs: number,
): QueuedPhotoMeta | null {
  const ready = records
    .filter((r) => {
      if (r.state === 'queued') return true
      if (r.state !== 'failed') return false
      const since = r.lastAttemptAt == null ? Infinity : nowMs - r.lastAttemptAt
      return since >= retryDelayMs(r.attempts)
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return ready[0] ?? null
}

/** True when a record's scope matches the active context exactly. */
export function recordMatchesScope(
  r: Pick<QueuedPhotoMeta, 'userId' | 'companyId' | 'propertyId' | 'packId'>,
  scope: { userId: string; companyId: string; propertyId: string; packId: string },
): boolean {
  return (
    r.userId === scope.userId &&
    r.companyId === scope.companyId &&
    r.propertyId === scope.propertyId &&
    r.packId === scope.packId
  )
}

export type PackScope = {
  userId?: string | null
  companyId?: string | null
  propertyId?: string | null
  packId?: string | null
}

/**
 * Which scope fields are missing. Pre-arrival capture must NEVER silently fall
 * back to an unqueued (memory-only) path because a scope value was absent —
 * that is precisely how photos become unrecoverable. Callers must block
 * capture and show this message.
 */
export function missingScopeFields(scope: PackScope): string[] {
  const missing: string[] = []
  if (!scope.userId) missing.push('user')
  if (!scope.companyId) missing.push('company')
  if (!scope.propertyId) missing.push('property')
  if (!scope.packId) missing.push('pack')
  return missing
}

export function packScopeError(scope: PackScope): string | null {
  const missing = missingScopeFields(scope)
  if (missing.length === 0) return null
  return (
    `Photos cannot be saved safely right now (missing ${missing.join(', ')} details). ` +
    'Reload this page before capturing — do not take photos until this is fixed.'
  )
}

export type QueueTone = 'ok' | 'busy' | 'waiting' | 'error'

/** Plain-language status for the queue panel. */
export function describeQueue(
  summary: QueueSummary,
  online: boolean,
): { tone: QueueTone; text: string } {
  const { total, savedLocal, queued, uploading, attaching, failed } = summary
  if (total === 0) {
    return { tone: 'ok', text: 'All photos attached safely' }
  }
  if (failed > 0) {
    return {
      tone: 'error',
      text: `${failed} photo${failed === 1 ? '' : 's'} failed to upload — saved on this device, tap Retry`,
    }
  }
  const inFlight = uploading + attaching
  if (inFlight > 0) {
    return { tone: 'busy', text: `Uploading ${inFlight} photo${inFlight === 1 ? '' : 's'}…` }
  }
  if (!online && queued > 0) {
    return {
      tone: 'waiting',
      text: `${queued} photo${queued === 1 ? '' : 's'} waiting for connection — safe on this device`,
    }
  }
  if (queued > 0) {
    return {
      tone: 'busy',
      text: `${queued} photo${queued === 1 ? '' : 's'} queued to upload — safe on this device`,
    }
  }
  return {
    tone: 'waiting',
    text: `${savedLocal} photo${savedLocal === 1 ? '' : 's'} saved on this device — not attached yet`,
  }
}
