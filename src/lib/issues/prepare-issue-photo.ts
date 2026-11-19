/**
 * Include a pre-arrival PACK photo in a new issue — server-side, no re-upload.
 *
 * The pack photo stays exactly as it is (row, file and caption untouched).
 * The issue gets its OWN photo: the stored master + thumbnail are COPIED
 * byte-for-byte inside Storage to the issue's own server-derived paths, so
 * the existing finalize_flag_with_photos checks (exact files at the derived
 * flag paths) apply unchanged. Nothing is downloaded to or re-compressed on
 * the phone.
 *
 * Retry-safe: the copy targets are derived from (company, proposed flag id,
 * new photo id), so a retry with the same ids finds the objects already
 * there and verifies them exactly — never overwriting.
 *
 * Pure orchestration (I/O injected) so every branch is unit-testable.
 */

import { masterStoragePath, thumbStoragePath } from '@/lib/photos/paths'
import type { ObjectPresence } from '@/lib/photos/object-presence'
import type { CollisionCheckResult } from '@/lib/photos/collision-check'

export type PackPhotoRow = {
  id: string
  company_id: string
  property_id: string | null
  evidence_pack_id: string | null
  storage_path: string | null
  thumbnail_path: string | null
  width: number | null
  height: number | null
  size_bytes: number | null
  sync_status: string | null
  deleted_at: string | null
  bytes_deleted_at: string | null
}

export type IssuePhotoDescriptor = {
  photoId: string
  width: number
  height: number
  sizeBytes: number
}

export type PrepareIssuePhotoResult =
  | { ok: true; photo: IssuePhotoDescriptor }
  | { ok: false; error: string }

export type CopyOutcome = { ok: true } | { ok: false; conflict: boolean }

export type PrepareIssuePhotoIO = {
  /** RLS-scoped read of the pack photo row ('error' on a failed read). */
  loadPackPhoto: (packPhotoId: string) => Promise<PackPhotoRow | null | 'error'>
  /** Existing collision guard: the proposed flag id / new photo id are unused. */
  collision: (proposedFlagId: string, newPhotoId: string) => Promise<CollisionCheckResult>
  /** Storage copy within the evidence bucket (create-only; conflict if the target exists). */
  copy: (fromPath: string, toPath: string) => Promise<CopyOutcome>
  /** Exact presence of one object (see object-presence.ts). */
  presence: (path: string) => Promise<ObjectPresence>
}

export const PREPARE_PHOTO_FAILED = 'Could not attach the pack photo. Try again.'

const positive = (n: number | null): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

export async function prepareIssuePhotoFromPack(
  io: PrepareIssuePhotoIO,
  input: {
    companyId: string
    propertyId: string
    proposedFlagId: string
    packPhotoId: string
    newPhotoId: string
  },
): Promise<PrepareIssuePhotoResult> {
  const row = await io.loadPackPhoto(input.packPhotoId)
  if (row === 'error') return { ok: false, error: PREPARE_PHOTO_FAILED }
  if (
    !row ||
    row.company_id !== input.companyId ||
    row.property_id !== input.propertyId ||
    !row.evidence_pack_id ||
    row.deleted_at ||
    row.bytes_deleted_at ||
    row.sync_status !== 'synced' ||
    !row.storage_path ||
    !row.thumbnail_path
  ) {
    return { ok: false, error: 'That pack photo is not available to report from.' }
  }
  if (!positive(row.width) || !positive(row.height) || !positive(row.size_bytes)) {
    return { ok: false, error: 'That pack photo is missing its size details and cannot be reported.' }
  }

  const collision = await io.collision(input.proposedFlagId, input.newPhotoId)
  if (!collision.ok) return { ok: false, error: collision.error }

  const ctx = {
    kind: 'flag' as const,
    companyId: input.companyId,
    flagId: input.proposedFlagId,
    photoId: input.newPhotoId,
  }
  const pairs: Array<[string, string]> = [
    [row.storage_path, masterStoragePath(ctx)],
    [row.thumbnail_path, thumbStoragePath(ctx)],
  ]
  for (const [from, to] of pairs) {
    const copied = await io.copy(from, to)
    if (copied.ok) continue
    // Already there from an earlier attempt? Accept ONLY on exact proof.
    if (copied.conflict && (await io.presence(to)) === 'present') continue
    return { ok: false, error: PREPARE_PHOTO_FAILED }
  }

  return {
    ok: true,
    photo: {
      photoId: input.newPhotoId,
      width: row.width,
      height: row.height,
      sizeBytes: row.size_bytes,
    },
  }
}

/** A Storage copy error that means "the target object already exists". */
export function isCopyConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as { statusCode?: unknown; message?: unknown }
  if (String(e.statusCode ?? '') === '409') return true
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  return msg.includes('already exists') || msg.includes('duplicate')
}
