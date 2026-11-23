/**
 * Asana handoff reconciliation (migration 20261123120000).
 *
 * Every new issue in a company with Asana switched on is stamped
 * `asana_handoff_expected` by the database. Normally the app enqueues its
 * Asana job straight away. If that did not happen — the classification
 * could not be read, the enqueue failed, or the response was lost / the
 * function died after the issue was saved — the issue is still expected
 * and has NO Asana job. This pass finds such issues (oldest first, at least
 * 2 minutes old so the app's own enqueue is never raced) and enqueues them.
 *
 * - The destination is decided from the STORED classification with the
 *   app's own rule (chooseDestinationForNewFlag): a test issue always goes
 *   to BETA; the database refuses a live job for it anyway.
 * - The rows are built with the app's own builders and inserted by the
 *   validated, service-role-only function enqueue_asana_handoff(), so the
 *   worker needs no INSERT grant on the outbox.
 * - Idempotent: a flag that gained a job meanwhile is a no-op
 *   ('already_has_job'); the unique indexes refuse a second task.
 * - NEVER throws; one bad row never stops the others.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { chooseDestinationForNewFlag } from '@/lib/integrations/asana/destinations'
import { buildAttachEvidenceEvent, buildFlagOutboxEvent } from '@/lib/integrations/outbox'

export type AwaitingHandoffRow = {
  flag_id: string
  company_id: string
  property_id: string
  raised_by: string
  is_test: boolean
  category_key: string
  is_pack_photo_issue: boolean
  has_photos: boolean
}

export type HandoffOutcome = 'enqueued' | 'already_has_job' | 'not_expected' | 'failed'
export type ReconcileReport = { ok: boolean; checked: number; outcomes: Array<{ flagId: string; outcome: HandoffOutcome }> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validRow(r: unknown): r is AwaitingHandoffRow {
  const x = r as Partial<AwaitingHandoffRow> | null
  return !!x && [x.flag_id, x.company_id, x.property_id, x.raised_by].every((v) => typeof v === 'string' && UUID_RE.test(v))
    && typeof x.is_test === 'boolean' && typeof x.category_key === 'string'
    && typeof x.is_pack_photo_issue === 'boolean' && typeof x.has_photos === 'boolean'
}

/** PURE. The job rows for one awaiting flag, mirroring what the app enqueues. */
export function handoffJobsFor(row: AwaitingHandoffRow) {
  const destination = chooseDestinationForNewFlag({
    companyId: row.company_id,
    propertyId: row.property_id,
    isPackPhotoIssue: row.is_pack_photo_issue,
    isTest: row.is_test,
  })
  const input = {
    companyId: row.company_id,
    flagId: row.flag_id,
    createdBy: row.raised_by,
    payload: { property_id: row.property_id, category_key: row.category_key },
  }
  // Live: create + attach (as the app's live path). BETA: create, plus
  // attach when the issue has photos (as the photo path); a BETA issue
  // without photos gets create only (as the form path).
  const withAttach = destination !== 'beta' || row.has_photos
  const jobs = [buildFlagOutboxEvent(input, destination)]
  if (withAttach) jobs.push(buildAttachEvidenceEvent(input, destination))
  return { destination, jobs }
}

export async function reconcileAsanaHandoffs(supabase: SupabaseClient, limit = 10): Promise<ReconcileReport> {
  const report: ReconcileReport = { ok: true, checked: 0, outcomes: [] }
  let rows: unknown[]
  try {
    const { data, error } = await supabase.rpc('asana_flags_awaiting_handoff', { p_limit: limit, p_min_age_seconds: 120 })
    if (error || !Array.isArray(data)) return { ...report, ok: false }
    rows = data
  } catch {
    return { ...report, ok: false }
  }
  for (const raw of rows) {
    if (!validRow(raw)) continue
    report.checked += 1
    let outcome: HandoffOutcome = 'failed'
    try {
      const { jobs } = handoffJobsFor(raw)
      const { data, error } = await supabase.rpc('enqueue_asana_handoff', { p_flag_id: raw.flag_id, p_jobs: jobs })
      if (!error && (data === 'enqueued' || data === 'already_has_job' || data === 'not_expected')) outcome = data
    } catch {
      outcome = 'failed'
    }
    // 'failed' leaves the issue awaiting: the next run tries again.
    report.outcomes.push({ flagId: raw.flag_id, outcome })
  }
  return report
}

/**
 * Record that the reconciliation pass ran (and whether its lookup worked),
 * so managers can tell "nothing is wrong" from "the checker is not
 * running". Timestamps only. NEVER throws.
 */
export async function recordReconcileHeartbeat(supabase: SupabaseClient, ok: boolean): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('record_worker_heartbeat', { p_worker: 'asana_reconcile', p_ok: ok })
    return !error
  } catch {
    return false
  }
}
