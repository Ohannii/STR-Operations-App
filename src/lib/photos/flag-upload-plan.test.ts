import { describe, it, expect, vi } from 'vitest'
import {
  planFlagPhotoUpload,
  buildFlagPhotoSlot,
  type CreateOnlySigner,
} from '@/lib/photos/flag-upload-plan'

const BASE = {
  photoId: 'photo-1',
  companyId: 'co-1',
  masterPath: 'companies/co-1/flags/flag-1/photo-1.jpg',
  thumbPath: 'companies/co-1/flags/flag-1/photo-1_thumb.jpg',
}

// A signer that records the paths it was asked to sign. Note its type is
// (path: string) => ... — no upsert parameter exists, so create-only is
// structurally guaranteed.
function recordingSigner(): { sign: CreateOnlySigner; paths: string[] } {
  const paths: string[] = []
  const sign: CreateOnlySigner = async (path: string) => {
    paths.push(path)
    return { signedUrl: `https://x/${path}`, token: `tok-${path}` }
  }
  return { sign, paths }
}

describe('planFlagPhotoUpload', () => {
  it('both objects missing → upload both', () => {
    expect(planFlagPhotoUpload({ masterExists: false, thumbExists: false })).toEqual({
      status: 'upload',
      needMaster: true,
      needThumb: true,
    })
  })

  it('only master missing → upload master only', () => {
    expect(planFlagPhotoUpload({ masterExists: false, thumbExists: true })).toEqual({
      status: 'upload',
      needMaster: true,
      needThumb: false,
    })
  })

  it('only thumbnail missing → upload thumb only', () => {
    expect(planFlagPhotoUpload({ masterExists: true, thumbExists: false })).toEqual({
      status: 'upload',
      needMaster: false,
      needThumb: true,
    })
  })

  it('both objects present → already_uploaded', () => {
    expect(planFlagPhotoUpload({ masterExists: true, thumbExists: true })).toEqual({
      status: 'already_uploaded',
    })
  })
})

describe('buildFlagPhotoSlot', () => {
  it('signs both when both objects are missing (create-only)', async () => {
    const { sign, paths } = recordingSigner()
    const res = await buildFlagPhotoSlot(
      { ...BASE, masterExists: false, thumbExists: false },
      sign,
    )
    expect(res.ok).toBe(true)
    if (res.ok && res.status === 'upload') {
      expect(res.masterUpload).not.toBeNull()
      expect(res.thumbUpload).not.toBeNull()
    }
    expect(paths).toEqual([BASE.masterPath, BASE.thumbPath])
  })

  it('signs only the thumbnail when the master already exists', async () => {
    const { sign, paths } = recordingSigner()
    const res = await buildFlagPhotoSlot(
      { ...BASE, masterExists: true, thumbExists: false },
      sign,
    )
    expect(res.ok).toBe(true)
    if (res.ok && res.status === 'upload') {
      expect(res.masterUpload).toBeNull()
      expect(res.thumbUpload).not.toBeNull()
    }
    expect(paths).toEqual([BASE.thumbPath])
  })

  it('signs only the master when the thumbnail already exists', async () => {
    const { sign, paths } = recordingSigner()
    const res = await buildFlagPhotoSlot(
      { ...BASE, masterExists: false, thumbExists: true },
      sign,
    )
    expect(res.ok).toBe(true)
    if (res.ok && res.status === 'upload') {
      expect(res.masterUpload).not.toBeNull()
      expect(res.thumbUpload).toBeNull()
    }
    expect(paths).toEqual([BASE.masterPath])
  })

  it('returns already_uploaded with NO overwrite URLs when both exist', async () => {
    // No parameter: TypeScript allows a narrower callback, and this test
    // asserts the signer is never called anyway.
    const sign = vi.fn(async () => ({ signedUrl: 'x', token: 'y' }))
    const res = await buildFlagPhotoSlot(
      { ...BASE, masterExists: true, thumbExists: true },
      sign,
    )
    expect(res).toEqual({ ok: true, status: 'already_uploaded', ...BASE })
    expect(sign).not.toHaveBeenCalled() // never issues an overwrite URL
    // No masterUpload/thumbUpload fields exist on the already_uploaded shape.
    expect(res).not.toHaveProperty('masterUpload')
    expect(res).not.toHaveProperty('thumbUpload')
  })

  it('propagates a signer failure as an error result', async () => {
    const sign: CreateOnlySigner = async () => null
    const res = await buildFlagPhotoSlot(
      { ...BASE, masterExists: false, thumbExists: false },
      sign,
    )
    expect(res.ok).toBe(false)
  })
})
