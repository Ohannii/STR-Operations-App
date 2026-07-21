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
  /**
   * WORKER LEASE (epoch ms). Set when a worker moves a record into
   * `uploading`/`attaching` and renewed between phases. Every network call is
   * timeout-bounded, so a LIVE worker provably finishes or fails before its
   * lease expires — which makes an in-flight record with an EXPIRED lease
   * demonstrably stranded (page killed mid-upload) and safe to reclaim.
   * Records written before this field existed have no lease: if they sit in
   * `uploading`/`attaching`, they are by definition stranded (that version
   * had no reclaim), so absent == reclaimable.
   */
  leaseUntil?: number | null
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
  /**
   * EXHAUSTED failures only (retry cap burned). Failures still inside the
   * retry budget count as `retrying` and stay QUIET — 22 alarming cards for
   * transient blips was a live operational incident, not a UX nitpick.
   */
  failed: number
  /** Failed but still retrying automatically. Shown as ordinary progress. */
  retrying: number
  /** Records the inspector removed that the worker is still cleaning up. */
  discarding: number
  /** Any record at all means unresolved local evidence. */
  blocking: boolean
}

export function summarizeQueue(
  records: { state: QueuedPhotoState; discardRequested?: boolean; attempts: number }[],
): QueueSummary {
  let savedLocal = 0
  let queued = 0
  let uploading = 0
  let attaching = 0
  let failed = 0
  let retrying = 0
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
        if (r.attempts >= MAX_AUTO_RETRY_ATTEMPTS) failed += 1
        else retrying += 1
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
    retrying,
    // Records only disappear once the SERVER confirms the attach, so the mere
    // presence of a record means the photo is not yet safely stored.
    blocking: records.length > 0,
  }
}

/**
 * Worker lease duration. Must exceed the worst honest lifetime of one phase:
 * slot RPC (30s cap) + both PUTs (45s cap, parallel) + attach RPC (30s cap)
 * plus local writes ≈ 110s. 3 minutes gives comfortable headroom, so a fresh
 * lease can ONLY mean a live worker — including one in another tab.
 */
export const WORKER_LEASE_MS = 180_000

/** True when a record's in-flight state has no live owner. */
export function isStranded(
  r: Pick<QueuedPhotoMeta, 'state' | 'leaseUntil'>,
  nowMs: number,
): boolean {
  if (r.state !== 'uploading' && r.state !== 'attaching') return false
  return (r.leaseUntil ?? 0) <= nowMs
}

/**
 * Records safe to reclaim to `queued` at drain start. THE STALL FIX: before
 * this, a record whose page died mid-upload sat in `uploading`/`attaching`
 * forever — no picker would touch it, every resume skipped it, and the UI
 * showed "Uploading N photos…" for work that would never finish (live
 * incident, 21 Jul 2026: "8 uploading" after 20 minutes). Reclaim is safe
 * because every pipeline step is idempotent by the stable photo uuid, and a
 * FRESH lease is never reclaimed, so a genuinely running worker (this tab or
 * another) keeps exclusive ownership.
 */
export function reclaimableRecords(
  records: QueuedPhotoMeta[],
  nowMs: number,
): QueuedPhotoMeta[] {
  return records.filter((r) => !r.discardRequested && isStranded(r, nowMs))
}

/** A failed record that has burned its automatic retries. Only these surface
 *  as user-facing failures; earlier failures retry QUIETLY. */
export function isExhausted(
  r: Pick<QueuedPhotoMeta, 'state' | 'attempts'>,
): boolean {
  return r.state === 'failed' && r.attempts >= MAX_AUTO_RETRY_ATTEMPTS
}

// ----------------------------------------------------------------
// PURE CLAIM DECISIONS — executed inside claimQueuedPhoto's single
// IndexedDB readwrite transaction, which the browser serializes across
// tabs. Purity here is what makes atomic ownership unit-testable: the
// loser of two serialized claims sees the winner's record and gets null.
// ----------------------------------------------------------------

/** Claim a released record for upload. Wins only from `queued`/eligible
 *  `failed` with no live lease; refuses discard-requested records. */
export function claimForUploadDecision(
  r: QueuedPhotoMeta,
  nowMs: number,
): Partial<QueuedPhotoMeta> | null {
  if (r.discardRequested) return null
  const eligible =
    r.state === 'queued' ||
    (r.state === 'failed' &&
      (r.lastAttemptAt == null ? Infinity : nowMs - r.lastAttemptAt) >=
        retryDelayMs(r.attempts))
  if (!eligible) return null
  if ((r.leaseUntil ?? 0) > nowMs) return null // someone live owns it
  return { state: 'uploading', leaseUntil: nowMs + WORKER_LEASE_MS }
}

