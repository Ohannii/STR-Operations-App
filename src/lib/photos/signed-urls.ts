/**
 * Server-side helpers for issuing signed read URLs to the
 * evidence-photos bucket.
 *
 * Two TTLs:
 *   - THUMB_TTL_SECONDS — long-ish (10 min). Thumbnails get rendered
 *     in grids that may stay open for a while. URLs are still short
 *     enough that a stray leak goes stale quickly.
 *   - MASTER_TTL_SECONDS — short (5 min). Masters open in a new
 *     tab when the user clicks a thumbnail; the user reads, closes.
 *
 * Per the cost rules in PHOTO_AND_EVIDENCE_SYSTEM.md, these are
 * signed URLs to EXISTING objects — never transform requests.
 * Calling supabase.storage.from(...).createSignedUrls() must NOT
 * pass `transform: { ... }` here.
 */

import { createClient } from '@/lib/supabase/server'
import { EVIDENCE_BUCKET } from '@/lib/photos/paths'

export const THUMB_TTL_SECONDS = 600 // 10 minutes
export const MASTER_TTL_SECONDS = 300 // 5 minutes

export type SignedPhotoUrl = {
  storage_path: string
  signedUrl: string
}

/**
 * Sign a batch of storage paths for read access.
 * Returns a map keyed by storage_path. Failures are silently
 * dropped (the UI will render a broken-image placeholder for
 * missing entries — preferable to throwing on a single bad path).
 */
export async function signEvidencePaths(
  paths: string[],
  expiresIn: number,
): Promise<Record<string, string>> {
  if (paths.length === 0) return {}

  const supabase = await createClient()
  const { data, error } = await supabase.storage
    .from(EVIDENCE_BUCKET)
    .createSignedUrls(paths, expiresIn)

  if (error) {
    console.error('[photos/signed-urls] batch sign error:', error)
    return {}
  }

  const out: Record<string, string> = {}
  for (const row of data ?? []) {
    if (row.path && row.signedUrl) {
      out[row.path] = row.signedUrl
    }
  }
  return out
}
