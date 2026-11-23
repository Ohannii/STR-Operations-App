import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const mock = vi.hoisted(() => ({ ctx: vi.fn(), client: vi.fn(), service: vi.fn(), rpc: vi.fn(), exchange: vi.fn(), listings: vi.fn(), units: vi.fn(), refresh: vi.fn() }))
vi.mock('@/lib/auth/get-user-context', () => ({ getUserContext: mock.ctx }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mock.client }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: mock.service }))
vi.mock('next/cache', () => ({ revalidatePath: mock.refresh }))
vi.mock('./hostaway', async original => ({ ...await original<typeof import('./hostaway')>(), exchangeHostawayCredentials: mock.exchange, readHostawayListings: mock.listings, readHostawayUnits: mock.units }))
import { connectHostaway, disconnectHostaway, loadHostawayListings, loadHostawayUnits, saveHostawayMapping } from '@/app/dashboard/settings/pms/actions'
import { HostawayError } from './hostaway'
import { pmsFailure, PmsSetupError } from './setup-server'

const CO = '10000000-0000-4000-8000-000000000001', ACTOR = '20000000-0000-4000-8000-000000000001'
const C = '30000000-0000-4000-8000-000000000001', BL = '40000000-0000-4000-8000-000000000001', BV = '40000000-0000-4000-8000-000000000002'
const TOKEN = 'synthetic-token-never-client-visible', KEY = 'synthetic-client-secret'
const connection = { id: C, provider: 'hostaway', account_id: '123', status: 'connected', revision: 2, credential_expires_at: '2099-01-01T00:00:00Z' }
let tables: Record<string, { data: unknown; error?: { code: string } }>, reads: string[]
const fields: Array<[string, string]> = [], filters: Array<[string, string, unknown]> = []
function from(table: string) {
  reads.push(table)
  const result = tables[table] ?? { data: null, error: { code: 'unexpected' } }
  const q = {
    select: (columns: string) => { fields.push([table, columns]); return q },
    eq: (column: string, value: unknown) => { filters.push([table, column, value]); return q },
    is: () => q, order: () => q, maybeSingle: () => Promise.resolve(result),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  }
  return q
}
const mappingInput = { listingId: '91', unitId: '0', propertyId: BL, connectionRevision: 2, mappingRevision: 0, physicalListingConfirmed: true }
beforeEach(() => {
  vi.clearAllMocks(); reads = []; fields.length = 0; filters.length = 0
  mock.ctx.mockResolvedValue({ user: { id: ACTOR }, company: { id: CO }, membership: { company_id: CO, role_key: 'company_admin' } })
  tables = { pms_connections: { data: connection }, properties: { data: [{ id: BL, name: 'Unit 91', address: 'Ballito Life', unit_reference: null }, { id: BV, name: 'Unit 91', address: 'Ballito Village', unit_reference: null }] }, pms_listing_mappings: { data: [] } }
  mock.client.mockResolvedValue({ from })
  mock.service.mockReturnValue({ rpc: mock.rpc })
  mock.rpc.mockImplementation(async name => ({ data: name === 'read_hostaway_setup_token' ? TOKEN : C, error: null }))
  mock.exchange.mockResolvedValue({ token: TOKEN, expiresAt: '2028-01-01T00:00:00Z' })
  mock.listings.mockResolvedValue([{ id: '91', name: 'Verified provider name', timeZone: 'Africa/Johannesburg' }])
  mock.units.mockResolvedValue([])
})
describe('PMS server actions and credential boundary', () => {
  const operations = [
    () => connectHostaway({ accountId: '123', apiKey: KEY, revision: 2 }),
    () => loadHostawayListings(2), () => loadHostawayUnits({ listingId: '91', revision: 2 }),
    () => saveHostawayMapping(mappingInput), () => disconnectHostaway(2),
  ]
  it.each(operations.map((run, i) => ({ run, i })))('operation $i refuses non-admin callers before provider or service access', async ({ run }) => {
    mock.ctx.mockResolvedValue({ user: { id: ACTOR }, company: { id: CO }, membership: { company_id: CO, role_key: 'inspector' } })
    expect(await run()).toMatchObject({ ok: false, code: 'not_authorized' })
    expect(mock.service).not.toHaveBeenCalled(); expect(mock.exchange).not.toHaveBeenCalled(); expect(mock.listings).not.toHaveBeenCalled(); expect(mock.client).not.toHaveBeenCalled()
  })
  it('refuses absent sessions and a mismatched company context', async () => {
    mock.ctx.mockResolvedValueOnce(null)
    expect(await loadHostawayListings(2)).toMatchObject({ ok: false, code: 'not_authorized' })
    mock.ctx.mockResolvedValueOnce({ user: { id: ACTOR }, company: { id: CO }, membership: { company_id: BV, role_key: 'company_admin' } })
    expect(await loadHostawayListings(2)).toMatchObject({ ok: false, code: 'not_authorized' })
  })
  it('does not exchange credentials before the database migration exists', async () => {
    tables.pms_connections = { data: null, error: { code: '42P01' } }
    expect(await connectHostaway({ accountId: '123', apiKey: KEY, revision: 0 })).toMatchObject({ ok: false, code: 'database_pending' })
    expect(mock.exchange).not.toHaveBeenCalled(); expect(mock.service).not.toHaveBeenCalled()
  })
  it('rejects stale connect/replay and account changes before minting another token', async () => {
    expect(await connectHostaway({ accountId: '123', apiKey: KEY, revision: 1 })).toMatchObject({ code: 'stale_setup' })
    expect(await connectHostaway({ accountId: '999', apiKey: KEY, revision: 2 })).toMatchObject({ code: 'connection_unavailable' })
    expect(mock.exchange).not.toHaveBeenCalled()
  })
  it('stores only the verified token with trusted actor/company, returning no credential', async () => {
    const result = await connectHostaway({ accountId: '123', apiKey: KEY, revision: 2 })
    expect(result.ok).toBe(true)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('save_hostaway_connection', {
      p_company_id: CO, p_actor_id: ACTOR, p_account_id: '123', p_access_token: TOKEN, p_expires_at: '2028-01-01T00:00:00Z', p_expected_revision: 2,
    })
    expect(JSON.stringify(result)).not.toContain(TOKEN); expect(JSON.stringify(result)).not.toContain(KEY)
    expect(fields.filter(([t]) => t === 'pms_connections').every(([, columns]) => !columns.includes('credential_id'))).toBe(true)
    expect(filters).toContainEqual(['pms_connections', 'company_id', CO])
  })
  it('leaves the existing connection untouched when Hostaway rejects verification', async () => {
    mock.exchange.mockRejectedValueOnce(new HostawayError('credentials_rejected'))
    expect(await connectHostaway({ accountId: '123', apiKey: KEY, revision: 2 })).toMatchObject({ ok: false, code: 'credentials_rejected' })
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it.each(['disconnected', 'expired', 'stale'])('does not read secrets or call Hostaway for %s setup', async state => {
    tables.pms_connections = { data: { ...connection, ...(state === 'disconnected' ? { status: 'disconnected' } : state === 'expired' ? { credential_expires_at: '2020-01-01T00:00:00Z' } : { revision: 3 }) } }
    expect(await loadHostawayListings(2)).toMatchObject({ ok: false })
    expect(mock.rpc).not.toHaveBeenCalled(); expect(mock.listings).not.toHaveBeenCalled()
  })
  it('uses only the token for this company, actor, connection and exact revision', async () => {
    expect(await loadHostawayListings(2)).toMatchObject({ ok: true })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('read_hostaway_setup_token', { p_company_id: CO, p_actor_id: ACTOR, p_connection_id: C, p_revision: 2 })
    expect(mock.listings).toHaveBeenCalledExactlyOnceWith(TOKEN)
  })
  it('does not let a guessed listing ID read arbitrary physical-unit data', async () => {
    expect(await loadHostawayUnits({ listingId: '999', revision: 2 })).toMatchObject({ code: 'invalid_input' })
    expect(mock.units).not.toHaveBeenCalled()
  })
  it('rejects a foreign property UUID before provider reads or mapping writes', async () => {
    expect(await saveHostawayMapping({ ...mappingInput, propertyId: CO })).toMatchObject({ code: 'not_authorized' })
    expect(mock.listings).not.toHaveBeenCalled(); expect(mock.rpc.mock.calls.map(c => c[0])).toEqual(['read_hostaway_setup_token'])
  })
  it.each([BL, BV])('maps duplicate unit numbers by exact property UUID %s', async propertyId => {
    expect(await saveHostawayMapping({ ...mappingInput, propertyId })).toMatchObject({ ok: true })
    expect(mock.rpc).toHaveBeenLastCalledWith('save_hostaway_mapping', expect.objectContaining({ p_property_id: propertyId, p_listing_name: 'Verified provider name', p_time_zone: 'Africa/Johannesburg' }))
  })
  it('refuses a parent listing when real subunits exist; accepts only a freshly verified subunit', async () => {
    mock.units.mockResolvedValue([{ id: '7', name: 'Verified subunit' }])
    expect(await saveHostawayMapping(mappingInput)).toMatchObject({ code: 'physical_unit_required' })
    expect(await saveHostawayMapping({ ...mappingInput, unitId: '999' })).toMatchObject({ code: 'physical_unit_required' })
    expect(await saveHostawayMapping({ ...mappingInput, unitId: '7' })).toMatchObject({ ok: true })
    expect(mock.rpc).toHaveBeenLastCalledWith('save_hostaway_mapping', expect.objectContaining({ p_unit_id: '7', p_unit_name: 'Verified subunit' }))
  })
  it('empty subunits require an explicit human confirmation, not a guessed unit number', async () => {
    expect(await saveHostawayMapping({ ...mappingInput, physicalListingConfirmed: false })).toMatchObject({ code: 'physical_unit_required' })
    expect(await saveHostawayMapping({ ...mappingInput, unitId: '91' })).toMatchObject({ code: 'physical_unit_required' })
  })
  it('does not save when fresh provider discovery fails', async () => {
    mock.units.mockRejectedValueOnce(Error(`private-${TOKEN}`))
    const result = await saveHostawayMapping(mappingInput)
    expect(result).toMatchObject({ code: 'confirmation_unavailable' })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(mock.rpc.mock.calls.map(c => c[0])).toEqual(['read_hostaway_setup_token'])
  })
  it('reports a database race without claiming success or leaking SQL error details', async () => {
    mock.rpc.mockResolvedValueOnce({ error: { code: '40001', message: TOKEN }, data: null })
    const result = await connectHostaway({ accountId: '123', apiKey: KEY, revision: 2 })
    expect(result).toMatchObject({ ok: false, code: 'stale_setup' }); expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
  it('disconnects only the current company connection with revision protection', async () => {
    expect(await disconnectHostaway(2)).toMatchObject({ ok: true })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('disconnect_hostaway_connection', { p_company_id: CO, p_actor_id: ACTOR, p_connection_id: C, p_revision: 2 })
    expect(mock.exchange).not.toHaveBeenCalled(); expect(mock.listings).not.toHaveBeenCalled()
  })
  it('returns only local safe error messages', () => {
    expect(pmsFailure(new Error(TOKEN))).toMatchObject({ code: 'confirmation_unavailable' })
    expect(pmsFailure(new PmsSetupError('mapping_conflict'))).toMatchObject({ code: 'mapping_conflict' })
  })
})