/** Advance an owned upload to the attach phase; refuses if ownership was
 *  lost (state changed / discard requested) since the upload claim. */
export function claimForAttachDecision(
  r: QueuedPhotoMeta,
  nowMs: number,
): Partial<QueuedPhotoMeta> | null {
  if (r.discardRequested) return null
  if (r.state !== 'uploading') return null
  return { state: 'attaching', leaseUntil: nowMs + WORKER_LEASE_MS }
}

/** Claim an unreleased record for background staging (lease only — the state
 *  stays `saved_local` so the photo remains discardable). */
export function claimForStagingDecision(
  r: QueuedPhotoMeta,
  nowMs: number,
): Partial<QueuedPhotoMeta> | null {
  if (r.discardRequested) return null
  if (r.state !== 'saved_local' || r.bytesStaged) return null
  if (r.attempts >= MAX_AUTO_RETRY_ATTEMPTS) return null
  const since = r.lastAttemptAt == null ? Infinity : nowMs - r.lastAttemptAt
  if (since < retryDelayMs(r.attempts)) return null
  if ((r.leaseUntil ?? 0) > nowMs) return null
  return { leaseUntil: nowMs + WORKER_LEASE_MS }
}

/**
 * ATOMIC RELEASE (P0 fix, 21 Jul evening). Runs inside claimQueuedPhoto's
 * transaction against the LATEST row. Patches ONLY state, lease and caption:
 * bytesStaged, storage paths and every completed-stage field are simply not
 * in the patch, so no earlier snapshot can rewind them. Clearing the lease
 * REVOKES an in-flight stager's ownership — releasing is what previously
 * left the staging lease live and locked the upload claim out for 3 minutes
 * per photo. Only `saved_local` records release; anything already released,
 * in flight, failed or removed is left exactly as it is.
 */
export function releaseDecision(
  r: QueuedPhotoMeta,
  note: string | null | undefined,
): Partial<QueuedPhotoMeta> | null {
  if (r.discardRequested) return null
  if (r.state !== 'saved_local') return null
  return {
    state: 'queued',
    leaseUntil: null,
    note: note !== undefined ? note : r.note,
  }
}

/**
 * Stale-safe staging finalisation. The stager that started may no longer own
 * the record (release revoked it; an upload claim may hold a NEW lease). Its
 * late write must be conditional and harmless: the staged facts (bytes are
 * on the server + their paths) are recorded whatever the state — they are
 * true and only ever help the fast path — but the lease is cleared ONLY when
 * the record is still `saved_local`, because in any other state the lease
 * belongs to a different owner. Removed records get nothing.
 */
export function stageFinalizeDecision(
  r: QueuedPhotoMeta,
  staged: { masterPath: string; thumbPath: string; retentionClass: string | null },
  /**
   * EXACT lease identity from THIS staging attempt's claim (the leaseUntil
   * value the claim wrote). `state === 'saved_local'` alone does NOT prove
   * ownership: a background-frozen tab can resume after its lease expired
   * and a NEW stager claimed the same record — clearing that owner's lease
   * would hand the record to two workers. The lease is released ONLY when
   * the row still carries precisely our value.
   */
  myLease: number | null,
): Partial<QueuedPhotoMeta> | null {
  if (r.discardRequested) return null
  // Staged FACTS only: deterministic for this photo id (paths are a pure
  // server-side derivation of company/property/photo ids via the same
  // relationship-verified intent row, so any two valid stagings of this id
  // produce identical values). Never state, never note, never someone
  // else's lease.
  const base: Partial<QueuedPhotoMeta> = {
    bytesStaged: true,
    masterPath: staged.masterPath,
    thumbPath: staged.thumbPath,
    retentionClass: staged.retentionClass,
    lastError: null,
    attempts: 0,
    lastAttemptAt: null,
  }
  const stillOurs =
    r.state === 'saved_local' && myLease !== null && r.leaseUntil === myLease
  return stillOurs ? { ...base, leaseUntil: null } : base
}

/**
 * Stale-safe staging failure. If the record is no longer `saved_local`, a
 * different owner has taken over (release → upload path) and the stale
 * stager records NOTHING — its failure is obsolete, and bumping attempts or
 * touching the lease would sabotage the new owner.
 */
export function stageFailureDecision(
  r: QueuedPhotoMeta,
  message: string,
  nowMs: number,
  /** Exact lease identity from this attempt's claim — same rule as
   *  stageFinalizeDecision: no identity match, no write at all. */
  myLease: number | null,
): Partial<QueuedPhotoMeta> | null {
  if (r.discardRequested) return null
  if (r.state !== 'saved_local') return null
  if (myLease === null || r.leaseUntil !== myLease) return null
  return {
    lastError: message,
    attempts: r.attempts + 1,
    lastAttemptAt: nowMs,
    leaseUntil: null,
  }
}

