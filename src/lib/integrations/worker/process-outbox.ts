/**
 * Asana outbox worker core (Slices 7 + 8 + 10).
 *
 * `dryRunNextAsanaOutbox` — reads one pending row, guards, re-reads the
 * authoritative flag, builds the payload, and RETURNS it. No Asana
 * call, no writes.
 *
 * `runNextAsanaOutbox` — the real run for ONE row: read/guard →
 * **atomic claim** (pending→processing, only one worker wins) →
 * idempotency pre-check → create the task → write-backs
 * (external_task_links → flags.asana_task_url → outbox done). Failures
 * reset to pending with backoff (capped → dead); a disallowed company
 * or missing flag retires the row (dead) so it can't block the queue.
 *
 * `runAsanaOutboxBatch` — recovers stale (crashed) claims, then
 * processes up to N rows for a scheduled (cron) tick.
 *
 * Source of truth: the row's `payload` hints are never selected — every
 * field comes from a fresh DB read. `integration_outbox.status` is
 * free-text (no CHECK), so 'processing'/'dead' are valid values.
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
import type { TaskPayload, TaskProvider } from '@/lib/integrations/types'

/** Give up (mark dead) after this many failed attempts. */
const MAX_ATTEMPTS = 8
/** Wait this long before retrying a failed row. */
const RETRY_BACKOFF_MINUTES = 5
/** Reclaim a row stuck in 'processing' (crashed worker) after this long. */
const STALE_PROCESSING_MINUTES = 5

export interface DryRunDeps {
  allowedCompanyIds: string[]
  appBaseUrl: string
  todayIso?: string
}

export type DryRunResult =
  | { status: 'no_pending' }
  | { status: 'refused'; outboxId: string; reason: string; flagId?: string }
  | { status: 'dry_run_ok'; outboxId: string; flagId: string; payload: TaskPayload }

export type RealRunResult =
  | { status: 'no_pending' }
  | { status: 'refused'; outboxId: string; reason: string; flagId?: string }
  | { status: 'skipped'; outboxId: string; flagId: string }
  | { status: 'already_linked'; outboxId: string; flagId: string }
  | {
      status: 'created'
      outboxId: string
      flagId: string
      externalTaskGid: string
      externalTaskUrl: string
    }
  | { status: 'error'; outboxId: string; flagId: string; error: string }

type GuardOutcome =
  | { kind: 'no_pending' }
  | { kind: 'refused'; outboxId: string; reason: string }
  | { kind: 'ok'; outboxId: string; companyId: string; flagId: string; attemptCount: number }

/** Read ONE pending Asana outbox row and run the company allowlist guard. */
async function readAndGuardOutbox(
  supabase: SupabaseClient,
  deps: DryRunDeps,
): Promise<GuardOutcome> {
  const nowIso = new Date().toISOString()
  const { data: rows, error } = await supabase
    .from('integration_outbox')
    .select('id, company_id, entity_type, entity_id, status, attempt_count')
    .eq('provider', 'asana')
    .eq('status', 'pending')
    .is('deleted_at', null)
    .lte('available_at', nowIso)
    .order('available_at', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1)

  if (error) throw new Error(`outbox read failed: ${error.message}`)
  const outbox = rows?.[0]
  if (!outbox) return { kind: 'no_pending' }

  const outboxId = String(outbox.id)
  const companyId = String(outbox.company_id)
  const flagId = String(outbox.entity_id)
  const attemptCount = Number(outbox.attempt_count ?? 0)

  try {
    assertAllowedCompany(companyId, deps.allowedCompanyIds)
  } catch (err) {
    if (err instanceof DisallowedCompanyError) {
      return { kind: 'refused', outboxId, reason: 'company not on allowlist' }
    }
    throw err
  }

  return { kind: 'ok', outboxId, companyId, flagId, attemptCount }
}

/** Re-read authoritative flag data and build the task payload. Null = flag not found. */
async function buildPayloadForFlag(
  supabase: SupabaseClient,
  flagId: string,
  deps: DryRunDeps,
): Promise<TaskPayload | null> {
  const { data: flag, error: flagErr } = await supabase
    .from('flags')
    .select(
      'id, description, issue_title, severity, status, chargeable_party_decision, raised_at, property_id, flag_category_id, raised_by',
    )
    .eq('id', flagId)
    .is('deleted_at', null)
    .maybeSingle()

  if (flagErr) throw new Error(`flag re-read failed: ${flagErr.message}`)
  if (!flag) return null

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
    issueTitle: (flag.issue_title as string | null) ?? null,
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

  const forMapping = buildFlagForMapping(dbRow, {
    appBaseUrl: deps.appBaseUrl,
    todayIso: deps.todayIso,
  })
  const payload = mapFlagToTaskPayload(forMapping)
  assertAllowedProject(payload.projectGid)
  return payload
}

async function markOutbox(
  supabase: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase.from('integration_outbox').update(patch).eq('id', id)
}

/** Record a failure: retry with backoff, or retire to 'dead' at the cap. */
async function failRetry(
  supabase: SupabaseClient,
  outboxId: string,
  flagId: string,
  attemptCount: number,
  message: string,
): Promise<RealRunResult> {
  const attempts = attemptCount + 1
  const dead = attempts >= MAX_ATTEMPTS
  const patch: Record<string, unknown> = {
    status: dead ? 'dead' : 'pending',
    attempt_count: attempts,
    last_error: message,
    locked_at: null,
  }
  if (!dead) {
    patch.available_at = new Date(Date.now() + RETRY_BACKOFF_MINUTES * 60_000).toISOString()
  }
  await markOutbox(supabase, outboxId, patch)
  return { status: 'error', outboxId, flagId, error: message }
}

