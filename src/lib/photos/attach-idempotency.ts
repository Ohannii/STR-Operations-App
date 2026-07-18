/**
 * Pure comparison for idempotent photo attach (Outcome 1, req 9).
 *
 * When `attachEvidencePhoto` hits a primary-key conflict (23505), the retry
 * is idempotent ONLY if the row that already exists is the SAME logical
 * photo — same company, property, pack/flag, storage paths — and is not
 * soft-deleted. Any mismatch must fail closed (never treat a conflicting
 * row as success). Kept pure so every branch is unit-testable.
 */

export type ExistingPhotoIdentity = {
  companyId: string
  propertyId: string
  flagId: string | null
  evidencePackId: string | null
  storagePath: string
  thumbnailPath: string
  deletedAt: string | null
}

export type ExpectedPhotoIdentity = {
  companyId: string
  propertyId: string
  flagId: string | null
  evidencePackId: string | null
  storagePath: string
  thumbnailPath: string
}

export function photoIdentityMatches(
  existing: ExistingPhotoIdentity,
  expected: ExpectedPhotoIdentity,
): boolean {
  return (
    existing.deletedAt === null &&
    existing.companyId === expected.companyId &&
    existing.propertyId === expected.propertyId &&
    (existing.flagId ?? null) === (expected.flagId ?? null) &&
    (existing.evidencePackId ?? null) === (expected.evidencePackId ?? null) &&
    existing.storagePath === expected.storagePath &&
    existing.thumbnailPath === expected.thumbnailPath
  )
}