/**
 * ATTACH GATE for the review screen. Attach stays disabled until every
 * retained review photo is genuinely prepared: its bytes confirmed on the
 * server (bytesStaged — a create-only PUT acknowledged remotely) or the
 * record already gone because it attached. Unhydrated fails closed.
 */
export function reviewReadiness(
  retainedIds: readonly string[],
  records: Pick<QueuedPhotoMeta, 'id' | 'bytesStaged' | 'discardRequested'>[],
  hydrated: boolean,
): { ready: boolean; prepared: number; total: number } {
  const byId = new Map(records.map((r) => [r.id, r]))
  let prepared = 0
  for (const id of retainedIds) {
    if (!hydrated) continue
    const rec = byId.get(id)
    if (!rec) {
      prepared += 1 // already attached (record deleted post-confirm)
      continue
    }
    if (!rec.discardRequested && rec.bytesStaged) prepared += 1
  }
  return {
    ready: hydrated && retainedIds.length > 0 && prepared === retainedIds.length,
    prepared,
    total: retainedIds.length,
  }
}

/** Reclaim a stranded in-flight record back to `queued`. Refuses fresh
 *  leases (live owner) and removed records (cleanup path owns those). */
export function reclaimDecision(
  r: QueuedPhotoMeta,
  nowMs: number,
): Partial<QueuedPhotoMeta> | null {
  if (r.discardRequested) return null
  if (!isStranded(r, nowMs)) return null
  return { state: 'queued', leaseUntil: null }
}

// ----------------------------------------------------------------
// HONEST BATCH GATE — pure, so "Done can never lie" is unit-testable.
// ----------------------------------------------------------------

export type BatchStatus = {
  total: number
  attached: number
  outstanding: number
  exhausted: number
  complete: boolean
}

/**
 * Done semantics: a batch id counts ATTACHED only when its queue record is
 * gone AND it was not discarded. Records are deleted on exactly two paths —
 * verified server attach, and confirmed discard — and discarded ids are
 * reported by the worker (`discardedIds`), so deletion can never impersonate
 * attachment. Unhydrated state fails closed. A discarded id still present in
 * the batch (a path that should be unreachable — removal strips the batch)
 * counts as OUTSTANDING, blocking Done visibly rather than lying.
 */
export function evaluateBatch(
  batchIds: ReadonlySet<string>,
  records: Pick<QueuedPhotoMeta, 'id' | 'state' | 'attempts'>[],
  hydrated: boolean,
  discardedIds: ReadonlySet<string>,
): BatchStatus {
  const byId = new Map(records.map((r) => [r.id, r]))
  let outstanding = 0
  let exhausted = 0
  for (const id of batchIds) {
    if (!hydrated) {
      outstanding += 1
      continue
    }
    const rec = byId.get(id)
    if (rec) {
      outstanding += 1
      if (isExhausted(rec)) exhausted += 1
    } else if (discardedIds.has(id)) {
      // Deleted by the DISCARD path, not the attach path — never "attached".
      outstanding += 1
    }
  }
  return {
    total: batchIds.size,
    attached: batchIds.size - outstanding,
    outstanding,
    exhausted,
    complete: hydrated && batchIds.size > 0 && outstanding === 0,
  }
}

// ----------------------------------------------------------------
// TRUE-ORPHAN FILTER — pure form of the recovery panel's reconciliation.
// ----------------------------------------------------------------

/** See UnresolvedIntentsPanel: cross-device latency shield. */
export const ORPHAN_GRACE_MS = 2 * 60_000

export function filterTrueOrphans<T extends { id: string; createdAt: string | null }>(
  intents: T[],
  localIds: ReadonlySet<string>,
  hydrated: boolean,
  nowMs: number,
): T[] {
  if (!hydrated) return [] // an unread queue proves nothing; accuse no one
  return intents.filter((intent) => {
    if (localIds.has(intent.id)) return false // a worker owns it
    const age = intent.createdAt
      ? nowMs - new Date(intent.createdAt).getTime()
      : Infinity
    return age > ORPHAN_GRACE_MS
  })
}

/**
 * ATTACH-BOUNDARY PROOF. The attach RPC contract requires BOTH storage paths
 * as non-null strings. This narrows `string | null` inputs into that proof —
 * or returns null, in which case the caller must route the record through
 * the ordinary retry/failure path and may NOT attach, delete the local
 * record, or mark the photo successful. No cast, no non-null assertion.
 */
export function provenAttachPaths(
  masterPath: string | null,
  thumbPath: string | null,
): { masterPath: string; thumbPath: string } | null {
  if (!masterPath || !thumbPath) return null
  return { masterPath, thumbPath }
}

