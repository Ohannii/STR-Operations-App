import type { SupabaseClient } from '@supabase/supabase-js'
import {
  asanaIssueStatus,
  pickCreateJob,
  type AsanaIssueStatus,
  type CreateJobRow,
} from '@/lib/issues/asana-status'
import { ALL_CREATE_EVENTS } from '@/lib/integrations/asana/destinations'

export type PackPhotoIssue = { flagId: string; asanaStatus: AsanaIssueStatus }

/** Per flag: its Asana status, or 'deleted' when the flag is gone / not visible. */
export type FlagAsanaLookup = Map<string, AsanaIssueStatus | 'deleted'>

/**
 * Read-only (RLS user client). The REAL Asana state of these flags: the
 * saved task link on the flag plus the live create job. NEVER throws.
 *
 * A failed read is reported as 'unknown' — never as "not sent":
 *   - flags read failed   -> every flag 'unknown' (cannot tell deleted either);
 *   - outbox read failed  -> 'in_asana' where a link is saved, else 'unknown'.
 */
export async function loadFlagAsanaStatuses(
  supabase: SupabaseClient,
  companyId: string,
  flagIds: string[],
): Promise<FlagAsanaLookup> {
  const out: FlagAsanaLookup = new Map()
  if (flagIds.length === 0) return out
  const allUnknown = () => {
    for (const id of flagIds) out.set(id, 'unknown')
    return out
  }
  try {
    const [flagsRes, jobsRes] = await Promise.all([
      supabase
        .from('flags')
        .select('id, asana_task_url')
        .eq('company_id', companyId)
        .in('id', flagIds)
        .is('deleted_at', null),
      supabase
        .from('integration_outbox')
        .select('id, entity_id, status, created_at, deleted_at, provider, event_type, entity_type')
        .eq('company_id', companyId)
        .eq('provider', 'asana')
        // The flag's create job, whichever destination it is pinned to.
        .in('event_type', [...ALL_CREATE_EVENTS])
        .eq('entity_type', 'flag')
        .is('deleted_at', null)
        .in('entity_id', flagIds),
    ])
    if (flagsRes.error || !Array.isArray(flagsRes.data)) return allUnknown()

    const urlByFlag = new Map<string, string | null>()
    for (const f of flagsRes.data) urlByFlag.set(f.id as string, (f.asana_task_url as string | null) ?? null)
    const jobsOk = !jobsRes.error && Array.isArray(jobsRes.data)
    const jobRows = (jobsOk ? jobsRes.data : []) as CreateJobRow[]

    for (const id of flagIds) {
      if (!urlByFlag.has(id)) {
        out.set(id, 'deleted')
        continue
      }
      out.set(
        id,
        asanaIssueStatus({
          asanaTaskUrl: urlByFlag.get(id),
          createJob: jobsOk ? pickCreateJob(jobRows, id) : 'unknown',
        }),
      )
    }
    await applyAwaitingHandoff(supabase, companyId, out)
    return out
  } catch {
    return allUnknown()
  }
}

/** Must match asana_flags_awaiting_handoff() (migration 20261123120000). */
export const ASANA_HANDOFF_RECONCILE_DAYS = 14

/**
 * "Not sent" is only final when the issue was never expected in Asana. An
 * issue stamped asana_handoff_expected with no job yet is picked up by the
 * worker's reconciliation, so it is shown as on its way ('queued', polled)
 * while inside the reconciliation window, and 'needs_attention' after it.
 * Tolerant: if this read fails (or the column does not exist yet), the
 * statuses are left exactly as they were.
 */
async function applyAwaitingHandoff(supabase: SupabaseClient, companyId: string, out: FlagAsanaLookup): Promise<void> {
  const candidates = [...out].filter(([, st]) => st === 'not_sent').map(([id]) => id)
  if (candidates.length === 0) return
  try {
    const { data, error } = await supabase
      .from('flags')
      .select('id, asana_handoff_expected, created_at')
      .eq('company_id', companyId)
      .in('id', candidates)
    if (error || !Array.isArray(data)) return
    const cutoff = Date.now() - ASANA_HANDOFF_RECONCILE_DAYS * 24 * 60 * 60 * 1000
    for (const row of data as Array<{ id: string; asana_handoff_expected?: unknown; created_at?: unknown }>) {
      if (row.asana_handoff_expected !== true || out.get(row.id) !== 'not_sent') continue
      const created = typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN
      out.set(row.id, Number.isFinite(created) && created > cutoff ? 'queued' : 'needs_attention')
    }
  } catch {
    // leave statuses unchanged
  }
}

/**
 * Read-only (RLS user client). Issues already reported from these pack
 * photos, grouped by pack photo id, oldest first, with an honest Asana status.
 *
 * NEVER throws and never blocks the pack page: if the issue table is not
 * there yet (migration pending) or its read fails, it returns {} and the
 * page simply shows no saved issues. Deleted issues are left out.
 */
export async function loadPackPhotoIssues(
  supabase: SupabaseClient,
  companyId: string,
  packPhotoIds: string[],
): Promise<Record<string, PackPhotoIssue[]>> {
  if (packPhotoIds.length === 0) return {}
  try {
    const { data: rows, error } = await supabase
      .from('flag_issue_selections')
      .select('flag_id, source_pack_photo_id, created_at')
      .eq('company_id', companyId)
      .in('source_pack_photo_id', packPhotoIds)
      .order('created_at', { ascending: true })
      .order('flag_id', { ascending: true })
    if (error || !rows || rows.length === 0) return {}

    const statuses = await loadFlagAsanaStatuses(
      supabase,
      companyId,
      rows.map((r) => r.flag_id as string),
    )

    const out: Record<string, PackPhotoIssue[]> = {}
    for (const r of rows) {
      const flagId = r.flag_id as string
      const photoId = r.source_pack_photo_id as string | null
      const status = statuses.get(flagId) ?? 'unknown'
      if (!photoId || status === 'deleted') continue
      ;(out[photoId] ??= []).push({ flagId, asanaStatus: status })
    }
    return out
  } catch {
    return {}
  }
}
