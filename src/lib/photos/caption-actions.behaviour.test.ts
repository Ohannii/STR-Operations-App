import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Through the REAL server actions (rev 4). Only the Supabase client, auth
 * context and Next cache are faked; the action code runs as shipped. Proves:
 *   - null / unknown RPC results are never success (fail closed);
 *   - the autosave compare-and-set expectation is MANDATORY (no bypass);
 *   - a caption_conflict is shown as resolvable ONLY with proven details —
 *     read errors, missing/duplicate/unexpected rows and undetectable
 *     differences all become a safe generic reload failure;
 *   - legacy whitespace never fabricates an empty conflict list.
 */

type Read<T> = { data: T; error: unknown }
let rpcResult: { data: unknown; error: unknown } = { data: null, error: null }
let photosRead: Read<Array<{ id: string; notes: string | null }> | null>
let packStateRead: Read<{ id: string; status: string } | null>
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []

function builder(table: string) {
  let selected = ''
  const self = {
    select: (cols: string) => {
      selected = cols
      return self
    },
    eq: () => self,
    is: () => self,
    in: () => self,
    maybeSingle: async () => {
      if (table === 'evidence_packs' && selected.includes('property_id')) {
        return { data: { id: 'pack-1', property_id: 'prop-1' }, error: null } // ownership pre-check
      }
      if (table === 'evidence_packs') return packStateRead
      return { data: { notes: 'server now' }, error: null } // stale re-read
    },
    returns: async () => photosRead,
  }
  return self
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return rpcResult
    },
    from: (table: string) => builder(table),
  }),
}))
vi.mock('@/lib/auth/get-user-context', () => ({
  getUserContext: async () => ({ user: { id: 'u1' }, company: { id: 'co1' } }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('redirect must not be called by the typed caption actions')
  }),
}))

import {
  saveDraftPhotoCaptionAction,
  submitPackWithCaptionsAction,
} from '@/app/properties/[id]/packs/actions'
import { CONFLICT_UNPROVEN_MESSAGE } from '@/lib/photos/caption-outcomes'