/**
 * Attach payload builder — pure so the caption contract is testable: the
 * caption (note) travels INSIDE the attach call, which the server confirms
 * BEFORE the local record is deleted. Record-gone therefore implies
 * caption-saved. Paths are required as PROVEN strings (see
 * provenAttachPaths); generic over the retention class so this module needs
 * no app-layer import while the call site keeps its exact RetentionClass.
 */
export function buildAttachInput<R extends string>(
  record: Pick<
    QueuedPhotoMeta,
    | 'id'
    | 'propertyId'
    | 'packId'
    | 'width'
    | 'height'
    | 'sizeBytes'
    | 'capturedAt'
    | 'note'
  >,
  masterPath: string,
  thumbPath: string,
  retentionClass: R,
): {
  photoId: string
  propertyId: string
  flagId: null
  evidencePackId: string
  masterPath: string
  thumbPath: string
  width: number
  height: number
  sizeBytes: number
  capturedAt: string
  note: string | null
  retentionClass: R
} {
  return {
    photoId: record.id,
    propertyId: record.propertyId,
    flagId: null,
    evidencePackId: record.packId,
    masterPath,
    thumbPath,
    width: record.width,
    height: record.height,
    sizeBytes: record.sizeBytes,
    capturedAt: record.capturedAt,
    note: record.note,
    retentionClass,
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
  // LEASE-EXPIRY WAKES: a record the pickers skip because of a live lease
  // (queued behind a stale staging lease, or an unstaged capture another
  // owner is holding) must get exactly one wake at the moment that lease
  // expires — otherwise it waits for an unrelated event while the inspector
  // watches nothing happen.
  for (const r of records) {
    if (r.discardRequested) continue
    const lease = r.leaseUntil ?? 0
    if (lease <= nowMs) continue
    const waiting =
      r.state === 'queued' ||
      (r.state === 'saved_local' && !r.bytesStaged && r.attempts < MAX_AUTO_RETRY_ATTEMPTS)
    if (!waiting) continue // in-flight states are the owner's business
    const ms = lease - nowMs
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
      // NO-SPIN INVARIANT (P0 regression, 21 Jul evening): a record with a
      // LIVE lease cannot be claimed, so the picker must not offer it. When
      // release didn't clear a staging lease, the drain loop picked the same
      // record, failed the claim, and spun — zero progress until the lease
      // expired, ~3 minutes per photo. Pickers and claims must always agree.
      if ((r.leaseUntil ?? 0) > nowMs) return false
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
      // Same no-spin invariant as nextUploadable: never offer what the
      // claim will refuse.
      if ((r.leaseUntil ?? 0) > nowMs) return false
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
  // QUIET RETRIES: a failure inside the retry budget is still ordinary
  // progress. Only an EXHAUSTED failure is shown as failed. A staging record
  // that gave up (saved_local at the cap) is honestly "saved on device" —
  // the release path uploads it the old way, nothing is lost.
  if (isExhausted(rec)) return 'failed'
  if (rec.state === 'saved_local' && rec.attempts >= MAX_AUTO_RETRY_ATTEMPTS) {
    return 'saved_device'
  }
  if (!online) return 'saved_device'
  return 'uploading'
}

export type QueueTone = 'ok' | 'busy' | 'waiting' | 'error'

/** Plain-language status for the queue panel. */
export function describeQueue(
  summary: QueueSummary,
  online: boolean,
): { tone: QueueTone; text: string } {
  const { total, savedLocal, queued, uploading, attaching, failed, retrying, discarding } =
    summary
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
  // EXHAUSTED failures only. A photo still inside its retry budget is
  // ordinary in-flight work and must not raise an alarm.
  if (failed > 0) {
    return {
      tone: 'error',
      text: `${failed} photo${failed === 1 ? '' : 's'} could not upload — saved on this device, tap Try again`,
    }
  }
  // MONOTONIC COUNT: unique persisted photos still to attach — never a census
  // of transient states. The old `uploading + attaching` count bounced
  // 5→4→7 across refreshes as claims/reclaims reclassified records while
  // every photo sat safely on the device. Records only disappear on
  // confirmed attach (or deliberate removal), so this number only falls.
  const leftToAttach = queued + uploading + attaching + retrying
  // Offline first: nothing is moving, and saying "Uploading" would be a lie.
  if (!online && leftToAttach > 0) {
    return {
      tone: 'waiting',
      text: `${leftToAttach} photo${leftToAttach === 1 ? '' : 's'} waiting for connection — safe on this device`,
    }
  }
  if (leftToAttach > 0) {
    return {
      tone: 'busy',
      text: `Uploading — ${leftToAttach} photo${leftToAttach === 1 ? '' : 's'} left to attach`,
    }
  }
  return {
    tone: 'waiting',
    text: `${savedLocal} photo${savedLocal === 1 ? '' : 's'} saved on this device — not attached yet`,
  }
}
