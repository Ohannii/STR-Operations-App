/**
 * CONTROLLED LIVE TEST gate — THE eligibility rule for a live-destination
 * job, shared by task creation AND attachments (one rule, two callers).
 *
 * Re-checked from the DATABASE on every run; nothing in the outbox payload
 * is trusted for it:
 *   - the job's own record agrees with its event type (the pin);
 *   - the flag exists in the job's company, and company + property are the
 *     test scope (Test 1);
 *   - the flag is a pack-photo issue (saved selections with a source photo);
 *   - the flag has no CREATE job for the other destination.
 *
 * Returns null when the job may proceed; otherwise a stable, value-free
 * code and whether it is `permanent` (retire the job) or a failed read
 * (retry later — never proceed on an unknown).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isInLiveTestScope,
  otherDestination,
  payloadPinMatches,
  type AsanaDestination,
} from '@/lib/integrations/asana/destinations'

export const LIVE_TEST_CODES = {
  switchedOff: 'live_test:switched_off',
  pinMismatch: 'live_test:destination_pin_mismatch',
  outOfScope: 'live_test:out_of_scope',
  notPackPhotoIssue: 'live_test:not_pack_photo_issue',
  otherDestinationJob: 'live_test:other_destination_job',
  scopeReadFailed: 'live_test:scope_read_failed',
} as const

export type LiveTestRefusal = { code: string; permanent: boolean }

export async function liveTestRefusal(
  supabase: SupabaseClient,
  dest: AsanaDestination,
  job: { companyId: string; flagId: string; payload: Record<string, unknown> },
): Promise<LiveTestRefusal | null> {
  if (!payloadPinMatches(dest.key, job.payload)) {
    return { code: LIVE_TEST_CODES.pinMismatch, permanent: true }
  }
  const retry = { code: LIVE_TEST_CODES.scopeReadFailed, permanent: false }
  try {
    const { data: flag, error: flagErr } = await supabase
      .from('flags')
      .select('id, company_id, property_id')
      .eq('id', job.flagId)
      .is('deleted_at', null)
      .maybeSingle()
    if (flagErr) return retry
    const f = flag as { company_id?: unknown; property_id?: unknown } | null
    if (
      !f ||
      f.company_id !== job.companyId ||
      !isInLiveTestScope({ companyId: f.company_id, propertyId: f.property_id })
    ) {
      return { code: LIVE_TEST_CODES.outOfScope, permanent: true }
    }

    const { data: sel, error: selErr } = await supabase
      .from('flag_issue_selections')
      .select('flag_id, source_pack_photo_id')
      .eq('flag_id', job.flagId)
      .eq('company_id', job.companyId)
      .maybeSingle()
    if (selErr) return retry
    const source = (sel as { source_pack_photo_id?: unknown } | null)?.source_pack_photo_id
    if (typeof source !== 'string' || !source) {
      return { code: LIVE_TEST_CODES.notPackPhotoIssue, permanent: true }
    }

    const { data: other, error: otherErr } = await supabase
      .from('integration_outbox')
      .select('id')
      .eq('company_id', job.companyId)
      .eq('provider', 'asana')
      .eq('event_type', otherDestination(dest.key).createEvent)
      .eq('entity_type', 'flag')
      .eq('entity_id', job.flagId)
      .is('deleted_at', null)
      .limit(1)
    if (otherErr || !Array.isArray(other)) return retry
    if (other.length > 0) return { code: LIVE_TEST_CODES.otherDestinationJob, permanent: true }
    return null
  } catch {
    return retry
  }
}
