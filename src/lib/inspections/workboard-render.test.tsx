import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/app/dashboard/work/actions', () => ({ assignInspectors: vi.fn(), setReassignmentPolicy: vi.fn(), scheduleTurnover: vi.fn(), updateTurnover: vi.fn(), startTurnover: vi.fn() }))
import { AssignmentManager } from '@/app/dashboard/assignments/assignment-manager'
import { InspectionJobCard, Workboard } from '@/app/dashboard/work/workboard'
import { DiscardedInspectionNotice } from '@/components/inspections/discarded-inspection-notice'
import type { Allocation, InspectionWorkspace, TurnoverJob } from './workboard'
const p: Allocation = { id: 'p', name: 'Unit 91', address: 'Ballito Life', unit_reference: '91', revision: 0, inspector_id: 'a', inspector_name: 'Inspector A', inspector_active: true }
const workspace: InspectionWorkspace = { properties: [p, { ...p, id: 'bv', address: 'Ballito Village', inspector_id: null, inspector_name: null }], inspectors: [{ id: 'a', name: 'Inspector A', role: 'inspector' }, { id: 'b', name: 'Inspector B', role: 'inspector' }], history: [], managers_only: false, settings_revision: 0 }
const j: TurnoverJob = { id: 'j', property_id: 'p', due_on: '2026-11-22', checkout_at: null, next_arrival_at: null, source: 'manual', cancelled_at: null, revision: 0, pack_id: 'pack', pack_deleted: false, pack_status: 'submitted', started_by: 'b', starter_name: 'Inspector B', submitted_by: 'b', submitter_name: 'Inspector B', submitted_at: '2026-11-22T10:00:00Z' }
describe('actual inspection screens', () => {
  it('puts discarded inspection status and manager cancellation on the apartment, without another Start action', () => {
    const html = renderToStaticMarkup(<DiscardedInspectionNotice job={{ ...j, pack_status: 'draft', pack_deleted: true }} manager propertyName="Ballito Life · Unit 91" />)
    expect(html).toContain('Inspection still open'); expect(html).toContain('Inspection options')
    expect(html).toContain('Inspection needs attention'); expect(html).toContain('Options')
    expect(html).toContain('To start again'); expect(html).toContain('Open inspection work')
    expect(html).not.toContain('Cancel inspection'); expect(html).not.toContain('<dialog')
    expect(html).toContain('/dashboard/work?scope=all&amp;property=p')
    expect(html).not.toContain('Start pre-arrival'); expect(html).not.toContain('Start scheduled')
    const inspector = renderToStaticMarkup(<DiscardedInspectionNotice job={{ ...j, pack_status: 'draft', pack_deleted: true }} manager={false} propertyName="Ballito Life · Unit 91" />)
    expect(inspector).toContain('Ask a manager'); expect(inspector).not.toContain('<button')
  })
  it('keeps the regular inspector and actual submitter separate, with no readiness claim', () => {
    const html = renderToStaticMarkup(<InspectionJobCard job={j} property={p} manager={false} today="2026-11-22" />)
    expect(html).toContain('Inspector A'); expect(html).toContain('Inspector B')
    expect(html).toContain('Submitted by:'); expect(html).toContain('guest readiness are tracked separately')
    expect(html).toContain('/properties/p/packs/pack/report'); expect(html).not.toContain('Start inspection')
  })
  it('offers only cancellation of a discarded linked draft to managers', () => {
    const discarded = { ...j, pack_status: 'draft', pack_deleted: true }
    const html = renderToStaticMarkup(<InspectionJobCard job={discarded} property={p} manager today="2026-11-22" />)
    expect(html).toContain('Inspection options')
    expect(html).not.toContain('Change schedule'); expect(html).not.toContain('Start inspection')
    expect(html).not.toContain('Continue inspection'); expect(html).not.toContain('View pack')
    const inspector = renderToStaticMarkup(<InspectionJobCard job={discarded} property={p} manager={false} today="2026-11-22" />)
    expect(inspector).toContain('Ask a manager'); expect(inspector).not.toContain('>Cancel inspection</button>')
  })
  it('shows starter A and submitter B independently on the completed card', () => {
    const html = renderToStaticMarkup(<InspectionJobCard job={{ ...j, started_by: 'a', starter_name: 'Inspector A' }} property={p} manager today="2026-11-22" />)
    expect(html).toContain('Started by:'); expect(html).toContain('Submitted by:')
    expect(html).toContain('Inspector A'); expect(html).toContain('Inspector B')
  })
  it('guides an unstarted due visit to Start and never claims it is complete', () => {
    const html = renderToStaticMarkup(<InspectionJobCard job={{ ...j, pack_id: null, pack_status: null }} property={p} manager={false} today="2026-11-22" />)
    expect(html).toContain('Due today'); expect(html).toContain('Start inspection')
    expect(html).toContain('Take photos and report any issues, then submit the pack')
    expect(html).not.toContain('Inspection complete'); expect(html).not.toContain('Continue inspection')
  })
  it('guides a live draft to Continue without another Start or a completed label', () => {
    const html = renderToStaticMarkup(<InspectionJobCard job={{ ...j, pack_status: 'draft', submitted_at: null }} property={p} manager={false} today="2026-11-22" />)
    expect(html).toContain('In progress'); expect(html).toContain('Continue inspection')
    expect(html).toContain('review and submit the pack')
    expect(html).not.toContain('Start inspection'); expect(html).not.toContain('Inspection complete')
  })
  it('distinguishes future work from work due today', () => {
    const html = renderToStaticMarkup(<InspectionJobCard job={{ ...j, due_on: '2026-12-05', pack_id: null, pack_status: null }} property={p} manager={false} today="2026-11-22" />)
    expect(html).toContain('Upcoming'); expect(html).toContain('5 Dec 2026')
    expect(html).not.toContain('Due today'); expect(html).not.toContain('Inspection complete')
  })
  it('keeps cancelled history distinct from a discarded inspection needing recovery', () => {
    const html = renderToStaticMarkup(<InspectionJobCard job={{ ...j, pack_status: 'draft', pack_deleted: true, cancelled_at: '2026-11-22T10:00:00Z' }} property={p} manager today="2026-11-22" />)
    expect(html).toContain('Cancelled'); expect(html).not.toContain('Needs attention')
    expect(html).not.toContain('Inspection options'); expect(html).not.toContain('Start inspection')
  })
  it('gives an open-policy inspector bulk allocation, but hides manager settings', () => {
    const html = renderToStaticMarkup(<AssignmentManager workspace={workspace} manager={false} />)
    expect(html).toContain('Save allocation'); expect(html).toContain('Ballito Life'); expect(html).toContain('Ballito Village')
    expect(html).not.toContain('Limit reassignment to managers')
  })
  it('renders read-only allocations under the manager-only policy', () => {
    const html = renderToStaticMarkup(<AssignmentManager workspace={{ ...workspace, managers_only: true }} manager={false} />)
    expect(html).not.toContain('Save allocation'); expect(html).not.toContain('type="checkbox"')
    expect(html).toContain('Open apartment')
  })
  it('shows allocated apartments without inventing inspection work or checkout times', () => {
    const html = renderToStaticMarkup(<Workboard workspace={workspace} jobs={[]} manager={false} all={false} userId="a" today="2026-11-22" initialProperty="" />)
    expect(html).toContain('No due inspections'); expect(html).toContain('My allocated apartments (1)')
    expect(html).not.toContain('Start inspection'); expect(html).not.toContain('Schedule an inspection')
    expect(html).toContain('Manually scheduled checkouts today')
  })
})
