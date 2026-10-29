/**
 * FAIL-CLOSED RPC OUTCOME ALLOW-LISTS (caption durability rev 3, 23 Oct).
 *
 * Every value the caption RPCs can return is enumerated here; anything else
 * — null, undefined, a typo, a future value, a non-string — is 'unknown' and
 * callers MUST treat it as a failure (log server-side, safe message, keep
 * the local drafts). Nothing is ever inferred as success by elimination.
 */

import { sameCaption } from './caption-canonical'

export type CaptionSaveRpcOutcome =
  | { kind: 'saved' }
  | { kind: 'unchanged' }
  | { kind: 'stale' }
  | { kind: 'unknown' }

export function interpretCaptionSaveRpc(data: unknown): CaptionSaveRpcOutcome {
  if (data === 'saved') return { kind: 'saved' }
  if (data === 'unchanged') return { kind: 'unchanged' }
  if (data === 'stale') return { kind: 'stale' }
  return { kind: 'unknown' }
}

export type SubmitRpcOutcome =
  | { kind: 'submitted' }
  | { kind: 'already_submitted' }
  | { kind: 'caption_conflict' }
  | { kind: 'unknown' }

export function interpretSubmitRpc(data: unknown): SubmitRpcOutcome {
  if (data === 'submitted') return { kind: 'submitted' }
  if (data === 'already_submitted') return { kind: 'already_submitted' }
  if (data === 'caption_conflict') return { kind: 'caption_conflict' }
  return { kind: 'unknown' }
}

/** Safe, non-sensitive description of an unexpected RPC value for server
 *  logs: its TYPE and (for short strings) the value — never caption text,
 *  which these RPCs do not return. */
export function describeUnexpected(data: unknown): string {
  if (typeof data === 'string') return `string:${data.slice(0, 40)}`
  if (data === null) return 'null'
  return typeof data
}

// ----------------------------------------------------------------
// Submit-conflict details (rev 4) — PROVEN or nothing.
// ----------------------------------------------------------------

export type ConflictDetails =
  | {
      kind: 'proven'
      packSubmitted: boolean
      conflicts: Array<{ photoId: string; serverNotes: string | null }>
    }
  | { kind: 'unproven'; reason: string }

/**
 * After the database answered 'caption_conflict', decide what the editor may
 * show. The resolvable-conflict UI is entered ONLY with proof:
 *   - both re-reads succeeded (errors are inspected, never ignored);
 *   - a submitted pack -> proven "submitted elsewhere" (no per-photo list);
 *   - a draft pack -> the photo read returned EXACTLY the requested ids
 *     (none missing, none duplicated, none unexpected), no blank caption is
 *     ever manufactured for a missing row, and at least one photo really
 *     differs from its baseline under THE canonical rule.
 * Anything else is 'unproven' -> a generic reload failure that keeps every
 * device draft and never shows an empty "choose a version" screen.
 */
export function deriveConflictDetails(
  manifest: ReadonlyArray<{ photoId: string; expected: string }>,
  photos: { data: ReadonlyArray<{ id: string; notes: string | null }> | null; error: unknown },
  pack: { data: { status: string } | null; error: unknown },
): ConflictDetails {
  if (pack.error) return { kind: 'unproven', reason: 'pack re-read failed' }
  if (!pack.data) return { kind: 'unproven', reason: 'pack not readable' }
  if (pack.data.status === 'submitted') {
    return { kind: 'proven', packSubmitted: true, conflicts: [] }
  }
  if (pack.data.status !== 'draft') return { kind: 'unproven', reason: 'unexpected pack state' }
  if (photos.error) return { kind: 'unproven', reason: 'photo re-read failed' }
  if (!photos.data) return { kind: 'unproven', reason: 'photos not readable' }

  const requested = new Set(manifest.map((m) => m.photoId))
  const byId = new Map<string, string | null>()
  for (const row of photos.data) {
    if (byId.has(row.id)) return { kind: 'unproven', reason: 'duplicate photo row' }
    if (!requested.has(row.id)) return { kind: 'unproven', reason: 'unexpected photo row' }
    byId.set(row.id, row.notes)
  }
  if (byId.size !== requested.size) return { kind: 'unproven', reason: 'missing photo row' }

  const conflicts: Array<{ photoId: string; serverNotes: string | null }> = []
  for (const m of manifest) {
    const server = byId.get(m.photoId) ?? null // present by the exact-set proof above
    if (!sameCaption(server, m.expected)) conflicts.push({ photoId: m.photoId, serverNotes: server })
  }
  if (conflicts.length === 0) {
    return { kind: 'unproven', reason: 'database conflict not locatable' }
  }
  return { kind: 'proven', packSubmitted: false, conflicts }
}

export const CONFLICT_UNPROVEN_MESSAGE =
  'Captions changed elsewhere, but the details could not be confirmed. Nothing was submitted ' +
  'and the pack is still a draft — reload the report to see the latest captions. Your typed ' +
  'captions are kept on this device.'

// ----------------------------------------------------------------
// Truthful clipboard backup (blocker 9).
// ----------------------------------------------------------------

export type CopyOutcome = 'copied' | 'unavailable' | 'failed'

/** Resolves 'copied' ONLY when the clipboard write is confirmed. Callers
 *  must show a manual-copy fallback for every other outcome. */
export async function copyTextWithFallback(
  text: string,
  clipboard: { writeText: (t: string) => Promise<void> } | null | undefined,
): Promise<CopyOutcome> {
  if (!clipboard || typeof clipboard.writeText !== 'function') return 'unavailable'
  try {
    await clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}
