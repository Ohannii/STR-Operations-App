/**
 * New-flag (proposedFlagId) upload planning — Slice 11B-1 hardening.
 *
 * Signed upload URLs are CREATE-ONLY (no upsert): a PUT to an object that
 * already exists fails. That is deliberate — a signed URL outlives the
 * moment it was issued, so an upsert URL could overwrite evidence that was
 * finalised in the meantime. Create-only URLs make a stale URL fail as
 * soon as its target object exists, so finalised evidence is never
 * overwritable even if an old URL is retained.
 *
 * To still support partial retries (e.g. master uploaded, thumb failed),
 * we check each object's existence BEFORE signing and only hand back a URL
 * for the object that is still missing:
 *   - neither exists            → sign both
 *   - master exists, thumb gone → sign thumb only
 *   - thumb exists, master gone → sign master only
 *   - both exist                → already_uploaded, no URLs at all
 *
 * To genuinely REPLACE a pre-finalisation photo, the caller must first
 * delete the objects via removeFlagPhotoObjects, then request fresh URLs.
 *
 * This module is pure (no Supabase/Next imports). The action injects a
 * create-only `sign` function; note the CreateOnlySigner type takes only a
 * path and has no upsert parameter, so upsert cannot be requested here.
 */

export type SignedTarget = { signedUrl: string; token: string }

/** Signs a create-only upload URL for one path. Returns null on failure. */
export type CreateOnlySigner = (path: string) => Promise<SignedTarget | null>

export type UploadPlan =
  | { status: 'already_uploaded' }
  | { status: 'upload'; needMaster: boolean; needThumb: boolean }

export function planFlagPhotoUpload(input: {
  masterExists: boolean
  thumbExists: boolean
}): UploadPlan {
  if (input.masterExists && input.thumbExists) {
    return { status: 'already_uploaded' }
  }
  return {
    status: 'upload',
    needMaster: !input.masterExists,
    needThumb: !input.thumbExists,
  }
}

export type FlagPhotoSlotResult =
  | {
      ok: true
      status: 'upload'
      photoId: string
      companyId: string
      masterPath: string
      thumbPath: string
      /** null when that object already exists (partial retry). */
      masterUpload: SignedTarget | null
      thumbUpload: SignedTarget | null
    }
  | {
      ok: true
      status: 'already_uploaded'
      photoId: string
      companyId: string
      masterPath: string
      thumbPath: string
    }
  | { ok: false; error: string }

export async function buildFlagPhotoSlot(
  input: {
    photoId: string
    companyId: string
    masterPath: string
    thumbPath: string
    masterExists: boolean
    thumbExists: boolean
  },
  sign: CreateOnlySigner,
): Promise<FlagPhotoSlotResult> {
  const base = {
    photoId: input.photoId,
    companyId: input.companyId,
    masterPath: input.masterPath,
    thumbPath: input.thumbPath,
  }

  const plan = planFlagPhotoUpload({
    masterExists: input.masterExists,
    thumbExists: input.thumbExists,
  })

  if (plan.status === 'already_uploaded') {
    // Both objects present — return no overwrite URLs at all.
    return { ok: true, status: 'already_uploaded', ...base }
  }

  let masterUpload: SignedTarget | null = null
  let thumbUpload: SignedTarget | null = null

  if (plan.needMaster) {
    masterUpload = await sign(input.masterPath)
    if (!masterUpload) {
      return { ok: false, error: 'Could not get upload slot (master).' }
    }
  }
  if (plan.needThumb) {
    thumbUpload = await sign(input.thumbPath)
    if (!thumbUpload) {
      return { ok: false, error: 'Could not get upload slot (thumb).' }
    }
  }

  return { ok: true, status: 'upload', ...base, masterUpload, thumbUpload }
}
