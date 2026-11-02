/**
 * Asana outbox worker core (Slices 7 + 8 + 10; Stage 0 idempotency).
 *
 * `dryRunNextAsanaOutbox` — reads one pending row, guards, re-reads the
 * authoritative flag, builds the payload, and RETURNS it. No Asana call,
 * no writes.
 *
 * `runNextAsanaOutbox` — the real run for ONE row. Stage 0 makes task
 * creation idempotent as far as Asana allows (no idempotency key exists):
 *
 *   claim (pending -> processing, locked_by = this run's token)
 *     -> existing link (same company + flag)?
 *                                  restore flags.asana_task_url from it,
 *                                  THEN done. No Asana call.
 *     -> saved created_task_gid?   READ it; verify marker + BETA; finish.
 *                                  Missing / mismatched -> manual review.
 *                                  NEVER recreated automatically.
 *     -> attempt recorded, or a legacy row?
 *                                  READ-ONLY marker lookup in BETA:
 *                                    1 match  -> adopt it
 *                                    2+       -> manual review (no delete)
 *                                    0        -> count it; a replacement
 *                                                create only after the
 *                                                two-check quarantine
 *                                    failure  -> reschedule, no create
 *     -> record the attempt FIRST (conditional write), THEN create with
 *        atomic project + section membership, THEN save the task GID,
 *        THEN link, flag URL and done.
 *
 * Write-backs: the row is marked done ONLY after the link is proven to
 * point at THIS task and flags.asana_task_url was confirmed written. A
 * failed write-back retries with created_task_gid kept, so the retry never
 * creates another task; a link that points at a DIFFERENT task stops for
 * manual review without touching the flag URL or either task.
 *
 * Every outbox write after the claim is CONDITIONAL on (row id, status
 * 'processing', locked_by = this run) and must RETURN that row's id. If it
 * does not prove exactly that row was updated, the run aborts — and in
 * particular no create request is ever sent. Refused rows are claimed the
 * same way before they are retired, so no terminal write is unconditional.
 *
 * Attempts: only failRetry() increments attempt_count. The claim, the
 * reschedule (429 / quarantine) and every other write never touch it, so a
 * 429 can neither consume nor refund an attempt.
 *
 * `runAsanaOutboxBatch` — recovers stale (crashed) claims, then processes
 * up to N rows for a scheduled (cron) tick.
 *
 * Source of truth: every flag field comes from a fresh DB read. Worker
 * state lives in integration_outbox.payload (JSONB) alongside, never
 * replacing, the enqueue hints. `integration_outbox.status` is free-text,
 * so 'processing' / 'dead' are valid values. Errors are stored and
 * returned as stable codes — never response bodies, notes or markers.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assertAllowedCompany,
  DisallowedCompanyError,
} from '@/lib/integrations/company-allowlist'
import { assertAllowedProject } from '@/lib/integrations/asana/config'
import { mapFlagToTaskPayload } from '@/lib/integrations/asana/mapping'
import { taskUrlForGid } from '@/lib/integrations/asana/client'
import {
  buildFlagForMapping,
  type OutboxFlagRow,
} from '@/lib/integrations/worker/build-flag-for-mapping'
import {
  CODES,
  LOOKUP_MARGIN_MS,
  classifyCallError,
  clearAttempt,
  exactMarkerMatches,
  flagMarkerLine,
  LEGACY_MARKER,
  mergeCreateState,
  mustReconcile,
  nextReconcileDelayMs,
  readCreateState,
  recordNotFound,
  replacementPermitted,
  resolveMatcher,
  startAttempt,
  CREATE_PROTOCOL,
  type CreateState,
} from '@/lib/integrations/worker/create-idempotency'
import type { OutboxEventType, TaskPayload, TaskProvider } from '@/lib/integrations/types'

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
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number
  /** Injectable run-token generator. Defaults to crypto.randomUUID. */
  newRunId?: () => string
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
      status: 'created' | 'adopted'
      outboxId: string
      flagId: string
      externalTaskGid: string
      externalTaskUrl: string
    }
  /** No create: waiting for the next reconciliation (quarantine / 429). */
  | { status: 'rescheduled'; outboxId: string; flagId: string; code: string }
  /** Stopped for a person to look at. Task GIDs only — no values. */
  | { status: 'manual_review'; outboxId: string; flagId: string; code: string; taskGids?: string[] }
  /** This run no longer owns the row; it stopped without writing. */
  | { status: 'lost_lock'; outboxId: string; flagId: string }
  | { status: 'error'; outboxId: string; flagId: string; error: string }

