import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canManageProperties, parsePropertyFields } from './property-management'

const mocks = vi.hoisted(() => ({ context: vi.fn(), client: vi.fn(), revalidate: vi.fn(), insert: vi.fn(), update: vi.fn(), eq: vi.fn(), is: vi.fn(), result: { data: { id: 'p' } as { id: string } | null, error: null as unknown } }))
vi.mock('@/lib/auth/get-user-context', () => ({ getUserContext: mocks.context }))
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.client }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))
import { createPropertyAction } from '@/app/properties/new/actions'
import { updatePropertyAction } from '@/app/properties/[id]/edit/actions'

const id = '10000000-0000-4000-8000-000000000001'
const stamp = '2026-11-20T12:00:00.123456+00:00'
function form(values: Record<string, string> = {}) {
  const data = new FormData()
  for (const [key, value] of Object.entries({ name: 'Village · Unit 91', ...values })) data.set(key, value)
  return data
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.context.mockResolvedValue({ user: { id: 'u' }, company: { id: 'company-a' }, membership: { role_key: 'maintenance_coordinator' } })
  mocks.result = { data: { id }, error: null }
  const q = { eq: mocks.eq, is: mocks.is, select: () => q, maybeSingle: async () => mocks.result }
  mocks.eq.mockReturnValue(q); mocks.is.mockReturnValue(q)
  mocks.update.mockReturnValue(q)
  mocks.insert.mockImplementation(async () => ({ error: mocks.result.error }))
  mocks.client.mockResolvedValue({ from: () => ({ insert: mocks.insert, update: mocks.update }) })
})

describe('property management permissions', () => {
  it.each(['company_admin', 'gm', 'ops_manager', 'maintenance_coordinator'])('allows %s', role => expect(canManageProperties(role)).toBe(true))
  it.each(['inspector', 'maintenance_tech', 'finance', 'auditor', 'property_owner_viewer', 'inventory_manager', 'super_admin', '', null, undefined])('refuses %s', role => expect(canManageProperties(role)).toBe(false))
  it.each(['inspector', 'maintenance_tech'])('blocks forged create and edit requests by %s before accessing the database', async role => {
    mocks.context.mockResolvedValue({ company: { id: 'company-a' }, membership: { role_key: role } })
    expect(await createPropertyAction({}, form())).toHaveProperty('error')
    expect(await updatePropertyAction(id, stamp, {}, form())).toHaveProperty('error')
    expect(mocks.client).not.toHaveBeenCalled()
  })
})
describe('property validation and writes', () => {
  it.each(['-1', '1.5', 'NaN', '51', '1e1', 'Infinity'])('rejects invalid bedroom count %s', bedrooms => expect(parsePropertyFields(form({ bedrooms })).ok).toBe(false))
  it.each(['0', '50', ''])('accepts bedroom boundary %s', bedrooms => expect(parsePropertyFields(form({ bedrooms })).ok).toBe(true))
  it('requires a name and validates limits without truncating', () => {
    const invalid: Record<string, string>[] = [{ name: '  ' }, { name: 'a'.repeat(201) }, { address: 'a'.repeat(501) }, { unit_reference: 'a'.repeat(101) }, { notes: 'a'.repeat(5001) }]
    for (const values of invalid) {
      expect(parsePropertyFields(form(values)).ok).toBe(false)
    }
  })
  it('takes the company from the session and never accepts protected fields', async () => {
    await expect(createPropertyAction({}, form({ company_id: 'other', id: 'forged', status: 'critical', owner_profile_id: 'forged' }))).rejects.toThrow('redirect:/dashboard')
    expect(mocks.insert).toHaveBeenCalledWith({ company_id: 'company-a', name: 'Village · Unit 91', address: null, bedrooms: null, unit_reference: null, notes: null })
  })
  it('pins an edit to the company, live property and exact loaded version', async () => {
    await expect(updatePropertyAction(id, stamp, {}, form({ company_id: 'other', status: 'critical' }))).rejects.toThrow(`redirect:/properties/${id}?property_updated=1`)
    expect(mocks.eq.mock.calls).toEqual([['id', id], ['company_id', 'company-a'], ['updated_at', stamp]])
    expect(mocks.is).toHaveBeenCalledWith('deleted_at', null)
    expect(mocks.update).toHaveBeenCalledWith({ name: 'Village · Unit 91', address: null, bedrooms: null, unit_reference: null, notes: null })
    expect(mocks.revalidate).toHaveBeenCalledWith('/dashboard')
  })
  it('refuses stale or inaccessible edits without claiming a save', async () => {
    mocks.result.data = null
    expect((await updatePropertyAction(id, stamp, {}, form())).error).toContain('changed or is no longer available')
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })
  it('does not expose raw database errors and keeps the form on failure', async () => {
    mocks.result.error = { message: 'private database details' }
    expect((await updatePropertyAction(id, stamp, {}, form())).error).toBe('Could not save the property. Your entries are kept; please try again.')
    expect((await createPropertyAction({}, form())).error).toBe('Could not add the property. Your entries are kept; please try again.')
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })
  it('rejects invalid property references and versions before database access', async () => {
    expect(await updatePropertyAction('invalid', stamp, {}, form())).toHaveProperty('error')
    expect(await updatePropertyAction(id, 'invalid', {}, form())).toHaveProperty('error')
    expect(mocks.client).not.toHaveBeenCalled()
  })
})
