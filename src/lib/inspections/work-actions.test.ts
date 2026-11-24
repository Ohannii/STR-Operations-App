import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  ctx: { user: { id: 'inspector' }, company: { id: 'trusted-company' }, membership: { role_key: 'inspector' } },
  rpc: vi.fn(), client: vi.fn(), revalidate: vi.fn(),
}))
vi.mock('@/lib/auth/get-user-context', () => ({ getUserContext: async () => mocks.ctx }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
import { assignInspectors, scheduleTurnover, setReassignmentPolicy, startTurnover, updateTurnover } from '@/app/dashboard/work/actions'
const id = '10000000-0000-4000-8000-000000000001'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.ctx.membership.role_key = 'inspector'
  mocks.client.mockResolvedValue({ rpc: mocks.rpc })
  mocks.rpc.mockResolvedValue({ data: id, error: null })
})
describe('inspection server action boundary', () => {
  it('uses the signed-in company and validates the whole bulk request', async () => {
    expect(await assignInspectors([{ property_id: id, revision: 0 }], id)).toEqual({ ok: true })
    expect(mocks.rpc).toHaveBeenCalledWith('assign_primary_inspectors', { p_company: 'trusted-company', p_inspector: id, p_changes: [{ property_id: id, revision: 0 }] })
    mocks.rpc.mockClear()
    for (const bad of [[], [{ property_id: 'bad', revision: 0 }], [{ property_id: id, revision: -1 }], [{ property_id: id, revision: 0 }, { property_id: id, revision: 0 }]]) {
      expect(await assignInspectors(bad, id)).toMatchObject({ ok: false })
    }
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it.each(['finance', 'auditor', 'property_owner_viewer', 'maintenance_tech'])('rejects forged assignment by %s before database access', async role => {
    mocks.ctx.membership.role_key = role
    expect(await assignInspectors([{ property_id: id, revision: 0 }], id)).toMatchObject({ ok: false })
    expect(mocks.client).not.toHaveBeenCalled()
  })
  it('blocks inspector policy edits, schedule creation and cancellation on the server', async () => {
    expect(await setReassignmentPolicy(false, 0)).toMatchObject({ ok: false })
    expect(await scheduleTurnover({ id, propertyId: id, due: '2026-11-22', checkout: '', arrival: '' })).toMatchObject({ ok: false })
    expect(await updateTurnover(id, 0, '2026-11-22', true)).toMatchObject({ ok: false })
    expect(mocks.client).not.toHaveBeenCalled()
  })
  it('passes an actual manual schedule in UTC without any guest data', async () => {
    mocks.ctx.membership.role_key = 'ops_manager'
    expect(await scheduleTurnover({ id, propertyId: id, due: '2026-11-22', checkout: '2026-11-22T10:00', arrival: '2026-11-22T14:00' })).toEqual({ ok: true })
    expect(mocks.rpc).toHaveBeenCalledWith('schedule_turnover', {
      p_company: 'trusted-company', p_id: id, p_property: id, p_due: '2026-11-22', p_checkout: '2026-11-22T08:00:00.000Z', p_arrival: '2026-11-22T12:00:00.000Z',
    })
  })
  it('does not send bad times, dates or an arrival before checkout', async () => {
    mocks.ctx.membership.role_key = 'ops_manager'
    for (const [due, checkout, arrival] of [['2026-02-30', '', ''], ['2026-11-22', 'bad', ''], ['2026-11-22', '2026-11-22T10:00', '2026-11-22T09:00']]) {
      expect(await scheduleTurnover({ id, propertyId: id, due, checkout, arrival })).toMatchObject({ ok: false })
    }
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('surfaces a stale allocation without leaking database messages or marking it saved', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '40001', message: 'private database detail' } })
    expect(await assignInspectors([{ property_id: id, revision: 0 }], id)).toMatchObject({ ok: false, error: expect.stringContaining('another device') })
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })
  it('keeps missing migration and connection failures as honest errors', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202' } })
    expect(await startTurnover(id)).toMatchObject({ ok: false, error: expect.stringContaining('not switched on') })
    mocks.rpc.mockRejectedValueOnce(Error('offline'))
    expect(await startTurnover(id)).toMatchObject({ ok: false })
  })
  it('requires an actual pack ID before navigating', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null })
    expect(await startTurnover(id)).toMatchObject({ ok: false })
    expect(await startTurnover(id)).toEqual({ ok: true, packId: id })
  })
})
