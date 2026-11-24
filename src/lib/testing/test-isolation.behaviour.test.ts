import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Test-activity isolation through the REAL server actions (both creation
 * paths). With staff-wide live rollout ON, a flag the database stamped as a
 * test issue must enqueue to BETA, a normal flag must still go live, and an
 * UNKNOWN classification must enqueue nothing (no guessed destination)
 * while the issue is still saved and shown as on its way to Asana (the
 * worker's reconciliation sends it).
 */

const CO = '1669c464-8d26-40fc-9956-9f8955fd27c7'
const PROP = '3ed2a749-0954-4216-8095-2a1bf2af7aaa'
const FLAG = '96487471-8c6e-48bc-828e-26255ad5277d'
const PHOTO = 'a080d3ca-61b3-4dd5-9a56-87a90135761d'

let stamped: { data: unknown; error: unknown } | 'throw'
/** Status reads of the flag after a deferred enqueue (link + handoff expectation). */
let statusFlags: { data: unknown; error: unknown }
const flagSelects: string[] = []
const insertedRows: Array<Record<string, unknown>> = []
const enqueueEvents = vi.fn<(...a: unknown[]) => Promise<{ create: string }>>(async () => ({ create: 'enqueued' }))
const enqueueBeta = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true)

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      let cols = ''
      const q = {
        select: (c: string) => { cols = c; if (table === 'flags') flagSelects.push(c); return q },
        insert: (row: Record<string, unknown>) => { insertedRows.push(row); return q },
        single: async () => ({ data: { id: FLAG }, error: null }),
        eq: () => q,
        is: () => q,
        in: () => q,
        then: (resolve: (v: unknown) => void) => resolve(
          table === 'flags' ? statusFlags : { data: [], error: null },
        ),
        maybeSingle: async () => {
          if (table === 'flags' && cols === 'is_test') {
            if (stamped === 'throw') throw new Error('network')
            return stamped
          }
          if (table === 'flag_categories') return { data: { id: 'cat-1' }, error: null }
          return { data: { id: PROP, company_id: CO }, error: null }
        },
      }
      return q
    },
    rpc: async () => ({ data: 'created', error: null }),
  }),
}))
vi.mock('@/lib/integrations/outbox', () => ({
  maybeEnqueueFlagEvents: (...a: unknown[]) => enqueueEvents(...a),
  maybeEnqueueFlagCreated: (...a: unknown[]) => enqueueBeta(...a),
}))
vi.mock('@/lib/auth/get-user-context', () => ({
  getUserContext: async () => ({ user: { id: 'u1' }, company: { id: CO } }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
const redirect = vi.fn((url: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { url }) })
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))

import { createFlagAction, finalizeFlagWithPhotos } from '@/app/properties/[id]/flags/new/actions'

const finalize = () => finalizeFlagWithPhotos({
  propertyId: PROP, proposedFlagId: FLAG, categoryKey: 'inventory_missing', severity: 'med',
  description: 'Unit 13 test', photos: [{ photoId: PHOTO, width: 100, height: 100, sizeBytes: 1000 }],
})
async function submitForm(extra: Record<string, string> = {}) {
  const fd = new FormData()
  for (const [k, v] of Object.entries({ property_id: PROP, category_key: 'maintenance', severity: 'med', description: 'Unit 13 test', ...extra })) fd.set(k, v)
  await expect(createFlagAction(fd)).rejects.toThrow('NEXT_REDIRECT')
}

beforeEach(() => {
  vi.stubEnv('ASANA_LIVE_INCIDENTS_ENABLED', 'true')
  vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', '')
  stamped = { data: { is_test: false }, error: null }
  statusFlags = { data: [{ id: FLAG, asana_task_url: null, asana_handoff_expected: true, created_at: new Date().toISOString() }], error: null }
  flagSelects.length = 0
  insertedRows.length = 0
  enqueueEvents.mockClear()
  enqueueBeta.mockClear()
  redirect.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.unstubAllEnvs())

describe('finalize path (photo issue / pack-photo issue)', () => {
  it('normal issue with rollout on still goes to live intake (control)', async () => {
    expect(await finalize()).toMatchObject({ ok: true })
    expect(enqueueEvents).toHaveBeenCalledTimes(1)
    expect(enqueueEvents.mock.calls[0][2]).toBe('live_incidents')
  })
  it('database-stamped test issue goes to BETA', async () => {
    stamped = { data: { is_test: true }, error: null }
    expect(await finalize()).toMatchObject({ ok: true })
    expect(enqueueEvents.mock.calls[0][2]).toBe('beta')
    expect(flagSelects).toContain('is_test')
  })
  it.each([
    ['database error', { data: null, error: { code: 'XX000' } }],
    ['statement timeout', { data: null, error: { code: '57014' } }],
    ['lost response (network)', 'throw' as const],
    ['empty answer', { data: null, error: null }],
  ])('%s on the classification read: issue saved, NOTHING enqueued, shown as on its way', async (_l, s) => {
    stamped = s
    expect(await finalize()).toEqual({ ok: true, flagId: FLAG, result: 'created', asanaStatus: 'queued' })
    expect(enqueueEvents).not.toHaveBeenCalled()
  })
  it('unknown classification, but status read also fails -> "unknown" (polled), never "not sent"', async () => {
    stamped = 'throw'
    statusFlags = { data: null, error: { code: 'XX000' } }
    expect(await finalize()).toMatchObject({ ok: true, asanaStatus: 'unknown' })
    expect(enqueueEvents).not.toHaveBeenCalled()
  })
  it('Asana switched off for the company: deferred issue is honestly "not sent"', async () => {
    stamped = 'throw'
    statusFlags = { data: [{ id: FLAG, asana_task_url: null, asana_handoff_expected: false, created_at: new Date().toISOString() }], error: null }
    expect(await finalize()).toMatchObject({ ok: true, asanaStatus: 'not_sent' })
  })
  it('column missing (migration not applied yet): pre-migration behaviour, still enqueued', async () => {
    stamped = { data: null, error: { code: '42703' } }
    expect(await finalize()).toMatchObject({ ok: true })
    expect(enqueueEvents.mock.calls[0][2]).toBe('live_incidents')
  })
  it('retry after a lost response (already_finalized) re-reads and enqueues idempotently', async () => {
    stamped = { data: { is_test: true }, error: null }
    expect(await finalize()).toMatchObject({ ok: true })
    expect(await finalize()).toMatchObject({ ok: true })
    expect(enqueueEvents.mock.calls.map((c) => c[2])).toEqual(['beta', 'beta'])
  })
})

describe('form path (issue without photos)', () => {
  it('normal issue goes live; the client never sends is_test', async () => {
    await submitForm({ is_test: 'false', test_reason: 'test_session' })
    expect(enqueueEvents.mock.calls[0][2]).toBe('live_incidents')
    expect(enqueueBeta).not.toHaveBeenCalled()
    expect(insertedRows[0]).not.toHaveProperty('is_test')
    expect(insertedRows[0]).not.toHaveProperty('test_reason')
    expect(redirect).toHaveBeenLastCalledWith(`/properties/${PROP}?raised=1`)
  })
  it('database-stamped test issue goes to BETA', async () => {
    stamped = { data: { is_test: true }, error: null }
    await submitForm()
    expect(enqueueEvents).not.toHaveBeenCalled()
    expect(enqueueBeta).toHaveBeenCalledTimes(1)
    expect(redirect).toHaveBeenLastCalledWith(`/properties/${PROP}?raised=1`)
  })
  it('insert RETURNING asks only for id, so creation works before the migration', async () => {
    stamped = { data: null, error: { code: '42703' } }
    await submitForm()
    expect(flagSelects[0]).toBe('id')
    expect(enqueueEvents).toHaveBeenCalledTimes(1)
    expect(redirect).toHaveBeenLastCalledWith(`/properties/${PROP}?raised=1`)
  })
  it.each([['database error', { data: null, error: { code: 'XX000' } }], ['lost response', 'throw' as const]])(
    'unknown classification (%s): issue saved and user redirected as normal; nothing guessed or enqueued',
    async (_l, s) => {
      stamped = s
      await submitForm()
      expect(insertedRows).toHaveLength(1)
      expect(enqueueEvents).not.toHaveBeenCalled()
      expect(enqueueBeta).not.toHaveBeenCalled()
      expect(redirect).toHaveBeenLastCalledWith(`/properties/${PROP}?raised=1`)
    },
  )
})
