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
const enqueue = vi.fn(async (): Promise<{ create: string }> => ({ create: 'enqueued' }))
/** Status lookups (only made when the create job already existed). */
let statusTables: { flags: { data: unknown; error?: unknown }; integration_outbox: { data: unknown; error?: unknown } }
const statusReads: string[] = []

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        in: () => q,
        then: (resolve: (v: unknown) => void) => {
          statusReads.push(table)
          resolve(statusTables[table as 'flags' | 'integration_outbox'] ?? { data: [], error: null })
        },
        maybeSingle: async () =>
          table === 'flag_categories'
            ? { data: { id: 'cat-1' }, error: null }
            : table === 'flags'
              // the database's test classification of the new flag (normal issue)
              ? { data: { is_test: false }, error: null }
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
  statusReads.length = 0
  statusTables = { flags: { data: [] }, integration_outbox: { data: [] } }
  enqueue.mockClear()
  rpcResult = { data: 'created', error: null }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('no folder listing; the RPC is the stored-file authority', () => {
  it('success: no storage call at all, RPC once, enqueue once, unchanged result', async () => {
    expect(await finalize()).toEqual({ ok: true, flagId: FLAG, result: 'created', asanaStatus: 'queued' })
    expect(storageCalls).toEqual([])
    expect(rpcCalls.map((c) => c.fn)).toEqual(['finalize_flag_with_photos'])
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('valid replay (already_finalized): unchanged behaviour, still enqueues', async () => {
    rpcResult = { data: 'already_finalized', error: null }
    expect(await finalize()).toEqual({ ok: true, flagId: FLAG, result: 'already_finalized', asanaStatus: 'queued' })
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

describe('Report issue from a pack photo (issue mode)', () => {
  const PACK_PHOTO = 'c5b1a2e4-1f7d-4c2b-9a8e-3d6f5e4c2b1a'
  const finalizeIssue = (selections: unknown, sourcePackPhotoId = PACK_PHOTO) =>
    finalizeFlagWithPhotos({
      propertyId: PROP,
      proposedFlagId: FLAG,
      categoryKey: 'inventory_damaged',
      severity: 'med',
      description: 'Chipped bowl',
      photos: [{ photoId: PHOTO, width: 100, height: 100, sizeBytes: 1000 }],
      issue: { sourcePackPhotoId, selections },
    })

  it('uses the issue RPC with the SAME finalize args + source photo + validated selections, then enqueues', async () => {
    const r = await finalizeIssue({ category: 'inventory', incidentType: 'physical_damage', actions: ['replace', 'fix'], severity: '', fixOwner: null })
    expect(r).toEqual({ ok: true, flagId: FLAG, result: 'created', asanaStatus: 'queued' })
    expect(rpcCalls.map((c) => c.fn)).toEqual(['finalize_flag_issue_with_photos'])
    expect(rpcCalls[0].args).toMatchObject({
      p_flag_id: FLAG,
      p_property_id: PROP,
      p_category_id: 'cat-1',
      p_severity: 'med',
      p_description: 'Chipped bowl',
      p_photos: [{ photo_id: PHOTO, width: 100, height: 100, size_bytes: 1000 }],
      p_source_pack_photo_id: PACK_PHOTO,
      p_selections: { category: 'inventory', incident_type: 'physical_damage', actions: ['fix', 'replace'], severity: null, fix_owner: null },
    })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('identical retry (already_finalized) is a success, not a duplicate', async () => {
    rpcResult = { data: 'already_finalized', error: null }
    expect(await finalizeIssue({})).toMatchObject({ ok: true, result: 'already_finalized' })
  })

  it('a job inserted just now -> "queued", with no extra status reads', async () => {
    expect(await finalizeIssue({})).toMatchObject({ ok: true, asanaStatus: 'queued' })
    expect(statusReads).toEqual([])
  })

  describe.each(['disabled', 'failed'])('enqueue %s: the EXISTING task / job is read, never assumed absent', (create) => {
    const job = (status: string) => ({
      id: 'j1', entity_id: FLAG, status, created_at: '2026-11-10T00:00:00Z', deleted_at: null,
      provider: 'asana', event_type: 'asana.create_task_for_flag', entity_type: 'flag',
    })
    const run = async () => {
      enqueue.mockImplementationOnce(async () => ({ create }))
      return finalizeIssue({})
    }

    it('CONFIRMED no task link and no job -> "not_sent" (after reading both + the handoff expectation)', async () => {
      statusTables = { flags: { data: [{ id: FLAG, asana_task_url: null }] }, integration_outbox: { data: [] } }
      expect(await run()).toMatchObject({ ok: true, asanaStatus: 'not_sent' })
      // flags (link), integration_outbox (job), flags (was it expected in Asana?)
      expect([...statusReads].sort()).toEqual(['flags', 'flags', 'integration_outbox'])
    })

    it('no job yet but EXPECTED in Asana (reconciliation will send it) -> "queued", never "not_sent"', async () => {
      statusTables = {
        flags: { data: [{ id: FLAG, asana_task_url: null, asana_handoff_expected: true, created_at: new Date().toISOString() }] },
        integration_outbox: { data: [] },
      }
      expect(await run()).toMatchObject({ ok: true, asanaStatus: 'queued' })
    })

    it('REGRESSION: an existing task link -> "in_asana", never "Not sent to Asana"', async () => {
      statusTables = {
        flags: { data: [{ id: FLAG, asana_task_url: 'https://app.asana.com/0/1/9' }] },
        integration_outbox: { data: [job('done')] },
      }
      expect(await run()).toMatchObject({ ok: true, asanaStatus: 'in_asana' })
    })

    it('an existing live job -> "queued"; a stopped job -> "needs_attention"', async () => {
      statusTables = { flags: { data: [{ id: FLAG, asana_task_url: null }] }, integration_outbox: { data: [job('processing')] } }
      expect(await run()).toMatchObject({ asanaStatus: 'queued' })
      statusTables = { flags: { data: [{ id: FLAG, asana_task_url: null }] }, integration_outbox: { data: [job('dead')] } }
      expect(await run()).toMatchObject({ asanaStatus: 'needs_attention' })
    })

    it.each([
      ['outbox', { flags: { data: [{ id: FLAG, asana_task_url: null }] }, integration_outbox: { data: null, error: { code: 'XX000' } } }],
      ['flags', { flags: { data: null, error: { code: 'XX000' } }, integration_outbox: { data: [] } }],
    ])('REGRESSION: FAILED %s status lookup -> "unknown", never "not_sent"', async (_l, tables) => {
      statusTables = tables
      expect(await run()).toMatchObject({ ok: true, asanaStatus: 'unknown' })
    })
  })

  describe('the create job ALREADY existed (retry / replay): its REAL state is read', () => {
    const job = (status: string, over: Record<string, unknown> = {}) => ({
      id: 'j1', entity_id: FLAG, status, created_at: '2026-11-10T00:00:00Z', deleted_at: null,
      provider: 'asana', event_type: 'asana.create_task_for_flag', entity_type: 'flag', ...over,
    })
    const replay = async () => {
      enqueue.mockImplementationOnce(async () => ({ create: 'duplicate' }))
      rpcResult = { data: 'already_finalized', error: null }
      return finalizeIssue({})
    }

    it('DEAD duplicate job -> "needs_attention", never "Sending to Asana"', async () => {
      statusTables = { flags: { data: [{ id: FLAG, asana_task_url: null }] }, integration_outbox: { data: [job('dead')] } }
      expect(await replay()).toMatchObject({ ok: true, result: 'already_finalized', asanaStatus: 'needs_attention' })
    })

    it('COMPLETED job with a saved link -> "in_asana"', async () => {
      statusTables = {
        flags: { data: [{ id: FLAG, asana_task_url: 'https://app.asana.com/0/1/9' }] },
        integration_outbox: { data: [job('done')] },
      }
      expect(await replay()).toMatchObject({ asanaStatus: 'in_asana' })
    })

    it('still pending -> "queued"', async () => {
      statusTables = { flags: { data: [{ id: FLAG, asana_task_url: null }] }, integration_outbox: { data: [job('pending')] } }
      expect(await replay()).toMatchObject({ asanaStatus: 'queued' })
    })

    it('historical soft-deleted job + live pending job -> the live one decides', async () => {
      statusTables = {
        flags: { data: [{ id: FLAG, asana_task_url: null }] },
        integration_outbox: {
          data: [job('dead', { id: 'old', deleted_at: '2026-11-01T00:00:00Z', created_at: '2026-11-20T00:00:00Z' }), job('pending', { id: 'live' })],
        },
      }
      expect(await replay()).toMatchObject({ asanaStatus: 'queued' })
    })

    it.each([
      ['outbox', { flags: { data: [{ id: FLAG, asana_task_url: null }] }, integration_outbox: { data: null, error: { code: 'XX000' } } }],
      ['flags', { flags: { data: null, error: { code: 'XX000' } }, integration_outbox: { data: [] } }],
    ])('FAILED %s status read -> "unknown" (the issue is still saved; never "not sent")', async (_l, tables) => {
      statusTables = tables
      expect(await replay()).toMatchObject({ ok: true, asanaStatus: 'unknown' })
    })
  })

  it.each([
    ['an unknown category', { category: 'garden' }],
    ['a mismatched incident type', { category: 'linen', incidentType: 'missing_item' }],
    ['N/A with Fix', { actions: ['na', 'fix'] }],
    ['an unknown key', { priority: 'high' }],
  ])('rejects %s BEFORE any database call', async (_l, selections) => {
    const r = await finalizeIssue(selections)
    expect(r.ok).toBe(false)
    expect(rpcCalls).toEqual([])
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('rejects a malformed source photo id before any database call', async () => {
    expect((await finalizeIssue({}, 'not-a-uuid')).ok).toBe(false)
    expect(rpcCalls).toEqual([])
  })

  it.each([
    [{ code: 'PGRST202', message: 'Could not find the function' }, /not switched on yet/],
    [{ code: '23505', message: `issue ${FLAG} already exists with different selections` }, /different details/],
    [{ code: 'P0002', message: `source pack photo ${PACK_PHOTO} not found` }, /could not be found/],
    [{ code: '23514', message: `evidence master object missing for photo ${PHOTO}` }, /./],
    [{ code: 'XX000', message: 'internal: relation "secret_table" exploded' }, /^Could not save the issue\. Try again\.$/],
  ])('refusal %o -> safe message, nothing enqueued, no raw DB text', async (error, expected) => {
    rpcResult = { data: null, error }
    const r = await finalizeIssue({})
    expect(r.ok).toBe(false)
    const msg = (r as { error: string }).error
    expect(msg).toMatch(expected)
    expect(msg).not.toContain(error.message)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('normal flags (no issue) still use the original RPC unchanged', async () => {
    await finalize()
    expect(rpcCalls.map((c) => c.fn)).toEqual(['finalize_flag_with_photos'])
    expect(rpcCalls[0].args).not.toHaveProperty('p_selections')
  })
})

describe('CONTROLLED LIVE TEST: the destination is chosen once, at enqueue', () => {
  // CO and PROP in this file ARE the live-test company and "Test 1" property.
  const PACK_PHOTO = 'c5b1a2e4-1f7d-4c2b-9a8e-3d6f5e4c2b1a'
  const issue = (propertyId = PROP) =>
    finalizeFlagWithPhotos({
      propertyId,
      proposedFlagId: FLAG,
      categoryKey: 'inventory_damaged',
      severity: 'med',
      description: 'LIVE TEST',
      photos: [{ photoId: PHOTO, width: 100, height: 100, sizeBytes: 1000 }],
      issue: { sourcePackPhotoId: PACK_PHOTO, selections: { category: 'inventory' } },
    })
  const destinationArg = () => (enqueue.mock.calls[0] as unknown as unknown[])[2]

  it('switch OFF: a pack-photo issue on Test 1 still goes to BETA', async () => {
    await issue()
    expect(destinationArg()).toBe('beta')
  })

  it('switch ON: a NEW pack-photo issue on Test 1 is pinned to live', async () => {
    vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', 'true')
    expect(await issue()).toMatchObject({ ok: true, asanaStatus: 'queued' })
    expect(destinationArg()).toBe('live_incidents')
    expect(enqueue).toHaveBeenCalledTimes(1)
    vi.unstubAllEnvs()
  })

  it('switch ON: an ORDINARY flag on Test 1 keeps BETA', async () => {
    vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', 'true')
    await finalize()
    expect(destinationArg()).toBe('beta')
    vi.unstubAllEnvs()
  })

  it('switch ON: the destination uses the SERVER-verified company, never a client value', async () => {
    vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', 'true')
    await issue()
    expect((enqueue.mock.calls[0] as unknown as [unknown, { companyId: string }])[1].companyId).toBe(CO)
    vi.unstubAllEnvs()
  })
})
