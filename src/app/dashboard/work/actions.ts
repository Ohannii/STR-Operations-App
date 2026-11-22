'use server'

import { revalidatePath } from 'next/cache'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { canCoordinateInspections, canInspect, inspectionError, localSastToUtc, validDay, validId } from '@/lib/inspections/workboard'

export type WorkResult = { ok: true; packId?: string } | { ok: false; error: string }
async function callWorkRpc(name: string, args: Record<string, unknown>, manager = false): Promise<WorkResult> {
  const ctx = await getUserContext()
  if (!ctx?.company || !(manager ? canCoordinateInspections(ctx.membership?.role_key) : canInspect(ctx.membership?.role_key))) {
    return { ok: false, error: 'Sign in with an appropriate operations or inspector account.' }
  }
  try {
    const db = await createClient()
    // Tenant always comes from the authenticated context, never from the form.
    const { data, error } = await db.rpc(name, { ...args, p_company: ctx.company.id })
    if (error) {
      console.error('[inspections]', name, error.code)
      return { ok: false, error: inspectionError(error) }
    }
    revalidatePath('/dashboard')
    revalidatePath('/dashboard/work')
    revalidatePath('/dashboard/assignments')
    return { ok: true, ...(name === 'start_turnover_job' && validId(data) ? { packId: data } : {}) }
  } catch {
    return { ok: false, error: inspectionError(null) }
  }
}
export async function assignInspectors(changes: Array<{ property_id: string; revision: number }>, inspector: string | null): Promise<WorkResult> {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 200 || (inspector !== null && !validId(inspector))
    || changes.some(c => !c || typeof c !== 'object' || !validId(c.property_id) || !Number.isSafeInteger(c.revision) || c.revision < 0)
    || new Set(changes.map(c => c.property_id)).size !== changes.length) return { ok: false, error: 'Select apartments and an available inspector.' }
  return callWorkRpc('assign_primary_inspectors', { p_changes: changes, p_inspector: inspector })
}
export async function setReassignmentPolicy(managersOnly: boolean, revision: number): Promise<WorkResult> {
  if (typeof managersOnly !== 'boolean' || !Number.isSafeInteger(revision) || revision < 0) return { ok: false, error: 'Reload the assignment settings.' }
  return callWorkRpc('set_inspection_reassignment_policy', { p_managers_only: managersOnly, p_revision: revision }, true)
}
export async function scheduleTurnover(input: { id: string; propertyId: string; due: string; checkout: string; arrival: string }): Promise<WorkResult> {
  if (!input || typeof input !== 'object' || !validId(input.id) || !validId(input.propertyId) || !validDay(input.due)) return { ok: false, error: 'Choose an apartment and a valid inspection date.' }
  let checkout: string | null, arrival: string | null
  try { checkout = localSastToUtc(input.checkout); arrival = localSastToUtc(input.arrival) } catch { return { ok: false, error: 'Enter valid checkout and arrival times.' } }
  if (checkout && arrival && arrival < checkout) return { ok: false, error: 'The next arrival must be after checkout.' }
  return callWorkRpc('schedule_turnover', { p_id: input.id, p_property: input.propertyId, p_due: input.due, p_checkout: checkout, p_arrival: arrival }, true)
}
export async function updateTurnover(id: string, revision: number, due: string, cancel: boolean): Promise<WorkResult> {
  if (!validId(id) || !Number.isSafeInteger(revision) || revision < 0 || !validDay(due) || typeof cancel !== 'boolean') return { ok: false, error: 'Reload the inspection schedule.' }
  return callWorkRpc('update_turnover_schedule', { p_id: id, p_revision: revision, p_due: due, p_cancel: cancel }, true)
}
export async function startTurnover(id: string): Promise<WorkResult> {
  if (!validId(id)) return { ok: false, error: 'Inspection unavailable.' }
  const result = await callWorkRpc('start_turnover_job', { p_id: id })
  return result.ok && !result.packId ? { ok: false, error: 'Could not open the pack. Reload and try again.' } : result
}