export type GuardOutcome =
  | { kind: 'no_pending' }
  | { kind: 'refused'; outboxId: string; reason: string; flagId: string }
  | {
      kind: 'ok'
      outboxId: string
      companyId: string
      flagId: string
      attemptCount: number
      payload: Record<string, unknown>
      /** When the outbox row was enqueued (bounds the reconciliation lookup). */
      createdAt: string | null
    }

/**
 * Read ONE pending Asana outbox row of the given event type and run the
 * company allowlist guard. `eventType` scopes the queue so create-task and
 * attach-evidence events are drained independently.
 */
export async function readAndGuardOutbox(
  supabase: SupabaseClient,
  deps: DryRunDeps,
  eventType: OutboxEventType = 'asana.create_task_for_flag',
): Promise<GuardOutcome> {
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString()
  const { data: rows, error } = await supabase
    .from('integration_outbox')
    .select('id, company_id, entity_type, entity_id, status, attempt_count, payload, created_at')
    .eq('provider', 'asana')
    .eq('event_type', eventType)
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
  const payload = (outbox.payload ?? {}) as Record<string, unknown>
  const createdAt = typeof outbox.created_at === 'string' ? outbox.created_at : null

  try {
    assertAllowedCompany(companyId, deps.allowedCompanyIds)
  } catch (err) {
    if (err instanceof DisallowedCompanyError) {
      return { kind: 'refused', outboxId, reason: 'company not on allowlist', flagId }
    }
    throw err
  }

  return { kind: 'ok', outboxId, companyId, flagId, attemptCount, payload, createdAt }
}

/** Re-read authoritative flag data and build the task payload. Null = flag not found. */
async function buildPayloadForFlag(
  supabase: SupabaseClient,
  flagId: string,
  deps: DryRunDeps,
): Promise<{ payload: TaskPayload; propertyId: string } | null> {
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
  return { payload, propertyId: dbRow.propertyId }
}

/**
 * Atomic claim: pending -> processing, stamped with this run's token. True
 * only when the update RETURNED exactly this row's id.
 */
async function claimRow(
  supabase: SupabaseClient,
  outboxId: string,
  runId: string,
  nowMs: number,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('integration_outbox')
    .update({ status: 'processing', locked_at: new Date(nowMs).toISOString(), locked_by: runId })
    .eq('id', outboxId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`claim failed: ${error.message}`)
  return isRow(data, outboxId)
}

/**
 * Conditional update of a CLAIMED row: exact id + status 'processing' +
 * this run's lock token. True only when the update returned exactly this
 * row's id (maybeSingle errors on more than one row; null = none updated).
 */
async function ownedWrite(
  supabase: SupabaseClient,
  outboxId: string,
  runId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('integration_outbox')
    .update(patch)
    .eq('id', outboxId)
    .eq('status', 'processing')
    .eq('locked_by', runId)
    .select('id')
    .maybeSingle()
  return !error && isRow(data, outboxId)
}

function isRow(data: unknown, outboxId: string): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    String((data as { id?: unknown }).id) === outboxId
  )
}

