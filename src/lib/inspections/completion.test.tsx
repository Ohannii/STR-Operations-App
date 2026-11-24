import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { completedInspectionForPack, inspectionCompletionForPack } from './completion'
import { CompletedInspectionNotice } from '@/components/inspections/completed-inspection-notice'
import type { TurnoverJob } from './workboard'
const pack = '11111111-1111-4111-8111-111111111111'
const property = '22222222-2222-4222-8222-222222222222'
const job: TurnoverJob = { id: 'visit', property_id: property, due_on: '2026-11-22', checkout_at: null, next_arrival_at: null, source: 'manual', cancelled_at: null, revision: 1, pack_id: pack, pack_deleted: false, pack_status: 'submitted', started_by: 'a', starter_name: 'Inspector A', submitted_by: 'b', submitter_name: 'Inspector B', submitted_at: '2026-11-22T10:30:00Z' }
describe('server-proven inspection completion', () => {
  it('selects the exact submitted visit and retains both actual authors', () => {
    expect(completedInspectionForPack([job], property, pack)).toEqual(job)
    expect(job.starter_name).toBe('Inspector A'); expect(job.submitter_name).toBe('Inspector B')
  })
  it.each([undefined, '1', 'wrong', [pack], ['1', pack]])('never trusts a legacy/forged/repeated URL value: %s', value => {
    expect(completedInspectionForPack([job], property, value)).toBeNull()
  })
  it.each([
    { property_id: 'other-property' }, { pack_id: '33333333-3333-4333-8333-333333333333' },
    { pack_status: 'draft' }, { cancelled_at: '2026-11-22T10:00:00Z' }, { pack_deleted: true },
    { submitted_at: null }, { submitted_at: 'invalid' },
  ])('does not label unrelated, open or unavailable work complete: %j', change => {
    expect(completedInspectionForPack([{ ...job, ...change }], property, pack)).toBeNull()
  })
  it('does not infer completion when no job was returned', () => {
    expect(completedInspectionForPack([], property, pack)).toBeNull()
  })
  it('shows actual submitter and South Africa time, leads back to work and never claims guest readiness', () => {
    const confirmed = completedInspectionForPack([job], property, pack)!
    const html = renderToStaticMarkup(<CompletedInspectionNotice job={confirmed} />)
    expect(html).toContain('Inspection complete'); expect(html).toContain('Submitted by Inspector B')
    expect(html).toContain('12:30'); expect(html).toContain('Back to my inspections')
    expect(html).toContain('href="/dashboard/work?view=submitted"'); expect(html).toContain(`/properties/${property}/packs/${pack}/report`)
    expect(html).toContain('guest readiness are tracked separately'); expect(html).not.toContain('Start inspection')
  })
  it('records a standalone submitted inspection without inventing a scheduled visit or changing other work', () => {
    const submitted = { id: pack, property_id: property, status: 'submitted', deleted_at: null, submitted_by: 'b', submitted_at: job.submitted_at }
    const unrelated = { ...job, id: 'other-visit', pack_id: null, pack_status: null, submitted_at: null }
    const result = inspectionCompletionForPack([unrelated], property, pack, submitted, 'Inspector B')
    expect(result).toEqual({ property_id: property, pack_id: pack, submitted_at: job.submitted_at, submitter_name: 'Inspector B' })
    expect(unrelated.pack_id).toBeNull(); expect(unrelated.pack_status).toBeNull()
  })
  it.each([{ property_id: 'other' }, { status: 'draft' }, { deleted_at: '2026-11-22T11:00:00Z' }, { submitted_at: null }, { submitted_at: 'invalid' }])('refuses unproven standalone completion: %j', change => {
    expect(inspectionCompletionForPack([], property, pack, { id: pack, property_id: property, status: 'submitted', deleted_at: null, submitted_by: 'b', submitted_at: job.submitted_at, ...change }, 'Inspector B')).toBeNull()
  })
  it('never overrides a linked cancellation or an unavailable work-list read with a standalone notice', () => {
    const submitted = { id: pack, property_id: property, status: 'submitted', deleted_at: null, submitted_by: 'b', submitted_at: job.submitted_at }
    expect(inspectionCompletionForPack([{ ...job, cancelled_at: '2026-11-22T11:00:00Z' }], property, pack, submitted, 'Inspector B')).toBeNull()
    expect(inspectionCompletionForPack(null, property, pack, submitted, 'Inspector B')).toBeNull()
  })
})
