import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Pre-signing collision guard for the new-flag (proposedFlagId) capture
 * flow — Slice 11B-1 hardening.
 *
 * Before we hand a caller signed upload URLs for a client-generated
 * flag id + photo id, we must be sure those ids are NOT already in use.
 * Reusing a finalised flag/photo id could otherwise let a caller
 * overwrite existing evidence bytes.
 *
 * CRITICAL: this check must see rows that normal user RLS would hide —
 * specifically soft-deleted rows (deleted_at set) and rows in other
 * companies. So it is designed to run against a SERVICE-ROLE client and
 * it deliberately does NOT filter on deleted_at. The caller is
 * responsible for authenticating the user, resolving their company, and
 * verifying the target property belongs to that company BEFORE invoking
 * this (the service-role client is only used for the two existence
 * probes here, never to write).
 *
 * Result semantics:
 *   - a flag row with this id exists (any state) → reject
 *   - a photo row with this id exists (any state) → reject
 *   - neither exists → ok (pre-finalisation; safe to (re)issue slots)
 *
 * Because the flag row and photo rows are only ever written together by
 * finalize_flag_with_photos, "neither row exists" means the capture is
 * still pre-finalisation, so re-issuing upload slots (and overwriting a
 * partially uploaded object via upsert) is safe. Once finalised, at
 * least the photo row — and for a completed flag, the flag row — exists,
 * so this guard rejects and finalised bytes can never be overwritten.
 */

export type CollisionCheckResult = { ok: true } | { ok: false; error: string }

// Minimal surface we need — keeps the fake client in tests tiny.
type ProbeClient = Pick<SupabaseClient, 'from'>

export async function checkFlagPhotoCollision(
  admin: ProbeClient,
  input: { proposedFlagId: string; photoId: string },
): Promise<CollisionCheckResult> {
  // NOTE: no `.is('deleted_at', null)` filter — we WANT to see
  // soft-deleted rows so a soft-deleted id still counts as a collision.
  const [{ data: flagRow, error: flagErr }, { data: photoRow, error: photoErr }] =
    await Promise.all([
      admin.from('flags').select('id').eq('id', input.proposedFlagId).maybeSingle(),
      admin.from('photos').select('id').eq('id', input.photoId).maybeSingle(),
    ])

  if (flagErr) {
    return { ok: false, error: `Could not verify flag id: ${flagErr.message}` }
  }
  if (photoErr) {
    return { ok: false, error: `Could not verify photo id: ${photoErr.message}` }
  }
  if (flagRow) {
    return {
      ok: false,
      error: 'This flag has already been used. Start a new flag.',
    }
  }
  if (photoRow) {
    return {
      ok: false,
      error: 'This photo could not be started (id already in use). Retry the capture.',
    }
  }
  return { ok: true }
}
