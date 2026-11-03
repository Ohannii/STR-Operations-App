import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * finalizeFlagWithPhotos through the REAL server action (photo perf fix).
 * Proves: NO folder listing (the RPC's transactional exact checks are the
 * authority); ONLY the RPC's own missing-master / missing-thumbnail
 * exceptions become the friendly message, with nothing enqueued; an
 * unrelated 23514 is not mislabelled; success and replay are unchanged.
 */

const CO = '1669c464-8d26-40fc-9956-9f8955fd27c7'
const PROP = '3ed2a749-0954-4216-8095-2a1bf2af7aaa'
const FLAG = '96487471-8c6e-48bc-828e-26255ad5277d'
const PHOTO = 'a080d3ca-61b3-4dd5-9a56-87a90135761d'

let rpcResult: { data: unknown; error: unknown }
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
const storageCalls: string[] = []
const enqueue = vi.fn(async () => {})

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () =>
          table === 'flag_categories'
            ? { data: { id: 'cat-1' }, error: null }
            : { data: { id: PROP, company_id: CO }, error: null },
      }
      return q
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return rpcResult
    },
    storage: {
      from: () => {
        storageCalls.push('storage')
        return {
          list: async () => (storageCalls.push('list'), { data: [], error: null }),
          info: async () => (storageCalls.push('info'), { data: null, error: null }),
        }
      },
    },
  }),
}))
vi.mock('@/lib/integrations/outbox', () => ({
  maybeEnqueueFlagEvents: (...a: unknown[]) => enqueue(...(a as [])),
  maybeEnqueueFlagCreated: vi.fn(),
}))
vi.mock('@/lib/auth/get-user-context', () => ({
  getUserContext: async () => ({ user: { id: 'u1' }, company: { id: CO } }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

import { finalizeFlagWithPhotos } from '@/app/properties/[id]/flags/new/actions'
import { PHOTOS_NOT_UPLOADED_MESSAGE } from '@/lib/photos/finalize-helpers'

const finalize = () =>
  finalizeFlagWithPhotos({
    propertyId: PROP,
    proposedFlagId: FLAG,
    categoryKey: 'inventory_missing',
    severity: 'med',
    description: 'BETA TEST',
    photos: [{ photoId: PHOTO, width: 100, height: 100, sizeBytes: 1000 }],
  })

beforeEach(() => {
  rpcCalls.length = 0
  storageCalls.length = 0
  enqueue.mockClear()
  rpcResult = { data: 'created', error: null }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('no folder listing; the RPC is the stored-file authority', () => {
  it('success: no storage call at all, RPC once, enqueue once, unchanged result', async () => {
    expect(await finalize()).toEqual({ ok: true, flagId: FLAG, result: 'created' })
    expect(storageCalls).toEqual([])
    expect(rpcCalls.map((c) => c.fn)).toEqual(['finalize_flag_with_photos'])
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('valid replay (already_finalized): unchanged behaviour, still enqueues', async () => {
    rpcResult = { data: 'already_finalized', error: null }
    expect(await finalize()).toEqual({ ok: true, flagId: FLAG, result: 'already_finalized' })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(storageCalls).toEqual([])
  })
})

describe('missing stored file -> friendly message, nothing enqueued', () => {
  it.each(['master', 'thumbnail'])('missing %s (23514 + exact RPC message)', async (kind) => {
    rpcResult = {
      data: null,
      error: { code: '23514', message: `evidence ${kind} object missing for photo ${PHOTO}`, details: null, hint: null },
    }
    const r = await finalize()
    expect(r).toEqual({ ok: false, error: PHOTOS_NOT_UPLOADED_MESSAGE })
    expect(JSON.stringify(r)).not.toContain('evidence')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('an UNRELATED 23514 is NOT reported as a missing photo (existing behaviour)', async () => {
    rpcResult = {
      data: null,
      error: { code: '23514', message: 'new row for relation "flags" violates check constraint "flags_severity_check"' },
    }
    const r = await finalize()
    expect(r).toEqual({ ok: false, error: expect.stringContaining('Could not finalise flag') })
    expect(r).not.toEqual({ ok: false, error: PHOTOS_NOT_UPLOADED_MESSAGE })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it.each([
    ['right message, wrong code', { code: 'P0001', message: `evidence master object missing for photo ${PHOTO}` }],
    ['right code, malformed id', { code: '23514', message: 'evidence master object missing for photo not-a-uuid' }],
    ['right code, extra text', { code: '23514', message: `evidence master object missing for photo ${PHOTO} (x)` }],
  ])('%s -> not the missing-photo message', async (_l, error) => {
    rpcResult = { data: null, error }
    expect(await finalize()).not.toEqual({ ok: false, error: PHOTOS_NOT_UPLOADED_MESSAGE })
    expect(enqueue).not.toHaveBeenCalled()
  })
})
