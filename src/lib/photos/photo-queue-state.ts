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
  /**
   * UPLOAD EARLY, ATTACH LATE. True once BOTH storage objects (master+thumb)
   * are on the server, even though the photo is not yet attached to the pack.
   * Staging runs in the background from the moment of capture so the explicit
   * Attach step only has the fast attach RPC left — this is what makes 40
   * photos feel like the old flow instead of one long upload at the end.
   * Absent on records written before this field existed => not staged.
   */
  bytesStaged?: boolean
  /** Slot paths captured at staging time so attach needs no second slot RPC. */
  masterPath?: string | null
  thumbPath?: string | null
  retentionClass?: string | null
  /**
   * Set to true IMMEDIATELY BEFORE the slot RPC is first called for this
   * photo. From that moment a durable server intent MAY exist (the response
   * can be lost), so any discard must go through the server. Never cleared.
   */
  intentRequested?: boolean
  /**
   * DURABLE DISCARD REQUEST — the inspector removed this photo. The UI never
   * deletes a queue record itself: it persists this flag and the worker owns
   * the cleanup (server discard if an intent may exist, then local delete).
   * This closes the race where a removal raced an in-flight staging call and
   * left an orphaned "never finished saving" intent. Workers must re-check
   * this flag after EVERY awaited boundary and abort the photo's work.
   */
  discardRequested?: boolean
  /** Audit reason persisted with the discard request. */
  discardReason?: string | null
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
  /** Records the inspector removed that the worker is still cleaning up. */
  discarding: number
  /** Any record at all means unresolved local evidence. */
  blocking: boolean
}

export function summarizeQueue(
  records: { state: QueuedPhotoState; discardRequested?: boolean }[],
): QueueSummary {
  let savedLocal = 0
  let queued = 0
  let uploading = 0
  let attaching = 0
  let failed = 0
  let discarding = 0
  for (const r of records) {
    // A discard-requested record is CLEANUP work, whatever its pipeline state.
    // It must not count as an attachable/uploading photo (the inspector
    // removed it) but it still exists, so it still blocks submission until
    // the worker confirms the server holds no intent for it. Fail closed.
    if (r.discardRequested) {
      discarding += 1
      continue
    }
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
    discarding,
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
    // Retryable work: failed released uploads, pending discards (no cap —
    // see nextDiscardable), and failed background staging (saved_local with
    // attempts burned). Every one of these must eventually get a wake-up, or
    // the queue stalls in front of a watching inspector.
    let capped: boolean
    if (r.discardRequested) {
      if (r.attempts === 0) continue // brand new request; drain is already due
      capped = false
    } else if (r.state === 'failed') {
      capped = true
    } else if (r.state === 'saved_local' && !r.bytesStaged && r.attempts > 0) {
      capped = true
    } else {
      continue
    }
    if (capped && r.attempts >= MAX_AUTO_RETRY_ATTEMPTS) continue
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
      // A removed photo must NEVER be uploaded or attached, whatever its
      // pipeline state — its only remaining work is the discard path.
      if (r.discardRequested) return false
      if (r.state === 'queued') return true
      if (r.state !== 'failed') return false
      const since = r.lastAttemptAt == null ? Infinity : nowMs - r.lastAttemptAt
      return since >= retryDelayMs(r.attempts)
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return ready[0] ?? null
}

/**
 * Cleanup pick: records the inspector removed. HIGHEST priority — an orphaned
 * intent blocks the whole pack, so resolving removals beats new uploads.
 * Backoff applies between attempts, but there is deliberately NO attempts cap:
 * the discard RPC is tiny, and abandoning cleanup would strand a hidden
 * server intent. Resume triggers keep retrying until the server answers.
 */
export function nextDiscardable(
  records: QueuedPhotoMeta[],
  nowMs: number,
): QueuedPhotoMeta | null {
  const ready = records
    .filter((r) => {
      if (!r.discardRequested) return false
      const since = r.lastAttemptAt == null ? Infinity : nowMs - r.lastAttemptAt
      return since >= retryDelayMs(r.attempts)
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return ready[0] ?? null
}

/**
 * Background staging pick: an UNRELEASED record whose bytes are not yet on the
 * server. Runs only when no released work is waiting (released work is the
 * inspector actively finishing — it wins). Staging failures back off with the
 * same attempts/lastAttemptAt ladder; a record that exhausts auto-staging is
 * simply uploaded the old way when the inspector releases it, so staging can
 * never lose a photo — it is purely an accelerator.
 */
export function nextStageable(
  records: QueuedPhotoMeta[],
  nowMs: number,
): QueuedPhotoMeta | null {
  const ready = records
    .filter((r) => {
      // No new intent may EVER be created for a removed photo.
      if (r.discardRequested) return false
      if (r.state !== 'saved_local' || r.bytesStaged) return false
      if (r.attempts >= MAX_AUTO_RETRY_ATTEMPTS) return false
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

export type ThumbBadge = 'uploaded' | 'uploading' | 'saved_device' | 'failed' | 'removing' | null

/**
 * Truthful per-photo badge for the capture strip / review list, derived ONLY
 * from the durable queue record. Never derived from "the device is online" —
 * that is how a repeatedly-failing photo lied with an "Uploading" spinner.
 */
export function thumbBadge(
  rec:
    | Pick<
        QueuedPhotoMeta,
        'state' | 'bytesStaged' | 'discardRequested' | 'lastError' | 'attempts'
      >
    | undefined
    | null,
  online: boolean,
): ThumbBadge {
  if (!rec) return null // not a queued photo (e.g. flag capture) — no badge
  if (rec.discardRequested) return 'removing'
  if (rec.bytesStaged) return 'uploaded'
  if (rec.state === 'failed' || rec.lastError != null) return 'failed'
  if (!online) return 'saved_device'
  return 'uploading'
}

export type QueueTone = 'ok' | 'busy' | 'waiting' | 'error'

/** Plain-language status for the queue panel. */
export function describeQueue(
  summary: QueueSummary,
  online: boolean,
): { tone: QueueTone; text: string } {
  const { total, savedLocal, queued, uploading, attaching, failed, discarding } = summary
  if (total === 0) {
    return { tone: 'ok', text: 'All photos attached safely' }
  }
  // Cleanup-only state: everything left is photos the inspector removed.
  if (discarding === total) {
    return {
      tone: 'busy',
      text: `Removing ${discarding} photo${discarding === 1 ? '' : 's'}…`,
    }
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
