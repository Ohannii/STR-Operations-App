import { beforeEach, expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ rpc }) }))
import { loadInspectionJobs, loadInspectionWorkspace } from './load-workspace'
beforeEach(() => rpc.mockReset())
it('keeps missing setup distinct from a transient read failure', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202' } })
  expect(await loadInspectionWorkspace('company')).toMatchObject({ data: null, error: expect.stringContaining('not switched on') })
  rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'raw detail' } })
  expect(await loadInspectionWorkspace('company')).toEqual({ data: null, error: 'Could not load inspection work. Check your connection and reload.' })
})
it('does not turn failed or thrown schedule reads into an empty list', async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } })
  expect(await loadInspectionJobs('company', false)).toMatchObject({ data: null })
  rpc.mockRejectedValueOnce(Error('offline'))
  expect(await loadInspectionJobs('company', false)).toMatchObject({ data: null, error: expect.stringContaining('Could not load') })
})
it('accepts a confirmed empty schedule without claiming a connection failure', async () => {
  rpc.mockResolvedValueOnce({ data: [], error: null })
  expect(await loadInspectionJobs('company', false, 'property')).toEqual({ data: [], error: null })
  expect(rpc).toHaveBeenCalledWith('inspection_workboard', { p_company: 'company', p_all: false, p_property: 'property' })
})
