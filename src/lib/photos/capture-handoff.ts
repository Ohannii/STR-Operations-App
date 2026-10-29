/**
 * PACK PHOTO HANDOFF (caption durability rev 5, 27 Oct).
 *
 * The ONE decision both EvidenceCapture pack call sites (Attach and the
 * pack-mode "Report issue" shortcut) use to hand captured photos to the
 * durable queue. Pure orchestration with injected effects, so the fail-closed
 * rules are behaviour-tested:
 *
 *   1. LIMIT — any caption over 2,000 characters refuses the handoff before
 *      anything is released (never truncated; nothing attached);
 *   2. DURABILITY — every release caption must be durable (synchronous shadow,
 *      or a completed identity-proven IndexedDB write) BEFORE release starts.
 *      If not, NOTHING is released and the caller must not claim safety;
 *   3. RELEASE — a thrown release, or ANY photo the queue could not take
 *      (failedIds), is a failed handoff. The caller must stay on the review
 *      screen (Report issue must NOT navigate away);
 *   4. EXACT COVERAGE (rev 8) — success requires every intended photo to be
 *      PROVEN handed off. failedIds is normalised to the intended set and
 *      `handedOffIds` names exactly the proven ones, so a partial handoff can
 *      continue the proven photos while the rest stay on the review screen —
 *      and nothing already handed off is ever resent (handoffPlan);
 *   5. ONE AUTOMATIC RETRY (hotfix) — a failed first release is retried
 *      once, with the same caption edits, before any error is shown.
 */

import { CAPTION_TOO_LONG_MESSAGE, captionTooLong } from './caption-canonical'

type Edits = Record<string, { v: number; editId: string }>

export type HandoffDeps = {
  packId: string
  notes: Record<string, string | null>
  /** keeper.secureRelease — absent only when there is no keeper (no pack). */
  secureRelease?: (notes: Record<string, string | null>) => Promise<{
    ok: boolean
    edits: Edits
    unsafeIds: string[]
  }>
  release: (
    packId: string,
    notes: Record<string, string | null>,
    edits?: Edits,
  ) => Promise<{ failedIds: string[] }>
}

export type HandoffResult =
  | { ok: true }
  | {
      ok: false
      reason: 'caption_too_long' | 'caption_unsafe' | 'release_failed' | 'release_threw'
      failedIds: string[]
      /** Intended photos PROVEN handed off despite the failure (partial). */
      handedOffIds: string[]
      message: string
    }

export const CAPTION_UNSAFE_MESSAGE =
  'Captions could not be saved safely on this device (device storage is unavailable), so ' +
  'nothing was attached. Keep this screen open and try again.'

/** rev 8: never claims the photos are safely stored — a failed photo may be
 *  missing from, or unreadable in, device storage. */
export function releaseFailedMessage(count: number): string {
  return (
    `${count} photo${count === 1 ? ' was' : 's were'} NOT attached — ` +
    `${count === 1 ? 'it' : 'they'} could not be handed to the uploader. Keep this screen open ` +
    'and tap Attach again, or remove the photo and retake it.'
  )
}

