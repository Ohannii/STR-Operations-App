/**
 * Storage path scheme for evidence photos.
 *
 * Must stay in lockstep with the storage.objects RLS policies in
 * migration 0012. Specifically, the policy extracts company_id via
 * split_part(name, '/', 2), so the second segment of every object
 * key MUST be the company_id. Changing this scheme requires a
 * matching policy update.
 */

export const EVIDENCE_BUCKET = 'evidence-photos'

type FlagContext = {
  kind: 'flag'
  companyId: string
  flagId: string
  photoId: string
}

type PropertyContext = {
  kind: 'property'
  companyId: string
  propertyId: string
  photoId: string
}

export type StorageContext = FlagContext | PropertyContext

function basePath(ctx: StorageContext): string {
  switch (ctx.kind) {
    case 'flag':
      return `companies/${ctx.companyId}/flags/${ctx.flagId}/${ctx.photoId}`
    case 'property':
      return `companies/${ctx.companyId}/property/${ctx.propertyId}/${ctx.photoId}`
  }
}

export function masterStoragePath(ctx: StorageContext): string {
  return `${basePath(ctx)}.jpg`
}

export function thumbStoragePath(ctx: StorageContext): string {
  return `${basePath(ctx)}_thumb.jpg`
}
