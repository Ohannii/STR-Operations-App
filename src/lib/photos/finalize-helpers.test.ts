import { describe, it, expect } from 'vitest'
import { isUuid, validatePhotoDescriptors } from '@/lib/photos/finalize-helpers'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

function photo(id: string) {
  return { photoId: id, width: 1600, height: 1200, sizeBytes: 400_000 }
}

describe('isUuid', () => {
  it('accepts a v4 uuid, rejects junk', () => {
    expect(isUuid(A)).toBe(true)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid(123)).toBe(false)
    expect(isUuid(null)).toBe(false)
  })
})

describe('validatePhotoDescriptors', () => {
  it('requires at least one photo', () => {
    expect(validatePhotoDescriptors([])).toEqual({
      ok: false,
      error: 'At least one photo is required.',
    })
  })

  it('rejects more than five photos', () => {
    const six = [A, B, A, B, A, B].map((_, i) =>
      photo(`3333333${i}-3333-4333-8333-333333333333`),
    )
    const res = validatePhotoDescriptors(six)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('maximum of 5')
  })

  it('rejects duplicate photo ids', () => {
    const res = validatePhotoDescriptors([photo(A), photo(A)])
    expect(res).toEqual({ ok: false, error: 'Duplicate photo id.' })
  })

  it('rejects an invalid photo id', () => {
    expect(validatePhotoDescriptors([photo('nope')])).toEqual({
      ok: false,
      error: 'Invalid photo id.',
    })
  })

  it('rejects a non-array', () => {
    expect(validatePhotoDescriptors('x' as unknown)).toEqual({
      ok: false,
      error: 'Photos must be a list.',
    })
  })

  it('accepts a valid 1..5 set', () => {
    const res = validatePhotoDescriptors([photo(A), photo(B)])
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.photos).toHaveLength(2)
      expect(res.photos[0].photoId).toBe(A)
    }
  })
})