beforeEach(() => {
  rpcCalls.length = 0
  rpcResult = { data: null, error: null }
  photosRead = { data: [{ id: 'ph-1', notes: 'server now' }], error: null }
  packStateRead = { data: { id: 'pack-1', status: 'draft' }, error: null }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const save = () =>
  saveDraftPhotoCaptionAction({ photoId: 'ph-1', note: 'caption', expectedNotes: '' })

const submit = (captions = [{ photoId: 'ph-1', note: 'caption', expected: '' }]) =>
  submitPackWithCaptionsAction({ propertyId: 'prop-1', packId: 'pack-1', captions })

describe('saveDraftPhotoCaptionAction — fail closed, CAS mandatory', () => {
  it.each([null, undefined, 'ok', 'SAVED', 42, {}])('RPC value %j is a FAILURE', async (v) => {
    rpcResult = { data: v, error: null }
    expect((await save()).ok).toBe(false)
  })

  it("'saved' and 'unchanged' are the only successes", async () => {
    rpcResult = { data: 'saved', error: null }
    expect(await save()).toEqual({ ok: true, code: 'saved' })
    rpcResult = { data: 'unchanged', error: null }
    expect(await save()).toEqual({ ok: true, code: 'unchanged' })
  })

  it("'stale' is a typed conflict carrying the server's current caption", async () => {
    rpcResult = { data: 'stale', error: null }
    expect(await save()).toMatchObject({ ok: false, code: 'stale', serverNotes: 'server now' })
  })

  it('the RPC receives exactly (photo, note, expected) — no bypass flag exists', async () => {
    rpcResult = { data: 'saved', error: null }
    await save()
    expect(rpcCalls[0]).toEqual({
      fn: 'set_prearrival_photo_caption',
      args: { p_photo_id: 'ph-1', p_note: 'caption', p_expected_notes: '' },
    })
  })

  it.each([
    ['omitted', { photoId: 'ph-1', note: 'blind overwrite' }],
    ['null', { photoId: 'ph-1', note: 'blind overwrite', expectedNotes: null }],
    ['a boolean', { photoId: 'ph-1', note: 'blind overwrite', expectedNotes: false }],
    ['with a legacy "known=false" flag', { photoId: 'ph-1', note: 'x', expectedKnown: false }],
  ])('an expectation that is %s cannot write — rejected before any RPC', async (_label, input) => {
    rpcResult = { data: 'saved', error: null }
    const res = await saveDraftPhotoCaptionAction(
      input as unknown as Parameters<typeof saveDraftPhotoCaptionAction>[0],
    )
    expect(res.ok).toBe(false)
    expect(rpcCalls.length).toBe(0)
  })
})

describe('submitPackWithCaptionsAction — fail closed', () => {
  it.each([null, undefined, 'saved', 'Submitted', 'draft', 0, {}])(
    'RPC value %j is a FAILURE (never "submitted")',
    async (v) => {
      rpcResult = { data: v, error: null }
      expect((await submit()).ok).toBe(false)
    },
  )

  it("'submitted' / 'already_submitted' are the only successes", async () => {
    rpcResult = { data: 'submitted', error: null }
    expect(await submit()).toEqual({ ok: true, code: 'submitted' })
    rpcResult = { data: 'already_submitted', error: null }
    expect(await submit()).toEqual({ ok: true, code: 'already_submitted' })
  })

  it('the manifest sent to the RPC carries each baseline as expected_note', async () => {
    rpcResult = { data: 'submitted', error: null }
    await submit()
    expect(rpcCalls[0]).toEqual({
      fn: 'submit_prearrival_pack_with_captions',
      args: {
        p_pack_id: 'pack-1',
        p_captions: [{ photo_id: 'ph-1', note: 'caption', expected_note: '' }],
      },
    })
  })

  it('a manifest entry without a baseline is rejected before any RPC', async () => {
    rpcResult = { data: 'submitted', error: null }
    const res = await submit([{ photoId: 'ph-1', note: 'caption' } as unknown as {
      photoId: string
      note: string
      expected: string
    }])
    expect(res.ok).toBe(false)
    expect(rpcCalls.length).toBe(0)
  })
})

describe('BLOCKER 2 (rev 4) — conflict details must be PROVEN', () => {
  beforeEach(() => {
    rpcResult = { data: 'caption_conflict', error: null }
  })

  it('proven draft conflict names the photo whose server caption moved', async () => {
    expect(await submit()).toMatchObject({
      ok: false,
      code: 'caption_conflict',
      packSubmitted: false,
      conflicts: [{ photoId: 'ph-1', serverNotes: 'server now' }],
    })
  })

  it('photo re-read ERROR => generic reload failure, NOT the resolvable-conflict UI', async () => {
    photosRead = { data: null, error: { message: 'permission denied' } }
    const res = await submit()
    expect(res).toEqual({ ok: false, error: CONFLICT_UNPROVEN_MESSAGE })
    expect('code' in res && res.code).toBeFalsy()
  })

  it('pack re-read ERROR => generic reload failure', async () => {
    packStateRead = { data: null, error: { message: 'timeout' } }
    expect(await submit()).toEqual({ ok: false, error: CONFLICT_UNPROVEN_MESSAGE })
  })

  it('a MISSING photo row never becomes a blank server caption', async () => {
    photosRead = { data: [], error: null }
    expect(await submit()).toEqual({ ok: false, error: CONFLICT_UNPROVEN_MESSAGE })
  })

  it('duplicate or unexpected rows are not trusted', async () => {
    photosRead = {
      data: [
        { id: 'ph-1', notes: 'a' },
        { id: 'ph-1', notes: 'b' },
      ],
      error: null,
    }
    expect(await submit()).toEqual({ ok: false, error: CONFLICT_UNPROVEN_MESSAGE })
    photosRead = {
      data: [
        { id: 'ph-1', notes: 'a' },
        { id: 'ph-other', notes: 'b' },
      ],
      error: null,
    }
    expect(await submit()).toEqual({ ok: false, error: CONFLICT_UNPROVEN_MESSAGE })
  })

  it('submitted elsewhere is proven from the pack state alone', async () => {
    packStateRead = { data: { id: 'pack-1', status: 'submitted' }, error: null }
    expect(await submit()).toMatchObject({
      ok: false,
      code: 'caption_conflict',
      packSubmitted: true,
      conflicts: [],
    })
  })

  it('BLOCKER 5: LEGACY WHITESPACE never yields an empty resolvable-conflict list', async () => {
    // Stored legacy value differs only by edge whitespace from the baseline.
    photosRead = { data: [{ id: 'ph-1', notes: '  Legacy caption \n' }], error: null }
    const res = await submit([{ photoId: 'ph-1', note: 'Legacy caption', expected: 'Legacy caption' }])
    // Canonically equal => no locatable difference => generic reload, never
    // "choose a version" with nothing highlighted.
    expect(res).toEqual({ ok: false, error: CONFLICT_UNPROVEN_MESSAGE })
  })
})
