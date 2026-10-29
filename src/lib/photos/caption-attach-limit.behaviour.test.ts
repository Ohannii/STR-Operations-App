import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ITEM 1 (rev 5) — through the REAL photo attach server actions: a caption
 * over 2,000 characters is REFUSED (never `trim().slice(0, 2000)`), and the
 * one canonical rule is what reaches the database. Only Supabase, auth and
 * Next are faked.
 */

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return { data: 'completed', error: null }
    },
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/auth/get-user-context', () => ({
  getUserContext: async () => ({ user: { id: 'u1' }, company: { id: 'co1' } }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

import {
  attachEvidencePhoto,
  attachEvidencePhotosBatch,
} from '@/app/properties/[id]/photos/actions'
import { CAPTION_TOO_LONG_MESSAGE } from '@/lib/photos/caption-canonical'

const PHOTO_A = '11111111-1111-4111-8111-111111111111'
const PHOTO_B = '22222222-2222-4222-8222-222222222222'

const item = (photoId: string, note: string | null) =>
  ({
    photoId,
    propertyId: 'prop-1',
    evidencePackId: 'pack-1',
    flagId: null,
    masterPath: 'm.jpg',
    thumbPath: 't.jpg',
    width: 10,
    height: 10,
    sizeBytes: 100,
    capturedAt: null,
    note,
    retentionClass: 'routine_pre_arrival',
  }) as unknown as Parameters<typeof attachEvidencePhoto>[0]

beforeEach(() => {
  rpcCalls.length = 0
})

describe('attachEvidencePhotosBatch', () => {
  it('2,001 chars: THAT item is refused (no RPC); the 2,000-char item attaches in FULL', async () => {
    const res = await attachEvidencePhotosBatch([
      item(PHOTO_A, 'x'.repeat(2001)),
      item(PHOTO_B, 'y'.repeat(2000)),
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.results.find((r) => r.photoId === PHOTO_A)).toMatchObject({
      ok: false,
      error: CAPTION_TOO_LONG_MESSAGE,
    })
    expect(res.results.find((r) => r.photoId === PHOTO_B)?.ok).toBe(true)
    expect(rpcCalls.map((c) => c.args.p_photo_id)).toEqual([PHOTO_B])
    expect(rpcCalls[0].args.p_note).toBe('y'.repeat(2000)) // never shortened
  })

  it('2,001 whitespace characters are refused (raw length)', async () => {
    const res = await attachEvidencePhotosBatch([item(PHOTO_A, ' '.repeat(2001))])
    expect(res.ok && res.results[0].ok).toBe(false)
    expect(rpcCalls.length).toBe(0)
  })

  it('the canonical rule reaches the database (ASCII trim, NBSP kept)', async () => {
    await attachEvidencePhotosBatch([item(PHOTO_A, '  padded \n'), item(PHOTO_B, ' nbsp ')])
    const notes = Object.fromEntries(rpcCalls.map((c) => [c.args.p_photo_id, c.args.p_note]))
    expect(notes[PHOTO_A]).toBe('padded')
    expect(notes[PHOTO_B]).toBe(' nbsp ')
  })
})

describe('attachEvidencePhoto (single)', () => {
  it('2,001 chars is refused before any RPC', async () => {
    const res = await attachEvidencePhoto(item(PHOTO_A, 'x'.repeat(2001)))
    expect(res).toEqual({ ok: false, error: CAPTION_TOO_LONG_MESSAGE })
    expect(rpcCalls.length).toBe(0)
  })

  it('exactly 2,000 chars attaches with the full caption', async () => {
    const res = await attachEvidencePhoto(item(PHOTO_A, 'z'.repeat(2000)))
    expect(res).toEqual({ ok: true, photoId: PHOTO_A })
    expect(rpcCalls[0].args.p_note).toBe('z'.repeat(2000))
  })
})