export async function handOffPackRelease(deps: HandoffDeps): Promise<HandoffResult> {
  const ids = Object.keys(deps.notes)
  const tooLong = ids.filter((id) => captionTooLong(deps.notes[id]))
  if (tooLong.length > 0) {
    return {
      ok: false,
      reason: 'caption_too_long',
      failedIds: tooLong,
      handedOffIds: [],
      message: CAPTION_TOO_LONG_MESSAGE,
    }
  }

  let edits: Edits | undefined
  if (deps.secureRelease) {
    let secured: Awaited<ReturnType<NonNullable<HandoffDeps['secureRelease']>>>
    try {
      secured = await deps.secureRelease(deps.notes)
    } catch {
      return {
        ok: false,
        reason: 'caption_unsafe',
        failedIds: ids,
        handedOffIds: [],
        message: CAPTION_UNSAFE_MESSAGE,
      }
    }
    if (!secured.ok) {
      return {
        ok: false,
        reason: 'caption_unsafe',
        failedIds: secured.unsafeIds,
        handedOffIds: [],
        message: CAPTION_UNSAFE_MESSAGE,
      }
    }
    edits = secured.edits
  }

  // ONE automatic retry (hotfix, one-tap attach). A first release that
  // throws, is malformed, or reports photos it could not take is retried
  // ONCE before the inspector sees any error — with the SAME caption edit
  // identities (secureRelease ran once, above), so the retry is idempotent:
  // releaseDecision only ever moves saved_local -> queued, and a photo the
  // first attempt took late is simply proven on the second. Only photos not
  // proven by the first attempt are retried; unknown/malformed reports retry
  // the whole intended set (fail closed).
  const first = await releaseAttempt(deps, ids, edits)
  if (first.failed.length === 0) return { ok: true }
  const second = await releaseAttempt(deps, first.failed, edits)
  if (second.failed.length === 0) return { ok: true }
  const failedIds = ids.filter((id) => second.failed.includes(id))
  return {
    ok: false,
    reason: second.threw ? 'release_threw' : 'release_failed',
    failedIds,
    handedOffIds: ids.filter((id) => !failedIds.includes(id)),
    message: releaseFailedMessage(failedIds.length),
  }
}

/** One release of exactly `subset`, classified fail-closed: the photos of
 *  `subset` NOT proven handed off (all of them on a throw, a malformed
 *  result, or any report naming an id outside the subset). */
async function releaseAttempt(
  deps: HandoffDeps,
  subset: readonly string[],
  edits: Edits | undefined,
): Promise<{ failed: string[]; threw: boolean }> {
  const notes: Record<string, string | null> = {}
  for (const id of subset) notes[id] = deps.notes[id]
  let subEdits: Edits | undefined
  if (edits) {
    subEdits = {}
    for (const id of subset) if (edits[id]) subEdits[id] = edits[id]
  }
  let reported: unknown
  try {
    ;({ failedIds: reported } = await deps.release(deps.packId, notes, subEdits))
  } catch {
    return { failed: [...subset], threw: true }
  }
  if (!Array.isArray(reported)) return { failed: [...subset], threw: false }
  const inSubset = new Set(subset)
  if (reported.some((id) => !inSubset.has(id))) {
    // An unknown id can never vouch for an intended one: prove nothing.
    return { failed: [...subset], threw: false }
  }
  const failedSet = new Set(reported as string[])
  return { failed: subset.filter((id) => failedSet.has(id)), threw: false }
}

// ----------------------------------------------------------------
// Capture-session bookkeeping (rev 8) — pure, so the UI cannot drift.
// ----------------------------------------------------------------

/**
 * The photos a call site may hand off NOW: ready photos not already PROVEN
 * handed off in this capture session. Already handed-off photos are never
 * resent (their records are queued, uploading or already attached and
 * deleted — "missing" for them is expected, not a failure).
 */
export function idsToHandOff(
  readyIds: readonly string[],
  handedOff: ReadonlySet<string>,
): string[] {
  return [...new Set(readyIds)].filter((id) => !handedOff.has(id))
}

export type HandoffOutcome = {
  /** The session's proven handed-off set (the ONLY ids the Done gate counts). */
  handedOff: Set<string>
  /** Intended photos that must stay visible and retryable on review. */
  failedIds: string[]
  /** Attach: 'done' only when EVERY intended photo is proven; otherwise
   *  'review'. Report issue: may navigate only on 'done'. */
  next: 'done' | 'review'
}

export function applyHandoffOutcome(
  handedOff: ReadonlySet<string>,
  intended: readonly string[],
  result: HandoffResult,
): HandoffOutcome {
  const next = new Set(handedOff)
  if (result.ok) {
    for (const id of intended) next.add(id)
    return { handedOff: next, failedIds: [], next: 'done' }
  }
  const proven = new Set(result.handedOffIds)
  for (const id of intended) if (proven.has(id)) next.add(id)
  return {
    handedOff: next,
    failedIds: intended.filter((id) => !proven.has(id)),
    next: 'review',
  }
}

