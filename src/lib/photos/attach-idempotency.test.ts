import { describe, it, expect } from 'vitest'
import {
  photoIdentityMatches,
  type ExistingPhotoIdentity,
  type ExpectedPhotoIdentity,
} from '@/lib/photos/attach-idempotency'

const expected: ExpectedPhotoIdentity = {
  companyId: 'co1',
  propertyId: 'p1',
  flagId: null,
  evidencePackId: 'pack1',
  storagePath: 'companies/co1/props/p1/photo1.jpg',
  thumbnailPath: 'companies/co1/props/p1/photo1_thumb.jpg',
}

function existing(o: Partial<ExistingPhotoIdentity> = {}): ExistingPhotoIdentity {
  return { ...expected, deletedAt: null, ...o }
}

describe('photoIdentityMatches', () => {
  it('true only when every identity field matches and not deleted', () => {
    expect(photoIdentityMatches(existing(), expected)).toBe(true)
  })

  it('fails closed on a different pack', () => {
    expect(photoIdentityMatches(existing({ evidencePackId: 'other' }), expected)).toBe(false)
  })

  it('fails closed on a different company / property', () => {
    expect(photoIdentityMatches(existing({ companyId: 'evil' }), expected)).toBe(false)
    expect(photoIdentityMatches(existing({ propertyId: 'p2' }), expected)).toBe(false)
  })

  it('fails closed on different storage paths', () => {
    expect(photoIdentityMatches(existing({ storagePath: 'x' }), expected)).toBe(false)
    expect(photoIdentityMatches(existing({ thumbnailPath: 'x' }), expected)).toBe(false)
  })

  it('fails closed on a soft-deleted existing row', () => {
    expect(photoIdentityMatches(existing({ deletedAt: '2026-01-01' }), expected)).toBe(false)
  })

  it('treats null vs undefined flag/pack consistently', () => {
    expect(
      photoIdentityMatches(existing({ flagId: null }), { ...expected, flagId: null }),
    ).toBe(true)
  })
})
