import { describe, it, expect } from 'vitest'
import {
  pdfAttachmentName,
  photoAttachmentName,
  pdfKeyFromName,
  photoKeyFromName,
  planEvidenceUploads,
  pdfHash8,
  photoId8,
} from '@/lib/integrations/asana/attachment-names'

const HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' // 32 hex
const P1 = '11111111-2222-4333-8444-555566667777'
const P2 = '99999999-8888-4777-8666-555544443333'

describe('names + keys', () => {
  it('builds a readable PDF name carrying the hash8 suffix', () => {
    const name = pdfAttachmentName('Test 1', 'Photo test', '16-07-2026', HASH)
    expect(name).toBe('Test 1 - Photo test - 16-07-2026 - a1b2c3d4.pdf')
    expect(pdfKeyFromName(name)).toBe('a1b2c3d4')
  })

  it('builds a readable photo name carrying the photoId8 suffix', () => {
    const name = photoAttachmentName('Test 1', 'Photo test', 2, P1)
    expect(name).toBe(`Test 1 - Photo test - Photo 2 - ${photoId8(P1)}.jpg`)
    expect(photoKeyFromName(name)).toBe(photoId8(P1))
  })

  it('key extraction ignores the readable prefix and the raised date', () => {
    // A retitled flag → different prefix, same hash8 → still matches.
    expect(pdfKeyFromName('Different Unit - New Title - 01-01-2027 - a1b2c3d4.pdf')).toBe(
      'a1b2c3d4',
    )
    expect(pdfKeyFromName('random.pdf')).toBeNull()
    expect(photoKeyFromName('x - Photo 1 - deadbeef.jpg')).toBe('deadbeef')
  })

  it('pdfHash8 / photoId8 are stable prefixes', () => {
    expect(pdfHash8(HASH)).toBe('a1b2c3d4')
    expect(photoId8(P1)).toBe('11111111')
  })
})

describe('planEvidenceUploads', () => {
  const photos = [
    { photoId: P1, ordinal: 1 },
    { photoId: P2, ordinal: 2 },
  ]

  it('1-photo, empty task → upload PDF + the photo', () => {
    const plan = planEvidenceUploads({
      existingNames: [],
      contentHash: HASH,
      photos: [{ photoId: P1, ordinal: 1 }],
    })
    expect(plan.uploadPdf).toBe(true)
    expect(plan.photosToUpload.map((p) => p.photoId)).toEqual([P1])
  })

  it('5-photo, empty task → upload PDF + all five', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      photoId: `${i}0000000-0000-4000-8000-000000000000`,
      ordinal: i + 1,
    }))
    const plan = planEvidenceUploads({ existingNames: [], contentHash: HASH, photos: five })
    expect(plan.uploadPdf).toBe(true)
    expect(plan.photosToUpload).toHaveLength(5)
  })

  it('partial success → upload only the remainder', () => {
    const plan = planEvidenceUploads({
      existingNames: [
        pdfAttachmentName('Test 1', 'T', '16-07-2026', HASH),
        photoAttachmentName('Test 1', 'T', 1, P1),
      ],
      contentHash: HASH,
      photos,
    })
    expect(plan.uploadPdf).toBe(false)
    expect(plan.photosToUpload.map((p) => p.photoId)).toEqual([P2])
  })

  it('crash-retry (same list on re-run) → same remainder', () => {
    const existing = [
      pdfAttachmentName('Test 1', 'T', '16-07-2026', HASH),
      photoAttachmentName('Test 1', 'T', 1, P1),
      photoAttachmentName('Test 1', 'T', 2, P2),
    ]
    const plan = planEvidenceUploads({ existingNames: existing, contentHash: HASH, photos })
    expect(plan.uploadPdf).toBe(false)
    expect(plan.photosToUpload).toEqual([])
  })

  it('updated report → new hash uploads a new PDF, existing photos untouched', () => {
    const NEWHASH = 'ffffffff0000000011111111222222223333333344444444'
    const existing = [
      pdfAttachmentName('Test 1', 'T', '16-07-2026', HASH), // old hash
      photoAttachmentName('Test 1', 'T', 1, P1),
      photoAttachmentName('Test 1', 'T', 2, P2),
    ]
    const plan = planEvidenceUploads({ existingNames: existing, contentHash: NEWHASH, photos })
    expect(plan.uploadPdf).toBe(true) // new hash8 not present
    expect(plan.photosToUpload).toEqual([]) // both photos already there
  })

  it('a newly added photo uploads only that photo (never resends prior)', () => {
    const P3 = 'abcdef01-2222-4333-8444-555566667777'
    const existing = [
      pdfAttachmentName('Test 1', 'T', '16-07-2026', HASH),
      photoAttachmentName('Test 1', 'T', 1, P1),
      photoAttachmentName('Test 1', 'T', 2, P2),
    ]
    const plan = planEvidenceUploads({
      existingNames: existing,
      contentHash: HASH,
      photos: [...photos, { photoId: P3, ordinal: 3 }],
    })
    expect(plan.uploadPdf).toBe(false)
    expect(plan.photosToUpload.map((p) => p.photoId)).toEqual([P3])
  })
})
