// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: mocks.push }) }))
vi.mock('@/app/dashboard/work/actions', () => ({ startTurnover: vi.fn(), updateTurnover: vi.fn(), scheduleTurnover: vi.fn() }))
import { Workboard } from '@/app/dashboard/work/workboard'
import type { InspectionWorkspace, TurnoverJob } from '@/lib/inspections/workboard'
const workspace: InspectionWorkspace = { properties: [
  { id: 'bl', name: 'Unit 91', address: 'Ballito Life', unit_reference: '91', revision: 0, inspector_id: null, inspector_name: null, inspector_active: false },
  { id: 'bv', name: 'Unit 91', address: 'Ballito Village', unit_reference: '91', revision: 0, inspector_id: null, inspector_name: null, inspector_active: false },
], inspectors: [], history: [], managers_only: false, settings_revision: 0 }
const due: TurnoverJob = { id: 'due', property_id: 'bl', due_on: '2026-11-22', checkout_at: null, next_arrival_at: null, source: 'manual', cancelled_at: null, revision: 0, pack_id: null, pack_deleted: false, pack_status: null, started_by: null, starter_name: null, submitted_by: null, submitter_name: null, submitted_at: null }
let host: HTMLDivElement, root: Root
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => { root.unmount() }); host.remove(); vi.unstubAllGlobals() })
const mount = async (jobs: TurnoverJob[], initialProperty = '') => { await act(async () => { root.render(<Workboard workspace={workspace} jobs={jobs} manager={false} all={false} userId="inspector" today="2026-11-22" initialProperty={initialProperty} />) }) }
const headings = () => [...host.querySelectorAll('article h2')].map(h => h.textContent)
describe('compact work-list controls', () => {
  it('the view selector still reaches completed and upcoming work with honest counts', async () => {
    await mount([due, { ...due, id: 'future', property_id: 'bv', due_on: '2026-12-05' }, { ...due, id: 'done', property_id: 'bv', pack_id: 'pack', pack_status: 'submitted', submitted_at: '2026-11-22T12:00:00Z' }])
    const view = host.querySelector('select')!
    expect(headings()).toEqual(['Ballito Life · Unit 91'])
    expect(view.textContent).toContain('Completed (1)')
    await act(async () => { view.value = 'submitted'; view.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(headings()).toEqual(['Ballito Village · Unit 91']); expect(host.querySelector('article')?.textContent).toContain('Inspection complete')
    await act(async () => { view.value = 'upcoming'; view.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.querySelector('article')?.textContent).toContain('5 Dec 2026'); expect(host.querySelector('article')?.textContent).not.toContain('Inspection complete')
  })
  it('clearing an exact apartment filter reveals both estates without conflating same-number units', async () => {
    await mount([due, { ...due, id: 'bv-due', property_id: 'bv' }], 'bl')
    expect(headings()).toEqual(['Ballito Life · Unit 91'])
    const clear = [...host.querySelectorAll('button')].find(b => b.textContent === 'Clear apartment filter')!
    await act(async () => { clear.click() })
    expect(headings()).toEqual(['Ballito Life · Unit 91', 'Ballito Village · Unit 91'])
    expect(host.querySelector('input')).toBeNull()
  })
  it('clearing a server-scoped apartment URL requests the full work list instead of pretending it was loaded', async () => {
    const id = '33333333-3333-4333-8333-333333333333'
    await act(async () => { root.render(<Workboard workspace={{ ...workspace, properties: [{ ...workspace.properties[0], id }] }} jobs={[{ ...due, property_id: id }]} manager={false} all={false} userId="inspector" today="2026-11-22" initialProperty={id} />) })
    const clear = [...host.querySelectorAll('button')].find(b => b.textContent === 'Clear apartment filter')!
    await act(async () => { clear.click() })
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/dashboard/work')
    expect(headings()).toHaveLength(1)
  })
})
