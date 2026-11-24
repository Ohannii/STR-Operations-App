import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
const load = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/get-user-context', () => ({ getUserContext: async () => ({ user: { id: 'manager' }, profile: {}, company: { id: 'company', name: 'Fixture' }, membership: { role_key: 'ops_manager' } }) }))
vi.mock('@/lib/inspections/load-workspace', () => ({ loadInspectionJobs: load, loadInspectionWorkspace: async () => ({ data: { properties: [], inspectors: [], history: [], managers_only: false, settings_revision: 0 } }) }))
vi.mock('@/components/app-shell', () => ({ AppShell: ({ children }: { children: ReactNode }) => children }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), redirect: vi.fn() }))
vi.mock('@/app/dashboard/work/actions', () => ({ scheduleTurnover: vi.fn(), startTurnover: vi.fn(), updateTurnover: vi.fn() }))
import WorkPage from '@/app/dashboard/work/page'
beforeEach(() => { vi.clearAllMocks(); load.mockResolvedValue({ data: [], error: null }) })
describe('work page query integration', () => {
  it('renders repeated property/scope keys without crashing or widening scope', async () => {
    const page = await WorkPage({ searchParams: Promise.resolve({ property: ['a', 'b'], scope: ['all', 'all'] }) })
    expect(() => renderToStaticMarkup(page)).not.toThrow()
    expect(load).toHaveBeenCalledWith('company', false, null)
  })
  it('preserves a scalar exact property filter for the manager overview', async () => {
    const property = '40000000-0000-4000-8000-000000000001'
    const page = await WorkPage({ searchParams: Promise.resolve({ property, scope: 'all' }) })
    expect(renderToStaticMarkup(page)).toContain('Apartment inspections')
    expect(load).toHaveBeenCalledWith('company', true, property)
  })
})
