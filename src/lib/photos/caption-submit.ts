/**
 * SAVE-AND-SUBMIT ORCHESTRATION (caption durability rev 3, 23 Oct).
 *
 * Pure async logic, extracted from the React provider so every ordering
 * guarantee is behaviour-tested:
 *   1. caption editing is FROZEN for the whole operation (an edit typed after
 *      the submitted snapshot can never be silently cleared);
 *   2. if flushAll() is not fully confirmed, submission STOPS — the submit
 *      action is never called;
 *   3. the COMPLETE manifest, with every caption's server baseline, goes to
 *      the database, which compare-and-sets the whole set atomically;
 *   4. only a confirmed outcome acknowledges drafts, and only entries still
 *      equal to the acknowledged snapshot are cleared;
 *   5. caption_conflict marks the conflicting photos (persisted) and keeps
 *      every draft.
 */

import type { SubmitManifestEntry } from './caption-autosave'

export type SubmitActionResult =
  | { ok: true; code: 'submitted' | 'already_submitted' }
  | {
      ok: false
      code: 'caption_conflict'
      error: string
      packSubmitted: boolean
      conflicts: Array<{ photoId: string; serverNotes: string | null }>
    }
  | { ok: false; code?: undefined; error: string }

export type SubmitController = {
  setFrozen: (frozen: boolean) => void
  flushAll: () => Promise<boolean>
  snapshotForSubmit: () => SubmitManifestEntry[]
  acknowledgeSubmitted: (snapshot: ReadonlyArray<{ photoId: string; note: string }>) => string[]
  markConflicts: (c: ReadonlyArray<{ photoId: string; serverNotes: string | null }>) => void
}

export type SaveAndSubmitOutcome =
  | { kind: 'submitted'; leftover: string[] }
  | { kind: 'flush_failed' }
  | { kind: 'conflict'; error: string; packSubmitted: boolean }
  | { kind: 'failed'; error: string }

export const FLUSH_FAILED_MESSAGE =
  'Some captions are not saved to the server yet, so the pack was NOT submitted. ' +
  'It is still a draft and your captions are kept on this device.'

export async function runSaveAndSubmit(
  controller: SubmitController,
  submit: (manifest: SubmitManifestEntry[]) => Promise<SubmitActionResult>,
): Promise<SaveAndSubmitOutcome> {
  controller.setFrozen(true)
  try {
    const flushed = await controller.flushAll()
    if (!flushed) return { kind: 'flush_failed' } // NEVER submit unconfirmed captions
    const manifest = controller.snapshotForSubmit()
    const res = await submit(manifest)
    if (!res.ok) {
      if (res.code === 'caption_conflict') {
        controller.markConflicts(res.conflicts)
        return { kind: 'conflict', error: res.error, packSubmitted: res.packSubmitted }
      }
      return { kind: 'failed', error: res.error }
    }
    const leftover = controller.acknowledgeSubmitted(manifest)
    return { kind: 'submitted', leftover }
  } finally {
    controller.setFrozen(false)
  }
}
