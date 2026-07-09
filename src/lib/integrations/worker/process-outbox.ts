/**
 * Asana outbox worker — DRY-RUN core (Slice 7).
 *
 * Reads ONE pending Asana outbox row, re-reads the authoritative flag
 * (and its property / category / reporter) from the DB, runs the
 * company allowlist guard, builds the exact task payload, and asserts
 * the pinned BETA project — then RETURNS the payload it WOULD send.
 *
 * It makes NO Asana call and performs NO writes: no claim, no status
 * update, no external_task_links, no flags update. The outbox row is
 * left untouched (still pending) so a later real run can process it.
 *
 * Source of truth: the row's `payload` hints are deliberately NOT
 * selected — every field comes from a fresh DB read.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assertAllowedCompany,
  DisallowedCompanyError,
} from '@/lib/integrations/company-allowlist'
import { assertAllowedProject } from '@/lib/integrations/asana/config'
import { mapFlagToTaskPayload } from '@/lib/integrations/asana/mapping'
import {
  buildFlagForMapping,
  type OutboxFlagRow,
} from '@/lib/integrations/worker/build-flag-for-mapping'
import type { TaskPayload } from '@/lib/integrations/types'

export interface DryRunDeps {
  allowedCompanyIds: string[]
  appBaseUrl: string
  todayIso?: string
}

export type DryRunResult =
  | { status: 'no_pending' }
  | { status: 'refused'; outboxId: string; reason: string; flagId?: string }
  | { status: 'dry_run_ok'; outboxId: string; flagId: string; payload: TaskPayload }

export async function dryRunNextAsanaOutbox(
  supabase: SupabaseClient,
  deps: DryRunDeps,
): Promise<DryRunResult> {
  // 1. Read ONE pending Asana outbox row. `payload` is intentionally NOT
  //    selected — authoritative data is re-read from the flag below.
  //    No claim, no status change.
  const nowIso = new Date().toISOString()
  const { data: outboxRows, error: outboxErr } = await supabase
    .from('integration_outbox')
    .select('id, company_id, entity_type, entity_id, status')
    .eq('provider', 'asana')
    .eq('status', 'pending')
    .is('deleted_at', null)
    .lte('available_at', nowIso)
    .order('available_at', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1)

  if (outboxErr) throw new Error(`outbox read failed: ${outboxErr.message}`)
  const outbox = outboxRows?.[0]
  if (!outbox) return { status: 'no_pending' }

  const outboxId = String(outbox.id)
  const companyId = String(outbox.company_id)
  const flagId = String(outbox.entity_id)

  // 2. Company allowlist guard (fail closed).
  try {
    assertAllowedCompany(companyId, deps.allowedCompanyIds)
  } catch (err) {
    if (err instanceof DisallowedCompanyError) {
      return { status: 'refused', outboxId, reason: 'company not on allowlist' }
    }
    throw err
  }

  // 3. Re-read authoritative flag data from the DB (never the payload).
  const { data: flag, error: flagErr } = await supabase
    .from('flags')
    .select(
      'id, description, severity, status, chargeable_party_decision, raised_at, property_id, flag_category_id, raised_by',
    )
    .eq('id', flagId)
    .is('deleted_at', null)
    .maybeSingle()

  if (flagErr) throw new Error(`flag re-read failed: ${flagErr.message}`)
  if (!flag) return { status: 'refused', outboxId, flagId, reason: 'flag not found' }

  const [{ data: property }, { data: category }, reporterRes] = await Promise.all([
    supabase.from('properties').select('name').eq('id', flag.property_id).maybeSingle(),
    supabase
      .from('flag_categories')
      .select('key, display_label')
      .eq('id', flag.flag_category_id)
      .maybeSingle(),
    flag.raised_by
      ? supabase.from('profiles').select('full_name').eq('id', flag.raised_by).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const reporter = (reporterRes?.data ?? null) as { full_name?: string } | null

  const dbRow: OutboxFlagRow = {
    id: String(flag.id),
    description: String(flag.description ?? ''),
    severity: (flag.severity as OutboxFlagRow['severity']) ?? 'low',
    status: String(flag.status ?? ''),
    accountability: (flag.chargeable_party_decision as string | null) ?? null,
    raisedAtIso: String(flag.raised_at ?? ''),
    propertyId: String(flag.property_id),
    propertyName: String(property?.name ?? 'Unknown property'),
    categoryKey: String(category?.key ?? ''),
    categoryLabel: String(category?.display_label ?? 'Uncategorised'),
    reporterName: reporter?.full_name ?? null,
  }

  // 4. Build the exact payload; assert the pinned BETA project BEFORE any
  //    future write path could exist.
  const forMapping = buildFlagForMapping(dbRow, {
    appBaseUrl: deps.appBaseUrl,
    todayIso: deps.todayIso,
  })
  const payload = mapFlagToTaskPayload(forMapping)
  assertAllowedProject(payload.projectGid)

  // 5. DRY RUN — return the payload we WOULD send. No Asana call, no writes.
  return { status: 'dry_run_ok', outboxId, flagId: forMapping.id, payload }
}
