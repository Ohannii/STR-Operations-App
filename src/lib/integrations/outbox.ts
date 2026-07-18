/**
 * Outbound integration outbox helpers (Slice 4a).
 *
 * `buildFlagOutboxEvent` is the pure, unit-tested core: given a flag's
 * identity it returns the row shape to insert into `integration_outbox`.
 * DB-owned columns (id, status, attempt_count, available_at, locked_*,
 * processed_at, last_error, timestamps) are deliberately omitted so the
 * database defaults own them.
 *
 * `isAsanaEnabled` and `enqueueFlagCreatedEvent` are thin I/O helpers,
 * DEFINED here but intentionally NOT wired anywhere in Slice 4a (dead
 * code until the Slice 4b wiring). They fail safe: `isAsanaEnabled`
 * returns false on any error, and `enqueueFlagCreatedEvent` never
 * throws (a unique-violation is reported as a skipped duplicate).
 *
 * No runtime imports of server-only modules: the Supabase client type
 * is brought in via `import type` only, so this file (and its test)
 * never pulls in next/headers.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  IntegrationEntityType,
  IntegrationProvider,
  OutboxEventType,
} from '@/lib/integrations/types'

/** Inputs the caller (Slice 4b) will read off a freshly-created flag. */
export interface FlagCreatedOutboxInput {
  companyId: string
  flagId: string
  createdBy: string
  /** Optional hints for the worker; `flag_id` is always injected and wins. */
  payload?: Record<string, unknown>
}

/**
 * The exact set of columns we insert. DB-owned fields are excluded on
 * purpose so their defaults apply.
 */
export interface OutboxInsertRow {
  company_id: string
  provider: IntegrationProvider
  event_type: OutboxEventType
  entity_type: IntegrationEntityType
  entity_id: string
  payload: Record<string, unknown>
  created_by: string
}

export interface EnqueueResult {
  enqueued: boolean
  skipped?: 'duplicate'
  error?: string
}

/**
 * PURE. Build the outbox row for a "flag created → create Asana task"
 * event. `flag_id` is spread LAST so a caller-supplied payload hint can
 * never overwrite it.
 */
export function buildFlagOutboxEvent(input: FlagCreatedOutboxInput): OutboxInsertRow {
  return {
    company_id: input.companyId,
    provider: 'asana',
    event_type: 'asana.create_task_for_flag',
    entity_type: 'flag',
    entity_id: input.flagId,
    payload: { ...(input.payload ?? {}), flag_id: input.flagId },
    created_by: input.createdBy,
  }
}

/**
 * Thin I/O. Is the Asana integration switched on for this company?
 * NOT wired in Slice 4a. Fails CLOSED — any error returns false so a
 * lookup problem can never cause an unintended enqueue.
 */
export async function isAsanaEnabled(
  supabase: SupabaseClient,
  companyId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('integration_settings')
      .select('id')
      .eq('company_id', companyId)
      .eq('provider', 'asana')
      .eq('is_enabled', true)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()

    if (error) return false
    return data != null
  } catch {
    return false
  }
}

/**
 * Thin I/O. Enqueue a flag-created event. NOT wired in Slice 4a.
 * NEVER throws: a unique-violation (23505) is reported as a skipped
 * duplicate; any other failure is returned as `{ enqueued: false, error }`.
 */
