import { createClient } from '@/lib/supabase/server'
import { inspectionError, type InspectionWorkspace, type TurnoverJob } from './workboard'

function readError(error: { code?: string } | null): string {
  if (['PGRST202', '42P01', '42703'].includes(error?.code ?? '')) return inspectionError(error)
  return 'Could not load inspection work. Check your connection and reload.'
}
export async function loadInspectionWorkspace(companyId: string) {
  try {
    const db = await createClient()
    const { data, error } = await db.rpc('inspection_workspace', { p_company: companyId })
    if (error || !data) return { data: null, error: readError(error) }
    return { data: data as InspectionWorkspace, error: null }
  } catch { return { data: null, error: readError(null) } }
}
export async function loadInspectionJobs(companyId: string, all: boolean, propertyId: string | null = null) {
  try {
    const db = await createClient()
    const { data, error } = await db.rpc('inspection_workboard', { p_company: companyId, p_all: all, p_property: propertyId })
    if (error || !Array.isArray(data)) return { data: null, error: readError(error) }
    return { data: data as TurnoverJob[], error: null }
  } catch { return { data: null, error: readError(null) } }
}
