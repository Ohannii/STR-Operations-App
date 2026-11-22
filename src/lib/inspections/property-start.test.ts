import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ jobs: vi.fn(), start: vi.fn(), from: vi.fn(), insert: vi.fn(), revalidate: vi.fn() }))
vi.mock('@/lib/auth/get-user-context', () => ({ getUserContext: async () => ({ company: { id: 'company' }, user: { id: 'inspector' }, membership: { role_key: 'inspector' } }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: mocks.from }) }))
vi.mock('@/lib/inspections/load-workspace', () => ({ loadInspectionJobs: mocks.jobs }))
vi.mock('@/app/dashboard/work/actions', () => ({ startTurnover: mocks.start }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw Error(`redirect:${url}`) } }))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
import { startPreArrivalPackAction } from '@/app/properties/[id]/packs/actions'
const property = '40000000-0000-4000-8000-000000000001'
function form() { const data = new FormData(); data.set('property_id', property); return data }
beforeEach(() => {
  vi.clearAllMocks()
  const query = { select: () => query, eq: () => query, is: () => query, maybeSingle: async () => ({ data: { id: property, company_id: 'company' }, error: null }), insert: mocks.insert }
  mocks.from.mockReturnValue(query)
  mocks.jobs.mockResolvedValue({ data: [{ id: 'job', property_id: property, due_on: '2026-11-22', pack_id: null, cancelled_at: null }], error: null })
  mocks.start.mockResolvedValue({ ok: true, packId: 'pack' })
})
describe('habitual property Start form on a scheduled apartment', () => {
  it('uses the scheduled Start RPC even for a stale ordinary Start form', async () => {
    await expect(startPreArrivalPackAction(form())).rejects.toThrow(`redirect:/properties/${property}`)
    expect(mocks.jobs).toHaveBeenCalledWith('company', false, property)
    expect(mocks.start).toHaveBeenCalledWith('job')
    expect(mocks.from).not.toHaveBeenCalledWith('evidence_packs'); expect(mocks.insert).not.toHaveBeenCalled()
  })
  it('keeps an existing unrelated draft separate and returns the recovery message', async () => {
    mocks.start.mockResolvedValue({ ok: false, error: 'Submit or discard the older pack, then tap Start inspection.' })
    await expect(startPreArrivalPackAction(form())).rejects.toThrow(encodeURIComponent('Submit or discard the older pack, then tap Start inspection.'))
    expect(mocks.insert).not.toHaveBeenCalled()
  })
  it('does not silently start an unrelated pack if scheduled work cannot load', async () => {
    mocks.jobs.mockResolvedValue({ data: null, error: 'Could not load inspection work.' })
    await expect(startPreArrivalPackAction(form())).rejects.toThrow(encodeURIComponent('Could not load inspection work.'))
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled()
  })
})