/**
 * The per-photo status line on the Attach progress/done list. A photo that
 * was never PROVEN handed off is never "Attached", whatever the queue shows
 * (its record may be missing because it was never stored).
 */
export function packRowStatus(
  inSession: boolean,
  rec: { discardRequested?: boolean; exhausted: boolean } | undefined,
  hydrated: boolean,
): 'pending' | 'not_attached' | 'attached' | 'removing' | 'failed' | 'uploading' {
  if (!inSession) return 'not_attached'
  if (!hydrated) return 'pending'
  if (!rec) return 'attached' // proven handed off + record gone = confirmed attach
  if (rec.discardRequested) return 'removing'
  if (rec.exhausted) return 'failed'
  return 'uploading'
}

// ----------------------------------------------------------------
// Capture EXIT gate (rev 9) — shared by Attach and Report issue.
// ----------------------------------------------------------------

export type CapturePhotoState = 'compressing' | 'ready' | 'uploading' | 'uploaded' | 'error'
export type CapturePhotoLite = { id: string; state: CapturePhotoState; hasBytes: boolean }

export type CaptureExitPlan = {
  /** Ready photos this exit must carry (never an already-done one). */
  eligibleIds: string[]
  /** Still compressing / being stored, or uploading in the foreground. */
  processingIds: string[]
  /** Errored photos awaiting removal / retake / retry. */
  failedIds: string[]
  /** rev 10: something is still being prepared (in pending[] or not yet). */
  preparing: boolean
  /** Exit (Attach or Report issue) may proceed only when nothing is
   *  processing and nothing has failed — never with a partial subset. */
  allowed: boolean
  blockedMessage: string | null
}

export function preparingMessage(count: number): string {
  return `Preparing photos… ${count} still processing. Wait until every photo is ready.`
}

export function failedPhotosMessage(count: number, mode: 'pack' | 'flag'): string {
  const them = count === 1 ? 'it' : 'them'
  return (
    `${count} photo${count === 1 ? '' : 's'} could not be prepared or saved. ` +
    (mode === 'flag'
      ? `Retry, remove or retake ${them} before continuing.`
      : `Remove or retake ${them} before continuing.`)
  )
}

/**
 * Classify the capture session before ANY exit. A photo is never silently
 * left out: anything not-yet-done that is not eligible BLOCKS the exit.
 *   - pack: photos PROVEN handed off earlier this session are done (never
 *     resent, never blocking);
 *   - flag: photos already uploaded in an earlier round are done;
 *   - compressing, ready-without-bytes, or uploading => processing;
 *   - error => failed.
 * An empty session is allowed (Report issue without photos).
 */
export function planCaptureExit(
  photos: readonly CapturePhotoLite[],
  handedOff: ReadonlySet<string>,
  mode: 'pack' | 'flag',
  /** rev 10: captures still BEFORE pending[] (shutter blob / gallery read). */
  captureWork = 0,
): CaptureExitPlan {
  const eligibleIds: string[] = []
  const processingIds: string[] = []
  const failedIds: string[] = []
  for (const p of photos) {
    if (mode === 'pack' && handedOff.has(p.id)) continue
    if (mode === 'flag' && p.state === 'uploaded') continue
    if (p.state === 'error') failedIds.push(p.id)
    else if (p.state === 'ready' && p.hasBytes) eligibleIds.push(p.id)
    else processingIds.push(p.id) // compressing | uploading | ready w/o bytes | uploaded (pack, unproven)
  }
  const preparing = processingIds.length + Math.max(0, captureWork)
  const blockedMessage =
    preparing > 0
      ? preparingMessage(preparing)
      : failedIds.length > 0
        ? failedPhotosMessage(failedIds.length, mode)
        : null
  return {
    eligibleIds,
    processingIds,
    failedIds,
    preparing: preparing > 0,
    allowed: blockedMessage === null,
    blockedMessage,
  }
}

/**
 * rev 10: is there photo work a refresh / back / tab close would LOSE?
 * Includes `compressing` (the only interval before pack bytes reach
 * IndexedDB) and captures not yet in pending[] at all.
 */