export async function enqueueFlagCreatedEvent(
  supabase: SupabaseClient,
  input: FlagCreatedOutboxInput,
): Promise<EnqueueResult> {
  try {
    const row = buildFlagOutboxEvent(input)
    const { error } = await supabase.from('integration_outbox').insert(row)

    if (error) {
      if (error.code === '23505') {
        return { enqueued: false, skipped: 'duplicate' }
      }
      return { enqueued: false, error: error.message }
    }

    return { enqueued: true }
  } catch (err) {
    return { enqueued: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Composition entry point for the flag-create wiring (Slice 4b).
 *
 * NEVER throws. Enqueues a flag-created event ONLY when Asana is
 * enabled for the company. Any failure (disabled lookup, RLS, network,
 * duplicate) is swallowed and logged so issue reporting can never
 * break. Returns void so callers can `await` it without branching.
 */
export async function maybeEnqueueFlagCreated(
  supabase: SupabaseClient,
  input: FlagCreatedOutboxInput,
): Promise<void> {
  try {
    if (await isAsanaEnabled(supabase, input.companyId)) {
      await enqueueFlagCreatedEvent(supabase, input)
    }
  } catch (err) {
    console.error('[outbox] flag-created enqueue skipped:', err)
  }
}

// ---------------------------------------------------------------
// Slice 11C2 — attach flag evidence (PDF + photos) to the task.
// ---------------------------------------------------------------

/**
 * PURE. Build the outbox row for "attach flag evidence". `content_generation`
 * starts at 1 and is bumped on every re-arm; the worker uses it as a
 * compare-and-set token so a change during processing is never lost.
 */
export function buildAttachEvidenceEvent(input: FlagCreatedOutboxInput): OutboxInsertRow {
  return {
    company_id: input.companyId,
    provider: 'asana',
    event_type: 'asana.attach_flag_evidence',
    entity_type: 'flag',
    entity_id: input.flagId,
    payload: { ...(input.payload ?? {}), flag_id: input.flagId, content_generation: 1 },
    created_by: input.createdBy,
  }
}

/** Thin I/O. Enqueue an attach-evidence event; 23505 → skipped duplicate. */
export async function enqueueAttachEvidenceEvent(
  supabase: SupabaseClient,
  input: FlagCreatedOutboxInput,
): Promise<EnqueueResult> {
  try {
    const { error } = await supabase
      .from('integration_outbox')
      .insert(buildAttachEvidenceEvent(input))
    if (error) {
      if (error.code === '23505') return { enqueued: false, skipped: 'duplicate' }
      return { enqueued: false, error: error.message }
    }
    return { enqueued: true }
  } catch (err) {
    return { enqueued: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * At finalisation: enqueue BOTH the create-task and attach-evidence events
 * (each ON CONFLICT DO NOTHING). NEVER throws. Only when Asana is enabled.
 */
export async function maybeEnqueueFlagEvents(
  supabase: SupabaseClient,
  input: FlagCreatedOutboxInput,
): Promise<void> {
  try {
    if (await isAsanaEnabled(supabase, input.companyId)) {
      await enqueueFlagCreatedEvent(supabase, input)
      await enqueueAttachEvidenceEvent(supabase, input)
    }
  } catch (err) {
    console.error('[outbox] flag events enqueue skipped:', err)
  }
}

/**
 * Re-arm ONLY the attach-evidence event after a report-relevant change, so
 * new photos / a new PDF revision get attached. NEVER re-arms create-task
 * (that would risk a duplicate Asana task). NEVER throws.
 *
 * Race-safe: if the event is mid-`processing`, we bump `content_generation`
 * only — the worker's compare-and-set completion detects the change and
 * reschedules. Otherwise we reset it to `pending` (fresh dependency-wait
 * window, attempts cleared). If no attach event exists yet (e.g. a flag
 * created before this slice), we insert one.
 */
export async function maybeReArmAttachEvidence(
  supabase: SupabaseClient,
  input: FlagCreatedOutboxInput,
): Promise<void> {
  try {
    if (!(await isAsanaEnabled(supabase, input.companyId))) return

    const { data: existing } = await supabase
      .from('integration_outbox')
      .select('id, status, payload')
      .eq('company_id', input.companyId)
      .eq('provider', 'asana')
      .eq('event_type', 'asana.attach_flag_evidence')
      .eq('entity_type', 'flag')
      .eq('entity_id', input.flagId)
      .is('deleted_at', null)
      .maybeSingle<{ id: string; status: string; payload: Record<string, unknown> | null }>()

    if (!existing) {
      await enqueueAttachEvidenceEvent(supabase, input)
      return
    }

    const payload = existing.payload ?? {}
    const nextGen = Number(payload.content_generation ?? 0) + 1
    const nextPayload: Record<string, unknown> = {
      ...payload,
      flag_id: input.flagId,
      content_generation: nextGen,
    }

    if (existing.status === 'processing') {
      // Mid-run: bump generation only; do not disturb the worker's lease.
      await supabase
        .from('integration_outbox')
        .update({ payload: nextPayload })
        .eq('id', existing.id)
      return
    }

    // Otherwise re-arm to pending and reset the dependency-wait window.
    delete nextPayload.dep_wait_started_at
    await supabase
      .from('integration_outbox')
      .update({
        status: 'pending',
        available_at: new Date().toISOString(),
        attempt_count: 0,
        last_error: null,
        locked_at: null,
        payload: nextPayload,
      })
      .eq('id', existing.id)
  } catch (err) {
    console.error('[outbox] attach re-arm skipped:', err)
  }
}
