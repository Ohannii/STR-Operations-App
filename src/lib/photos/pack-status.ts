/**
 * Pure status/gate contract for a draft pre-arrival pack.
 *
 * AUTHORITY ORDER (most authoritative first):
 *   1. finalize_prearrival_pack() — the server decides, atomically.
 *   2. Server signals rendered into this input: `linked` (active photo rows)
 *      and `serverUnresolved` (pending upload intents).
 *   3. `queuedLocal` — durable IndexedDB bytes not yet attached (Outcome 3).
 *   4. `pending`/`failed` — live in-session detail only.
 *
 * FAIL CLOSED: `serverUnresolved` is `number | null`. `null` means the server
 * state could NOT be read (e.g. a preview deployed before the Outcome 2
 * migration, or a failed query). That is never treated as "zero unresolved" —
 * submission is blocked until the truth is known.
 *
 * Kept pure and I/O-free so every branch is unit-testable.
 */

export type PackStatusTone = 'ready' | 'uploading' | 'failed' | 'empty' | 'unknown'

export type PackStatusInput = {
  /** Active, non-deleted photo rows on the pack (server). */
  linked: number
  /** Intended total for the pack (server floor + this session's commitments). */
  intended: number
  /** Committed but not saved this session (includes failed). */
  pending: number
  /** Failed this session. */
  failed: number
  /**
   * Unresolved server-side upload intents. `null` = UNKNOWN (fail closed).
   */
  serverUnresolved: number | null
  /** Photos held in the durable device queue, not yet attached. */
  queuedLocal?: number
}

export function describePackStatus(
  input: PackStatusInput,
): { tone: PackStatusTone; text: string } {
  const { linked, intended, pending, failed, serverUnresolved } = input
  const queuedLocal = input.queuedLocal ?? 0
  const inFlight = Math.max(0, pending - failed)

  // Unknown server state must never look safe.
  if (serverUnresolved === null) {
    return {
      tone: 'unknown',
      text: 'Cannot confirm this pack is complete — reload before submitting',
    }
  }

  // Durable device queue: bytes are safe, but the pack is not complete.
  if (queuedLocal > 0) {
    return {
      tone: 'uploading',
      text: `${queuedLocal} photo${queuedLocal === 1 ? '' : 's'} saved on this device, not yet attached — keep this page open`,
    }
  }

  // Server truth: a promised photo never landed, even if this browser is idle.
  if (serverUnresolved > 0 && inFlight === 0 && failed === 0) {
    return {
      tone: 'failed',
      text: `${serverUnresolved} photo${serverUnresolved === 1 ? '' : 's'} did not finish saving — retry or discard before submitting`,
    }
  }
  if (failed > 0) {
    return {
      tone: 'failed',
      text: `${failed} photo${failed === 1 ? '' : 's'} failed to save — retry before submitting`,
    }
  }
  if (inFlight > 0) {
    return {
      tone: 'uploading',
      text: `Uploading ${inFlight} of ${intended} photo${intended === 1 ? '' : 's'} — keep this page open`,
    }
  }
  const missing = Math.max(0, intended - linked)
  if (missing > 0) {
    return {
      tone: 'failed',
      text: `${missing} photo${missing === 1 ? '' : 's'} not saved — retry or recapture before submitting`,
    }
  }
  if (linked < 1) {
    return { tone: 'empty', text: 'Add at least one photo before submitting' }
  }
  return {
    tone: 'ready',
    text: `${linked} photo${linked === 1 ? '' : 's'} safely saved`,
  }
}

/**
 * Client-side gate. Never authoritative — it only avoids a request the server
 * would reject. Blocked by unknown server state, any durable device queue, any
 * unresolved server intent, any live in-flight/failed work, an empty pack, or
 * linked falling short of intent.
 */
export function canSubmitPack(input: PackStatusInput): boolean {
  const { linked, intended, pending, failed, serverUnresolved } = input
  const queuedLocal = input.queuedLocal ?? 0
  if (serverUnresolved === null) return false // fail closed
  if (queuedLocal > 0) return false
  if (serverUnresolved > 0) return false
  if (pending > 0 || failed > 0) return false
  if (linked < 1) return false
  return linked >= intended
}