/** Recover rows whose worker crashed mid-run (stuck in 'processing'). */
async function resetStaleProcessing(supabase: SupabaseClient, nowMs: number): Promise<void> {
  const staleIso = new Date(nowMs - STALE_PROCESSING_MINUTES * 60_000).toISOString()
  await supabase
    .from('integration_outbox')
    .update({ status: 'pending', locked_at: null, locked_by: null })
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

  const built = await buildPayloadForFlag(supabase, g.flagId, deps)
  if (!built) {
    return { status: 'refused', outboxId: g.outboxId, flagId: g.flagId, reason: 'flag not found' }
  }
  return { status: 'dry_run_ok', outboxId: g.outboxId, flagId: g.flagId, payload: built.payload }
}

function defaultRunId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * One claimed row's run context. Every write is CONDITIONAL on the exact
 * row, status 'processing' and this run's lock token.
 */
class OwnedRow {
  constructor(
    private readonly supabase: SupabaseClient,
    readonly outboxId: string,
    readonly flagId: string,
    private readonly runId: string,
    private readonly attemptCount: number,
    private payload: Record<string, unknown>,
    private readonly nowMs: () => number,
  ) {}

  /** Conditional update; true only when THIS run still owns the row. */
  async write(patch: Record<string, unknown>): Promise<boolean> {
    return ownedWrite(this.supabase, this.outboxId, this.runId, patch)
  }

  /** Persist worker state (merged into the existing payload). */
  async saveState(state: CreateState): Promise<boolean> {
    const next = mergeCreateState(this.payload, state)
    const ok = await this.write({ payload: next })
    if (ok) this.payload = next
    return ok
  }

  private lostLock(): RealRunResult {
    return { status: 'lost_lock', outboxId: this.outboxId, flagId: this.flagId }
  }

  /** Failure that consumes an attempt (backoff; dead at the cap). */
  async failRetry(code: string, state: CreateState): Promise<RealRunResult> {
    const attempts = this.attemptCount + 1
    const dead = attempts >= MAX_ATTEMPTS
    const ok = await this.write({
      status: dead ? 'dead' : 'pending',
      attempt_count: attempts,
      last_error: code,
      locked_at: null,
      locked_by: null,
      payload: mergeCreateState(this.payload, state),
      ...(dead
        ? {}
        : { available_at: new Date(this.nowMs() + RETRY_BACKOFF_MINUTES * 60_000).toISOString() }),
    })
    if (!ok) return this.lostLock()
    return { status: 'error', outboxId: this.outboxId, flagId: this.flagId, error: code }
  }

  /**
   * Wait without consuming an attempt (quarantine, Retry-After). The patch
   * deliberately has NO attempt_count: nothing is consumed or refunded.
   */
  async reschedule(code: string, state: CreateState, delayMs: number): Promise<RealRunResult> {
    const ok = await this.write({
      status: 'pending',
      last_error: code,
      locked_at: null,
      locked_by: null,
      payload: mergeCreateState(this.payload, state),
      available_at: new Date(this.nowMs() + Math.max(0, delayMs)).toISOString(),
    })
    if (!ok) return this.lostLock()
    return { status: 'rescheduled', outboxId: this.outboxId, flagId: this.flagId, code }
  }

  /** Stop for manual review (existing terminal state + value-free code). */
  async manualReview(code: string, state: CreateState, taskGids?: string[]): Promise<RealRunResult> {
    const ok = await this.write({
      status: 'dead',
      last_error: code,
      locked_at: null,
      locked_by: null,
      payload: mergeCreateState(this.payload, state),
    })
    if (!ok) return this.lostLock()
    return {
      status: 'manual_review',
      outboxId: this.outboxId,
      flagId: this.flagId,
      code,
      ...(taskGids ? { taskGids } : {}),
    }
  }

  async done(state: CreateState): Promise<boolean> {
    return this.write({
      status: 'done',
      processed_at: new Date(this.nowMs()).toISOString(),
      locked_at: null,
      locked_by: null,
      payload: mergeCreateState(this.payload, state),
    })
  }
}

type ActiveLink = { gid: string | null; url: string | null }

/**
 * The ACTIVE link for exactly this company + flag (unique index
 * uq_external_task_links_internal_entity_active). `error` = read failed.
 */
