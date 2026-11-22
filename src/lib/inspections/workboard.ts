import { canManageProperties } from '@/lib/properties/property-management'
import { classifyEstate, ESTATE_LABEL } from '@/lib/properties/finder'

export const canCoordinateInspections = canManageProperties
export function canInspect(role: string | null | undefined) {
  return role === 'inspector' || canCoordinateInspections(role)
}
export type Inspector = { id: string; name: string | null; role: string }
export type Allocation = {
  id: string; name: string; address: string | null; unit_reference: string | null
  revision: number; inspector_id: string | null; inspector_name: string | null; inspector_active: boolean
}
export type InspectionWorkspace = {
  managers_only: boolean; settings_revision: number; properties: Allocation[]; inspectors: Inspector[]
  history: Array<{ id: string; property_id: string; actor: string | null; previous_id: string | null; next_id: string | null; previous: string | null; next: string | null; at: string }>
}
export type TurnoverJob = {
  id: string; property_id: string; due_on: string; checkout_at: string | null; next_arrival_at: string | null
  source: 'manual'; cancelled_at: string | null; revision: number; pack_id: string | null
  pack_deleted: boolean; pack_status: string | null; started_by: string | null; starter_name: string | null
  submitted_by: string | null; submitter_name: string | null; submitted_at: string | null
}
export type JobState = 'overdue' | 'today' | 'upcoming' | 'submitted' | 'cancelled' | 'needs_attention'
export function jobState(job: TurnoverJob, today: string): JobState {
  if (job.cancelled_at) return 'cancelled'
  if (job.pack_deleted) return 'needs_attention'
  if (job.pack_status === 'submitted') return 'submitted'
  return job.due_on < today ? 'overdue' : job.due_on === today ? 'today' : 'upcoming'
}
// Automatic apartment Start must not consume a later visit. Upcoming work is
// separate and can be selected explicitly from its dated workboard card.
export function nextUnstartedTurnover(jobs: TurnoverJob[], propertyId: string, today: string): TurnoverJob | null {
  return jobs.filter(j => j.property_id === propertyId && j.due_on <= today && !j.cancelled_at && !j.pack_id)
    .sort((a, b) => a.due_on.localeCompare(b.due_on)
      || (a.checkout_at ?? '').localeCompare(b.checkout_at ?? '') || a.id.localeCompare(b.id))[0] ?? null
}
export function nextDiscardedTurnover(jobs: TurnoverJob[], propertyId: string, today: string): TurnoverJob | null {
  return jobs.filter(j => j.property_id === propertyId && j.due_on <= today && !j.cancelled_at
    && j.pack_id && j.pack_deleted && j.pack_status === 'draft')
    .sort((a, b) => a.due_on.localeCompare(b.due_on) || a.id.localeCompare(b.id))[0] ?? null
}
// Repeated query keys arrive as arrays in Next; never pass them to client search.
export const workQueryValue = (value: unknown): string => typeof value === 'string' ? value : ''
export function sastDay(now = new Date()): string {
  // Avoid Intl locale defaults and server/device timezone differences.
  return new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
export function propertyLabel(property: Allocation): string {
  const estate = classifyEstate(property)
  return estate === 'other' ? property.name : `${ESTATE_LABEL[estate]} · ${property.name}`
}
export const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
export function validDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
export function localSastToUtc(value: string): string | null {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !validDay(value.slice(0, 10))) throw Error('Invalid date/time.')
  const time = value.slice(11)
  if (time > '23:59' || Number(time.slice(3)) > 59) throw Error('Invalid date/time.')
  return new Date(`${value}:00+02:00`).toISOString()
}
export function inspectionError(error: { code?: string; message?: string } | null): string {
  if (['PGRST202', '42P01', '42703'].includes(error?.code ?? '')) return 'Inspection planning is not switched on yet. Please tell Anni.'
  if (error?.code === '40001') return 'This changed on another device. Reload to see the latest version before saving.'
  if (error?.code === '42501') return 'Your current role cannot make this change, or the record is unavailable.'
  if (error?.code === '23505') return 'This work already exists or has changed. Reload the work list before adding it again.'
  if (error?.code === '55000' && error.message === 'existing draft') return 'This apartment has an older open pack that is not part of this inspection. Submit or discard it, then tap Start inspection.'
  if (error?.code === '55000' && error.message === 'pack unavailable') return 'This inspection’s draft was discarded. A manager can cancel the inspection before scheduling a replacement.'
  if (error?.code === '55000') return 'This inspection has already started or its schedule has changed. Reload the work list.'
  return 'Could not save. Your entries are kept; check your connection and try again.'
}
