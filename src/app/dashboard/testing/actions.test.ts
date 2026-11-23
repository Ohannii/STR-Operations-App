import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Boundary of the testing server actions: roles, validation, company from session only, no raw DB text. */

const CO = '1669c464-8d26-40fc-9956-9f8955fd27c7'
const PROP = '3ed2a749-0954-4216-8095-2a1bf2af7aaa'
let role: string | null
let company: { id: string } | null
let rpcResult: { error: unknown }
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []

vi.mock('@/lib/auth/get-user-context', () => ({
  getUserContext: async () => ({ user: { id: 'u1' }, company, membership: role ? { company_id: CO, role_key: role } : null }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: async (fn: string, args: Record<string, unknown>) => (rpcCalls.push({ fn, args }), rpcResult) }),
}))
const revalidate = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidate(...a) }))

import { endTestMode, setPropertyTestStatus, startTestMode } from './actions'

beforeEach(() => {
  role = 'ops_manager'; company = { id: CO }; rpcResult = { error: null }; rpcCalls.length = 0; revalidate.mockClear()
})

describe('startTestMode', () => {
  it('manager: calls the RPC with the session company, trimmed reason', async () => {
    expect(await startTestMode({ propertyId: PROP, minutes: 60, reason: '  Unit 13 walkthrough ' })).toEqual({ ok: true })
    expect(rpcCalls).toEqual([{ fn: 'start_test_session', args: { p_company_id: CO, p_property_id: PROP, p_minutes: 60, p_reason: 'Unit 13 walkthrough' } }])
    expect(revalidate).toHaveBeenCalled()
  })
  it.each(['inspector', 'field_lead', 'maintenance_tech', null])('%s is refused without calling the database', async (r) => {
    role = r
    expect(await startTestMode({ propertyId: PROP, minutes: 60, reason: 'Unit 13' })).toEqual({ ok: false, error: expect.stringMatching(/Only operations managers/) })
    expect(rpcCalls).toEqual([])
  })
  it.each([[PROP, 45, 'Unit 13'], [PROP, 60, 'ab'], [PROP, 0, 'Unit 13'], [PROP, 999, 'Unit 13'], ['', 60, 'Unit 13'], ['not-a-uuid', 60, 'Unit 13']])('invalid apartment/minutes/reason (%s, %s, %s) refused', async (propertyId, minutes, reason) => {
    expect(await startTestMode({ propertyId, minutes, reason })).toMatchObject({ ok: false })
    expect(rpcCalls).toEqual([])
  })
  it('a forged company id in the input is ignored', async () => {
    await startTestMode({ propertyId: PROP, minutes: 30, reason: 'Unit 13', company_id: 'b0000000-0000-4000-8000-000000000001' } as never)
    expect(rpcCalls[0].args.p_company_id).toBe(CO)
  })
  it('database errors become plain messages', async () => {
    rpcResult = { error: { code: 'PGRST202', message: 'Could not find the function public.start_test_session' } }
    const r = await startTestMode({ propertyId: PROP, minutes: 30, reason: 'Unit 13' })
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/not switched on yet/) })
    expect(JSON.stringify(r)).not.toContain('public.')
  })
  it('another apartment while one is running -> plain message', async () => {
    rpcResult = { error: { code: '55000', message: 'test mode is already on for another apartment' } }
    expect(await startTestMode({ propertyId: PROP, minutes: 30, reason: 'Unit 14' })).toEqual({ ok: false, error: expect.stringMatching(/already on for another apartment\. End it first/) })
  })
})

describe('endTestMode', () => {
  it('any member may end their own session (no role needed)', async () => {
    role = 'inspector'
    expect(await endTestMode()).toEqual({ ok: true })
    expect(rpcCalls).toEqual([{ fn: 'end_test_session', args: { p_company_id: CO } }])
  })
  it('no company -> refused', async () => {
    company = null
    expect(await endTestMode()).toMatchObject({ ok: false })
    expect(rpcCalls).toEqual([])
  })
})

describe('setPropertyTestStatus', () => {
  it('manager: company from session, property id validated', async () => {
    expect(await setPropertyTestStatus({ propertyId: PROP, isTest: true, reason: 'Training apartment' })).toEqual({ ok: true })
    expect(rpcCalls).toEqual([{ fn: 'set_property_test_status', args: { p_company_id: CO, p_property_id: PROP, p_is_test: true, p_reason: 'Training apartment' } }])
  })
  it.each([
    [{ propertyId: 'not-a-uuid', isTest: true, reason: 'Training' }],
    [{ propertyId: PROP, isTest: 'yes', reason: 'Training' }],
    [{ propertyId: PROP, isTest: true, reason: '' }],
  ])('invalid input refused', async (input) => {
    expect(await setPropertyTestStatus(input as never)).toMatchObject({ ok: false })
    expect(rpcCalls).toEqual([])
  })
  it('non-manager refused', async () => {
    role = 'inspector'
    expect(await setPropertyTestStatus({ propertyId: PROP, isTest: true, reason: 'Training' })).toMatchObject({ ok: false })
    expect(rpcCalls).toEqual([])
  })
  it('thrown client error -> generic message', async () => {
    rpcResult = { get error(): never { throw new Error('socket hang up') } } as never
    expect(await setPropertyTestStatus({ propertyId: PROP, isTest: false, reason: 'Back to normal' })).toEqual({ ok: false, error: 'Could not save. Check your connection and try again.' })
  })
})