async function readActiveLink(
  supabase: SupabaseClient,
  companyId: string,
  flagId: string,
): Promise<{ link: ActiveLink | null; error: boolean }> {
  const { data, error } = await supabase
    .from('external_task_links')
    .select('id, external_task_gid, external_task_url')
    .eq('company_id', companyId)
    .eq('provider', 'asana')
    .eq('internal_entity_type', 'flag')
    .eq('internal_entity_id', flagId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) return { link: null, error: true }
  if (!data) return { link: null, error: false }
  const d = data as { external_task_gid?: unknown; external_task_url?: unknown }
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)
  return { link: { gid: str(d.external_task_gid), url: str(d.external_task_url) }, error: false }
}

/**
 * Write flags.asana_task_url for exactly this company's flag. True only
 * when the update succeeded AND returned this flag's id.
 */
async function writeFlagTaskUrl(
  supabase: SupabaseClient,
  companyId: string,
  flagId: string,
  taskUrl: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('flags')
    .update({ asana_task_url: taskUrl })
    .eq('id', flagId)
    .eq('company_id', companyId)
    .select('id')
    .maybeSingle()
  return !error && isRow(data, flagId)
}

/**
 * The write-backs once the task GID is known (created, adopted or saved):
 * link -> flag URL -> outbox done, in that order, each CHECKED.
 *   - 23505 on the link is NOT success by itself: the active link for this
 *     company + flag is re-read and must point at THIS task; otherwise
 *     manual review (flag URL untouched, nothing deleted).
 *   - A failed flag URL write retries; done is never written before it.
 * Every failure keeps created_task_gid, so the retry REUSES the task and
 * never creates another.
 */
async function finishWithTask(
  supabase: SupabaseClient,
  row: OwnedRow,
  companyId: string,
  payload: TaskPayload,
  state: CreateState,
  taskGid: string,
  taskUrl: string,
  status: 'created' | 'adopted',
): Promise<RealRunResult> {
  const { error: insertErr } = await supabase.from('external_task_links').insert({
    company_id: companyId,
    provider: 'asana',
    internal_entity_type: 'flag',
    internal_entity_id: row.flagId,
    external_workspace_gid: payload.workspaceGid,
    external_project_gid: payload.projectGid,
    external_task_gid: taskGid,
    external_task_url: taskUrl,
    sync_status: 'linked',
    last_synced_at: new Date().toISOString(),
  })
  if (insertErr && insertErr.code !== '23505') {
    return row.failRetry(CODES.linkInsertFailed, state)
  }
  if (insertErr) {
    // Unique violation: something is already linked. Prove it is THIS task.
    const { link, error } = await readActiveLink(supabase, companyId, row.flagId)
    if (error) return row.failRetry(CODES.linkReadFailed, state)
    if (!link || link.gid !== taskGid) {
      const gids = [taskGid, ...(link?.gid ? [link.gid] : [])]
      return row.manualReview(CODES.manualLinkConflict, state, gids)
    }
  }

  if (!(await writeFlagTaskUrl(supabase, companyId, row.flagId, taskUrl))) {
    return row.failRetry(CODES.flagUrlUpdateFailed, state)
  }

  if (!(await row.done(state))) {
    return { status: 'lost_lock', outboxId: row.outboxId, flagId: row.flagId }
  }
  return {
    status,
    outboxId: row.outboxId,
    flagId: row.flagId,
    externalTaskGid: taskGid,
    externalTaskUrl: taskUrl,
  }
}

