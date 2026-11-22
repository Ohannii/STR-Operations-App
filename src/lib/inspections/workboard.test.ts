import { describe, expect, it } from 'vitest'
import { canInspect, canCoordinateInspections, inspectionError, jobState, localSastToUtc, propertyLabel, sastDay, validDay, type Allocation, type TurnoverJob } from './workboard'

const job = { due_on: '2026-11-22', cancelled_at: null, pack_deleted: false, pack_status: null } as TurnoverJob
describe('workboard dates and authorship', () => {
  it('does not invent due work from allocation or treat a draft as submitted', () => {
    expect(jobState(job, '2026-11-22')).toBe('today')
    expect(jobState({ ...job, pack_status: 'draft' }, '2026-11-23')).toBe('overdue')
    expect(jobState(job, '2026-11-21')).toBe('upcoming')
    expect(jobState({ ...job, pack_status: 'submitted' }, '2026-11-23')).toBe('submitted')
  })
  it('never treats a deleted pack or cancelled schedule as completion', () => {
    expect(jobState({ ...job, pack_deleted: true, pack_status: 'submitted' }, '2026-11-23')).toBe('needs_attention')
    expect(jobState({ ...job, cancelled_at: '2026-11-21' }, '2026-11-23')).toBe('cancelled')
  })
  it('uses South Africa midnight across year end independently of the server zone', () => {
    expect(sastDay(new Date('2026-12-31T21:59:59Z'))).toBe('2026-12-31')
    expect(sastDay(new Date('2026-12-31T22:00:00Z'))).toBe('2027-01-01')
    expect(localSastToUtc('2026-11-22T00:30')).toBe('2026-11-21T22:30:00.000Z')
    expect(localSastToUtc('')).toBeNull()
  })
  it.each(['2026-02-30', '2026-13-01', '22-11-2026', '', '2026-11-2'])('rejects invalid date %s', day => expect(validDay(day)).toBe(false))
  it.each(['2026-11-22T23:60', '2026-11-22T24:00', '2026-02-30T12:00', '2026-11-22T12:00Z'])('rejects invalid local time %s', time => expect(() => localSastToUtc(time)).toThrow())
  it('keeps BV 91 and BL 91 explicit and separate', () => {
    const p = { name: 'Unit 91', unit_reference: '91', address: 'Ballito Village' } as Allocation
    expect(propertyLabel(p)).toBe('Ballito Village · Unit 91')
    expect(propertyLabel({ ...p, address: 'Ballito Life' })).toBe('Ballito Life · Unit 91')
  })
})
describe('roles and safe errors', () => {
  it.each(['company_admin', 'gm', 'ops_manager', 'maintenance_coordinator'])('allows %s to coordinate and inspect', role => {
    expect(canInspect(role)).toBe(true); expect(canCoordinateInspections(role)).toBe(true)
  })
  it('allows inspector work without giving manager powers', () => {
    expect(canInspect('inspector')).toBe(true); expect(canCoordinateInspections('inspector')).toBe(false)
  })
  it.each(['finance', 'auditor', 'property_owner_viewer', 'inventory_manager', 'maintenance_tech', 'admin', null])('refuses %s', role => expect(canInspect(role)).toBe(false))
  it('keeps raw database details out of screen messages', () => {
    expect(inspectionError({ code: 'XX000', message: 'secret fixture' })).not.toContain('secret')
    expect(inspectionError({ code: 'PGRST202' })).toContain('not switched on')
    expect(inspectionError({ code: '40001' })).toContain('another device')
  })
})
