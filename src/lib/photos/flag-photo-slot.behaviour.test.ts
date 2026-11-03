import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * requestFlagPhotoUploadSlot through the REAL server action (photo perf
 * fix). Only Supabase, auth, the collision guard and Next are faked.
 * Proves: two EXACT per-file checks (no folder listing), create-only links
 * ONLY for files that are definitely missing, NO links on any inconclusive
 * check, and ownership / collision failures stop before any storage call.
 */

const CO = '1669c464-8d26-40fc-9956-9f8955fd27c7'
const PROP = '3ed2a749-0954-4216-8095-2a1bf2af7aaa'
const FLAG = '96487471-8c6e-48bc-828e-26255ad5277d'
const PHOTO = 'a080d3ca-61b3-4dd5-9a56-87a90135761d'
const MASTER = `companies/${CO}/flags/${FLAG}/${PHOTO}.jpg`
const THUMB = `companies/${CO}/flags/${FLAG}/${PHOTO}_thumb.jpg`

type InfoResult = { data: unknown; error: unknown } | 'throw'
const NOT_FOUND = {
  data: null,
  error: { name: 'StorageApiError', status: 400, statusCode: '404', message: 'Object not found' },
}
const FOUND = { data: { id: 'obj', name: 'x' }, error: null }

let propertyRow: { data: unknown; error: unknown }
let collision: { ok: true } | { ok: false; error: string }
let info: Record<string, InfoResult>
const storageCalls: string[] = []

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () => (table === 'properties' ? propertyRow : { data: null, error: null }),
      }
      return q
    },
    storage: {
      from: (bucket: string) => {
        storageCalls.push(`from:${bucket}`)
        return {
          info: async (path: string) => {
            storageCalls.push(`info:${path}`)
            const r = info[path]
            if (r === 'throw') throw new TypeError('fetch failed')
            return r ?? NOT_FOUND
          },
          list: async () => {
            storageCalls.push('list')
            return { data: [], error: null }
          },
          exists: async () => {
            storageCalls.push('exists')
            return { data: false, error: null }
          },
          createSignedUploadUrl: async (path: string, opts?: unknown) => {
            storageCalls.push(`sign:${path}${opts ? ':with-options' : ''}`)
            return { data: { signedUrl: `https://signed/${path}`, token: 't' }, error: null }
          },
        }
      },
    },
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/photos/collision-check', () => ({
  checkFlagPhotoCollision: async () => collision,
}))
vi.mock('@/lib/auth/get-user-context', () => ({
  getUserContext: async () => ({ user: { id: 'u1' }, company: { id: CO } }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

import { requestFlagPhotoUploadSlot } from '@/app/properties/[id]/photos/actions'

const slot = () => requestFlagPhotoUploadSlot({ propertyId: PROP, proposedFlagId: FLAG, photoId: PHOTO })
const signs = () => storageCalls.filter((c) => c.startsWith('sign:'))

beforeEach(() => {
  storageCalls.length = 0
  propertyRow = { data: { id: PROP, company_id: CO }, error: null }
  collision = { ok: true }
  info = {}
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('exact per-file checks (no folder listing)', () => {
  it('checks EXACTLY the two server-derived paths, never lists or HEADs', async () => {
    await slot()
    expect(storageCalls.filter((c) => c.startsWith('info:')).sort()).toEqual([`info:${MASTER}`, `info:${THUMB}`].sort())
    expect(storageCalls).not.toContain('list')
    expect(storageCalls).not.toContain('exists')
  })

  it('both present -> already_uploaded, NO upload links', async () => {
    info = { [MASTER]: FOUND, [THUMB]: FOUND }
    expect(await slot()).toMatchObject({ ok: true, status: 'already_uploaded', masterPath: MASTER, thumbPath: THUMB })
    expect(signs()).toEqual([])
  })

  it('neither present -> BOTH create-only links (no upsert options)', async () => {
    const r = await slot()
    expect(r).toMatchObject({ ok: true, status: 'upload' })
    expect(signs().sort()).toEqual([`sign:${MASTER}`, `sign:${THUMB}`].sort())
  })

  it('only the master missing -> ONLY the master link', async () => {
    info = { [THUMB]: FOUND }
    const r = await slot()
    expect(r).toMatchObject({ ok: true, status: 'upload', thumbUpload: null })
    expect(signs()).toEqual([`sign:${MASTER}`])
  })

  it('only the thumbnail missing -> ONLY the thumbnail link', async () => {
    info = { [MASTER]: FOUND }
    const r = await slot()
    expect(r).toMatchObject({ ok: true, status: 'upload', masterUpload: null })
    expect(signs()).toEqual([`sign:${THUMB}`])
  })
})

describe('inconclusive checks issue NO links (fail closed)', () => {
  const err = (status: number, statusCode: string, message: string) => ({
    data: null,
    error: { name: 'StorageApiError', status, statusCode, message },
  })

  it.each<[string, InfoResult]>([
    ['401', err(401, '401', 'jwt expired')],
    ['403', err(403, '403', 'denied')],
    ['429', err(429, '429', 'Too many requests')],
    ['500', err(500, '500', 'Internal Server Error')],
    ['other 400', err(400, '400', 'Invalid key')],
    ['missing bucket', err(400, '404', 'Bucket not found')],
    ['unknown storage error', { data: null, error: { name: 'StorageUnknownError', message: 'fetch failed' } }],
    ['thrown network failure', 'throw'],
    ['no data and no error', { data: null, error: null }],
  ])('%s on the master -> ok:false, no links', async (_l, r) => {
    info = { [MASTER]: r, [THUMB]: FOUND }
    expect(await slot()).toEqual({ ok: false, error: 'Could not check existing uploads. Try again.' })
    expect(signs()).toEqual([])
  })

  it('an inconclusive THUMBNAIL check also issues no links (even if master is missing)', async () => {
    info = { [THUMB]: 'throw' }
    expect((await slot()).ok).toBe(false)
    expect(signs()).toEqual([])
  })

  it('the safe message never contains storage error text', async () => {
    info = { [MASTER]: err(500, '500', 'secret upstream detail') }
    expect(JSON.stringify(await slot())).not.toContain('secret upstream detail')
  })
})

describe('ownership and collision guards run BEFORE any storage call', () => {
  it('property in another company -> refused, no storage', async () => {
    propertyRow = { data: { id: PROP, company_id: 'other-co' }, error: null }
    expect((await slot()).ok).toBe(false)
    expect(storageCalls).toEqual([])
  })

  it('property not found -> refused, no storage', async () => {
    propertyRow = { data: null, error: null }
    expect((await slot()).ok).toBe(false)
    expect(storageCalls).toEqual([])
  })

  it('collision (existing flag/photo row) -> refused, no storage', async () => {
    collision = { ok: false, error: 'This photo id is already in use.' }
    expect(await slot()).toEqual({ ok: false, error: 'This photo id is already in use.' })
    expect(storageCalls).toEqual([])
  })

  it('invalid ids -> refused, no storage', async () => {
    expect((await requestFlagPhotoUploadSlot({ propertyId: PROP, proposedFlagId: 'x', photoId: PHOTO })).ok).toBe(false)
    expect(storageCalls).toEqual([])
  })
})