export async function runNextAsanaOutbox(
  supabase: SupabaseClient,
  provider: TaskProvider,
  deps: DryRunDeps,
): Promise<RealRunResult> {
  const now = deps.now ?? Date.now
  const g = await readAndGuardOutbox(supabase, deps)
  if (g.kind === 'no_pending') return { status: 'no_pending' }
  const runId = (deps.newRunId ?? defaultRunId)()

  if (g.kind === 'refused') {
    // Permanent (e.g. company not on allowlist): retire the row so it
    // can't block the queue on every tick — claimed first, then retired by
    // a conditional write, like every other terminal write.
    if (!(await claimRow(supabase, g.outboxId, runId, now()))) {
      return { status: 'skipped', outboxId: g.outboxId, flagId: g.flagId }
    }
    const retired = await ownedWrite(supabase, g.outboxId, runId, {
      status: 'dead',
      last_error: g.reason,
      locked_at: null,
      locked_by: null,
    })
    if (!retired) return { status: 'lost_lock', outboxId: g.outboxId, flagId: g.flagId }
    return { status: 'refused', outboxId: g.outboxId, reason: g.reason }
  }

  const { outboxId, companyId, flagId, attemptCount } = g

  // Atomic claim. Only ONE concurrent worker wins; every later write is
  // conditional on it.
  if (!(await claimRow(supabase, outboxId, runId, now()))) {
    return { status: 'skipped', outboxId, flagId }
  }

  const row = new OwnedRow(supabase, outboxId, flagId, runId, attemptCount, g.payload, now)
  let state = readCreateState(g.payload)

  // Idempotency pre-check: an active link for THIS company + flag means the
  // task already exists. Restore the flag URL from it (a crash may have hit
  // between the link insert and the flag update), THEN done. Never creates.
  const pre = await readActiveLink(supabase, companyId, flagId)
  if (pre.error) return row.failRetry(CODES.linkReadFailed, state)
  if (pre.link) {
    const url = pre.link.url ?? (pre.link.gid ? taskUrlForGid(pre.link.gid) : null)
    if (!url) return row.manualReview(CODES.manualLinkIncomplete, state)
    if (!(await writeFlagTaskUrl(supabase, companyId, flagId, url))) {
      return row.failRetry(CODES.flagUrlUpdateFailed, state)
    }
    if (!(await row.done(state))) return { status: 'lost_lock', outboxId, flagId }
    return { status: 'already_linked', outboxId, flagId }
  }

  const built = await buildPayloadForFlag(supabase, flagId, deps)
  if (!built) {
    const ok = await row.write({
      status: 'dead',
      last_error: CODES.flagNotFound,
      locked_at: null,
      locked_by: null,
    })
    if (!ok) return { status: 'lost_lock', outboxId, flagId }
    return { status: 'refused', outboxId, flagId, reason: 'flag not found' }
  }
  const { payload } = built
  assertAllowedProject(payload.projectGid)
  // How this flag's task is recognised (built from authoritative IDs).
  let matcher = resolveMatcher(state, flagId, built.propertyId)

  // -------- 1. A task GID is already saved: verify it, never recreate. --------
  if (state.createdTaskGid) {
    let task: Awaited<ReturnType<TaskProvider['getTask']>>
    try {
      task = await provider.getTask(payload.projectGid, state.createdTaskGid)
    } catch (err) {
      const f = classifyCallError(err)
      if (f.kind === 'rate_limited') {
        return row.reschedule(CODES.savedTaskReadFailed, state, f.retryAfterSeconds * 1000)
      }
      return row.failRetry(CODES.savedTaskReadFailed, state)
    }
    if (!task) return row.manualReview(CODES.manualSavedTaskMissing, state, [state.createdTaskGid])
    if (
      !task.projectGids.includes(payload.projectGid) ||
      exactMarkerMatches([task], matcher.matches, payload.projectGid).length !== 1
    ) {
      return row.manualReview(CODES.manualSavedTaskMismatch, state, [state.createdTaskGid])
    }
    return finishWithTask(
      supabase, row, companyId, payload, state,
      state.createdTaskGid, taskUrlForGid(state.createdTaskGid), 'adopted',
    )
  }

  // -------- 2. Ambiguous earlier attempt, or a legacy row: reconcile first. --------
  if (mustReconcile(state)) {
    if (!state.attemptedAt) {
      // LEGACY row (enqueued before Stage 0): the schema cannot prove it was
      // never attempted, so it is treated as possibly attempted NOW and
      // reconciled by the exact "Open in app:" ROUTE of its flag (the URL
      // origin is ignored: APP_BASE_URL may have changed since).
      state = { ...state, marker: LEGACY_MARKER, attemptedAt: new Date(now()).toISOString() }
      matcher = resolveMatcher(state, flagId, built.propertyId)
      if (!(await row.saveState(state))) return { status: 'lost_lock', outboxId, flagId }
    }
    const marker = matcher.storedMarker
    const sinceMs = Date.parse(g.createdAt ?? state.attemptedAt ?? '') - LOOKUP_MARGIN_MS
    const sinceIso = new Date(Number.isFinite(sinceMs) ? sinceMs : 0).toISOString()

    let tasks: Awaited<ReturnType<TaskProvider['listTasksModifiedSince']>>
    try {
      tasks = await provider.listTasksModifiedSince(payload.projectGid, sinceIso)
    } catch (err) {
      // Lookup failure of ANY kind: create NOTHING.
      const f = classifyCallError(err)
      if (f.kind === 'rate_limited') {
        return row.reschedule(CODES.lookupFailed, state, f.retryAfterSeconds * 1000)
      }
      return row.failRetry(CODES.lookupFailed, state)
    }
    const matches = exactMarkerMatches(tasks, matcher.matches, payload.projectGid)
    if (matches.length > 1) {
      // Never adopt one silently, never delete: a person decides.
      return row.manualReview(CODES.manualDuplicateTasks, state, matches)
    }
    if (matches.length === 1) {
      state = { ...state, marker, createdTaskGid: matches[0] }
      if (!(await row.saveState(state))) return { status: 'lost_lock', outboxId, flagId }
      return finishWithTask(
        supabase, row, companyId, payload, state, matches[0], taskUrlForGid(matches[0]), 'adopted',
      )
    }
    // Not found: count it (only if spaced), then quarantine.
    state = recordNotFound({ ...state, marker }, now())
    if (!replacementPermitted(state, now())) {
      return row.reschedule('reconcile_not_found', state, nextReconcileDelayMs(state, now()))
    }
    // Quarantine satisfied: fall through to a replacement attempt.
  }

  // -------- 3. Create: record the attempt FIRST, then send. --------
  state = startAttempt(
    { ...state, protocol: state.protocol ?? CREATE_PROTOCOL },
    flagMarkerLine(flagId),
    now(),
  )
  if (!(await row.saveState(state))) {
    // Could not prove ownership / record the attempt: send NOTHING.
    return { status: 'lost_lock', outboxId, flagId }
  }

  let created: { externalTaskGid: string; externalTaskUrl: string }
  try {
    created = await provider.createTask(payload)
  } catch (err) {
    const f = classifyCallError(err)
    if (f.kind === 'rejected') {
      // Asana refused: nothing was created; no reconciliation needed.
      return row.failRetry(CODES.createRejected(f.status), clearAttempt(state))
    }
    if (f.kind === 'rate_limited') {
      // 429: not processed. Wait Retry-After without consuming an attempt.
      return row.reschedule('create_rate_limited', clearAttempt(state), f.retryAfterSeconds * 1000)
    }
    // Ambiguous: keep the attempt; the next run reconciles before creating.
    return row.failRetry(CODES.createAmbiguous, state)
  }

  // Save the GID IMMEDIATELY (conditional). If this fails, the task exists
  // and the row still records the attempt: the next run adopts it by marker.
  state = { ...state, createdTaskGid: created.externalTaskGid }
  if (!(await row.saveState(state))) return { status: 'lost_lock', outboxId, flagId }

  return finishWithTask(
    supabase, row, companyId, payload, state,
    created.externalTaskGid, created.externalTaskUrl, 'created',
  )
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
  await resetStaleProcessing(supabase, (deps.now ?? Date.now)())
  const results: RealRunResult[] = []
  const limit = Math.max(1, batchSize)
  for (let i = 0; i < limit; i++) {
    const result = await runNextAsanaOutbox(supabase, provider, deps)
    results.push(result)
    if (result.status === 'no_pending') break
  }
  return results
}
