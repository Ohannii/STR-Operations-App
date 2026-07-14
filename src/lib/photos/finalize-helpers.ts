/**
 * Pure validation helpers for the new-flag photo finalisation (Slice 11B-1).
 * No Next/Supabase imports → unit-testable. Server-side enforcement of the
 * min-1/max-5 rule, UUID validity, and duplicate-id rejection (the UI also
 * enforces these, but the server is authoritative).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export interface PhotoDescriptor {
  photoId: string
  width: number
  height: number
  sizeBytes: number
}

export type ValidatePhotosResult =
  | { ok: true; photos: PhotoDescriptor[] }
  | { ok: false; error: string }

export const MIN_FLAG_PHOTOS = 1
export const MAX_FLAG_PHOTOS = 5

/**
 * Validate the client-submitted photo descriptor list: 1..5 entries,
 * valid photo UUIDs, no duplicates, numeric dimensions.
 */
export function validatePhotoDescriptors(input: unknown): ValidatePhotosResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'Photos must be a list.' }
  }
  if (input.length < MIN_FLAG_PHOTOS) {
    return { ok: false, error: 'At least one photo is required.' }
  }
  if (input.length > MAX_FLAG_PHOTOS) {
    return { ok: false, error: `A maximum of ${MAX_FLAG_PHOTOS} photos is allowed.` }
  }

  const seen = new Set<string>()
  const photos: PhotoDescriptor[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'Invalid photo entry.' }
    }
    const rec = entry as Record<string, unknown>
    if (!isUuid(rec.photoId)) {
      return { ok: false, error: 'Invalid photo id.' }
    }
    if (seen.has(rec.photoId)) {
      return { ok: false, error: 'Duplicate photo id.' }
    }
    seen.add(rec.photoId)

    const width = Number(rec.width)
    const height = Number(rec.height)
    const sizeBytes = Number(rec.sizeBytes)
    if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(sizeBytes)) {
      return { ok: false, error: 'Invalid photo dimensions.' }
    }

    photos.push({ photoId: rec.photoId, width, height, sizeBytes })
  }

  return { ok: true, photos }
}