export function hasUnsavedCaptureWork(
  photos: readonly CapturePhotoLite[],
  captureWork: number,
): boolean {
  return (
    captureWork > 0 ||
    photos.some(
      (p) =>
        p.state === 'compressing' ||
        p.state === 'ready' ||
        p.state === 'uploading' ||
        p.state === 'error',
    )
  )
}

/**
 * SINGLE-FLIGHT exit guard + the session's PROVEN handed-off set (rev 9).
 * One instance is shared by Attach and Report issue:
 *   - tryEnter() is synchronous: the first tap claims it before any await; a
 *     second tap (either button) returns false and must do nothing;
 *   - record() MERGES an outcome into the proven set synchronously — an
 *     older completion can only ever ADD proven ids, never erase newer ones;
 *   - the handlers read handedOff() at call time, never a stale render
 *     snapshot.
 */
/** rev 10: one capture's claim. Ids are unique for the gate's whole
 *  lifetime (never reused across sessions), so a token from a closed
 *  session can never match a live claim of a reopened one. */
export type CaptureToken = { readonly id: number }

export class CaptureExitGate {
  private busy = false
  private proven = new Set<string>()
  /** rev 10: live capture work (shutter blob / gallery read / ingest), by
   *  token — captures overlap, so this is a set, never a boolean. */
  private captures = new Set<number>()
  /** Monotonic for the gate's lifetime — NOT reset per session. */
  private nextToken = 1

  /** Exit (Attach / Report issue). Fails while another exit is in flight OR
   *  any capture is still being prepared (it is not in pending[] yet). */
  tryEnter(): boolean {
    if (this.busy || this.captures.size > 0) return false
    this.busy = true
    return true
  }

  /**
   * rev 10: claim capture work SYNCHRONOUSLY, before the capture's first
   * await. Returns null — the capture must not start — while an exit holds
   * the gate.
   */
  beginCapture(): CaptureToken | null {
    if (this.busy) return null
    const token = { id: this.nextToken++ }
    this.captures.add(token.id)
    return token
  }

  /** Release exactly this capture's claim (idempotent; a token from a
   *  closed session matches nothing — reset() already dropped it). */
  endCapture(token: CaptureToken): void {
    this.captures.delete(token.id)
  }

  /** May this capture still change the CURRENT session? */
  isCurrent(token: CaptureToken): boolean {
    return this.captures.has(token.id)
  }

  get captureWork(): number {
    return this.captures.size
  }

  leave(): void {
    this.busy = false
  }

  get inFlight(): boolean {
    return this.busy
  }

  handedOff(): ReadonlySet<string> {
    return new Set(this.proven)
  }

  record(intended: readonly string[], result: HandoffResult): HandoffOutcome {
    const outcome = applyHandoffOutcome(this.proven, intended, result)
    this.proven = outcome.handedOff
    return { ...outcome, handedOff: new Set(this.proven) }
  }

  /** The inspector removed this photo: it leaves the session. */
  forget(id: string): void {
    this.proven.delete(id)
  }

  /** Session closed: every outstanding capture claim of the old session is
   *  dropped, so its late completion is inert (ids are never reused). */
  reset(): void {
    this.proven = new Set()
    this.busy = false
    this.captures = new Set()
  }
}

/**
 * Photos the CLOSE confirm must warn about (rev 9). Never weakened while
 * anything is genuinely outstanding:
 *   - flag: every photo not uploaded;
 *   - pack: every photo not proven handed off, plus — until the batch is
 *     complete (server-attached) — the handed-off ones too. Once the batch
 *     is complete, attached photos are not "NOT attached".
 */
export function photosToWarnOnClose(
  photos: readonly CapturePhotoLite[],
  handedOff: ReadonlySet<string>,
  mode: 'pack' | 'flag',
  batchComplete: boolean,
): string[] {
  if (mode === 'flag') return photos.filter((p) => p.state !== 'uploaded').map((p) => p.id)
  return photos.filter((p) => !(handedOff.has(p.id) && batchComplete)).map((p) => p.id)
}