/** Recover rows whose worker crashed mid-run (stuck in 'processing'). */
async function resetStaleProcessing(supabase: SupabaseClient): Promise<void> {
  const staleIso = new Date(Date.now() - STALE_PROCESSING_MINUTES * 60_000).toISOString()
  await supabase
    .from('integration_outbox')
    .update({ status: 'pending', locked_at: null })
    .eq('provider', 'asana')
    .eq('status', 'processing')
    .lt('locked_at', staleIso)
}

export async function dryRunNextAsanaOutbox(
  supabase: SupabaseClient,
  deps: DryRunDeps,
): Promise<DryRunResult> {
  const g = await readAndGuardOutbox(supabase, deps)
  if (g.kind === 'no_pending') return { status: 'no_pending' }
  if (g.kind === 'refused') return { status: 'refused', outboxId: g.outboxId, reason: g.reason }

  const payload = await buildPayloadForFlag(supabase, g.flagId, deps)
  if (!payload) {
    return { status: 'refused', outboxId: g.outboxId, flagId: g.flagId, reason: 'flag not found' }
  }
  return { status: 'dry_run_ok', outboxId: g.outboxId, flagId: g.flagId, payload }
}

export async function runNextAsanaOutbox(
  supabase: SupabaseClient,
  provider: TaskProvider,
  deps: DryRunDeps,
): Promise<RealRunResult> {
  const g = await readAndGuardOutbox(supabase, deps)
  if (g.kind === 'no_pending') return { status: 'no_pending' }
  if (g.kind === 'refused') {
    // Permanent (e.g. company not on allowlist): retire the row so it
    // can't block the queue on every tick.
    await markOutbox(supabase, g.outboxId, {
      status: 'dead',
      last_error: g.reason,
      locked_at: null,
    })
    return { status: 'refused', outboxId: g.outboxId, reason: g.reason }
  }

  const { outboxId, companyId, flagId, attemptCount } = g

  // Atomic claim: flip pending -> processing. Because the WHERE requires
  // status='pending', only ONE concurrent worker wins — so overlapping
  // cron runs can never both create the same task.
  const { data: claimed, error: claimErr } = await supabase
    .from('integration_outbox')
    .update({ status: 'processing', locked_at: new Date().toISOString() })
    .eq('id', outboxId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`)
  if (!claimed) return { status: 'skipped', outboxId, flagId }

  // Idempotency pre-check: an active link means the task already exists.
  const { data: existingLink, error: linkReadErr } = await supabase
    .from('external_task_links')
    .select('id')
    .eq('provider', 'asana')
    .eq('internal_entity_type', 'flag')
    .eq('internal_entity_id', flagId)
    .is('deleted_at', null)
    .maybeSingle()
  if (linkReadErr) throw new Error(`link pre-check failed: ${linkReadErr.message}`)
  if (existingLink) {
    await markOutbox(supabase, outboxId, {
      status: 'done',
      processed_at: new Date().toISOString(),
      locked_at: null,
    })
    return { status: 'already_linked', outboxId, flagId }
  }

  const payload = await buildPayloadForFlag(supabase, flagId, deps)
  if (!payload) {
    await markOutbox(supabase, outboxId, {
      status: 'dead',
      last_error: 'flag not found',
      locked_at: null,
    })
    return { status: 'refused', outboxId, flagId, reason: 'flag not found' }
  }

  // Create the task. The provider asserts the project before any call.
  let created: { externalTaskGid: string; externalTaskUrl: string }
  try {
    created = await provider.createTask(payload)
  } catch (err) {
    return failRetry(
      supabase,
      outboxId,
      flagId,
      attemptCount,
      err instanceof Error ? err.message : String(err),
    )
  }

  // Write-back: link first (idempotent), then flag, then outbox done.
  const { error: insertErr } = await supabase.from('external_task_links').insert({
    company_id: companyId,
    provider: 'asana',
    internal_entity_type: 'flag',
    internal_entity_id: flagId,
    external_workspace_gid: payload.workspaceGid,
    external_project_gid: payload.projectGid,
    external_task_gid: created.externalTaskGid,
    external_task_url: created.externalTaskUrl,
    sync_status: 'linked',
    last_synced_at: new Date().toISOString(),
  })
  if (insertErr && insertErr.code !== '23505') {
    return failRetry(
      supabase,
      outboxId,
      flagId,
      attemptCount,
      `link insert failed: ${insertErr.message}`,
    )
  }

  await supabase
    .from('flags')
    .update({ asana_task_url: created.externalTaskUrl })
    .eq('id', flagId)

  await markOutbox(supabase, outboxId, {
    status: 'done',
    processed_at: new Date().toISOString(),
    locked_at: null,
  })

  return {
    status: 'created',
    outboxId,
    flagId,
    externalTaskGid: created.externalTaskGid,
    externalTaskUrl: created.externalTaskUrl,
  }
}

/**
 * Process up to `batchSize` pending rows in one (cron) tick. Recovers
 * stale claims first, then loops, stopping early when the queue empties.
 */
export async function runAsanaOutboxBatch(
  supabase: SupabaseClient,
  provider: TaskProvider,
  deps: DryRunDeps,
  batchSize: number,
): Promise<RealRunResult[]> {
  await resetStaleProcessing(supabase)
  const results: RealRunResult[] = []
  const limit = Math.max(1, batchSize)
  for (let i = 0; i < limit; i++) {
    const result = await runNextAsanaOutbox(supabase, provider, deps)
    results.push(result)
    if (result.status === 'no_pending') break
  }
  return results
}
