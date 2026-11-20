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
import { CREATE_PROTOCOL } from '@/lib/integrations/worker/create-idempotency'
import {
  ASANA_DESTINATIONS,
  destinationPin,
  type AsanaDestinationKey,
} from '@/lib/integrations/asana/destinations'
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
export function buildFlagOutboxEvent(
  input: FlagCreatedOutboxInput,
  destination: AsanaDestinationKey = 'beta',
): OutboxInsertRow {
  return {
    company_id: input.companyId,
    provider: 'asana',
    // The event type PINS the destination for the life of the job.
    event_type: ASANA_DESTINATIONS[destination].createEvent,
    entity_type: 'flag',
    entity_id: input.flagId,
    // create_protocol (Stage 0): rows carrying it ALWAYS record an attempt
    // before any create request, so "no attempt recorded" provably means
    // untouched. Rows without it are legacy and are reconciled first.
    // Spread LAST so a caller hint can never forge or remove it — the same
    // goes for the destination record (written for the live test only, so a
    // BETA row is byte-for-byte what it has always been).
    payload: {
      ...(input.payload ?? {}),
      flag_id: input.flagId,
      create_protocol: CREATE_PROTOCOL,
      ...(destination === 'beta' ? {} : destinationPin(destination)),
    },
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
  destination: AsanaDestinationKey = 'beta',
): Promise<EnqueueResult> {
  try {
    const row = buildFlagOutboxEvent(input, destination)
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
export function buildAttachEvidenceEvent(
  input: FlagCreatedOutboxInput,
  destination: AsanaDestinationKey = 'beta',
): OutboxInsertRow {
  return {
    company_id: input.companyId,
    provider: 'asana',
    event_type: ASANA_DESTINATIONS[destination].attachEvent,
    entity_type: 'flag',
    entity_id: input.flagId,
    payload: {
      ...(input.payload ?? {}),
      flag_id: input.flagId,
      content_generation: 1,
      ...(destination === 'beta' ? {} : destinationPin(destination)),
    },
    created_by: input.createdBy,
  }
}

/** Thin I/O. Enqueue an attach-evidence event; 23505 → skipped duplicate. */
export async function enqueueAttachEvidenceEvent(
  supabase: SupabaseClient,
  input: FlagCreatedOutboxInput,
  destination: AsanaDestinationKey = 'beta',
): Promise<EnqueueResult> {
  try {
    const { error } = await supabase
      .from('integration_outbox')
      .insert(buildAttachEvidenceEvent(input, destination))
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
 *
 * Reports what happened to the CREATE event, without interpreting it:
 *   - 'enqueued'  a new create job was inserted just now;
 *   - 'duplicate' a create job for this flag ALREADY existed. That says
 *                 nothing about its state (it may be pending, done or
 *                 dead) — the caller must read the real job / task link;
 *   - 'failed'    the insert failed: no job was added;
 *   - 'disabled'  Asana is not enabled (or that could not be confirmed).
 */
export type FlagCreateEnqueueOutcome = 'enqueued' | 'duplicate' | 'failed' | 'disabled'

/**
 * Does this flag already have an active (not soft-deleted) job of the
 * given event type? true / false, or 'unknown' when the read failed.
 */
async function hasCreateJob(
  supabase: SupabaseClient,
  input: FlagCreatedOutboxInput,
  eventType: string,
): Promise<boolean | 'unknown'> {
  try {
    const { data, error } = await supabase
      .from('integration_outbox')
      .select('id')
      .eq('company_id', input.companyId)
      .eq('provider', 'asana')
      .eq('event_type', eventType)
      .eq('entity_type', 'flag')
      .eq('entity_id', input.flagId)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()
    if (error) return 'unknown'
    return data != null
  } catch {
    return 'unknown'
  }
}

/**
 * The destination this flag is ALREADY pinned to, from ANY of its existing
 * Asana jobs — create or attach, either destination:
 * a destination, null (confirmed: no job at all), or 'unknown' (a read
 * failed and no job was found).
 */
export async function existingFlagDestination(
  supabase: SupabaseClient,
  input: FlagCreatedOutboxInput,
): Promise<AsanaDestinationKey | null | 'unknown'> {
  let unknown = false
  for (const kind of ['createEvent', 'attachEvent'] as const) {
    for (const key of ['beta', 'live_incidents'] as const) {
      const has = await hasCreateJob(supabase, input, ASANA_DESTINATIONS[key][kind])
      if (has === true) return key
      if (has === 'unknown') unknown = true
    }
  }
  return unknown ? 'unknown' : null
}

/**
 * ONE DESTINATION PER FLAG, FOR LIFE — across BOTH job kinds.
 *
 * `requested` is only what a brand-new flag would get. A flag that already
 * has ANY Asana job (create or attach) keeps THAT job's destination on
 * every replay — whatever the live-test switch says now. Both jobs are then
 * (re-)ensured for that one destination, so a replay can never add a job
 * for the other destination, and an attach job left without its create job
 * gets a create job of the SAME destination.
 *
 * Atomic backstop: migration 20261119110000 refuses, for EVERY writer
 * (concurrent requests and the older production code included), a second
 * create / attach job AND any job whose destination differs from the
 * flag's existing jobs. Such a refusal arrives as a unique violation; the
 * destination is then re-read and the attach job follows the job that won.
 *
 * A live job is never inserted on an unknown: if the existing-job read
 * fails, a live request enqueues nothing. (A BETA request proceeds as it
 * always has; the database rule is what protects a live-pinned flag then.)
 */
export async function maybeEnqueueFlagEvents(
  supabase: SupabaseClient,
  input: FlagCreatedOutboxInput,
  requested: AsanaDestinationKey = 'beta',
): Promise<{ create: FlagCreateEnqueueOutcome }> {
  try {
    if (await isAsanaEnabled(supabase, input.companyId)) {
      const existing = await existingFlagDestination(supabase, input)
      if (existing === 'unknown' && requested !== 'beta') return { create: 'failed' }
      const destination = existing === 'beta' || existing === 'live_incidents' ? existing : requested

      const created = await enqueueFlagCreatedEvent(supabase, input, destination)
      if (created.enqueued) {
        await enqueueAttachEvidenceEvent(supabase, input, destination)
        return { create: 'enqueued' }
      }
      if (created.skipped === 'duplicate') {
        // A create job already exists, or the database refused ours (lost
        // race / other destination). The attach job follows whatever the
        // flag is ACTUALLY pinned to now — never our own request.
        const winner = await existingFlagDestination(supabase, input)
        if (winner === 'beta' || winner === 'live_incidents') {
          await enqueueAttachEvidenceEvent(supabase, input, winner)
        }
        return { create: 'duplicate' }
      }
      // The create insert failed: no create job, so no attach job either
      // for a live destination (never leave a live attach job without its
      // create job). BETA keeps its previous behaviour.
      if (destination === 'beta') await enqueueAttachEvidenceEvent(supabase, input, destination)
      return { create: 'failed' }
    }
  } catch (err) {
    console.error('[outbox] flag events enqueue skipped:', err)
    return { create: 'failed' }
  }
  return { create: 'disabled' }
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
 *
 * DESTINATION: the flag's EXISTING attach event is re-armed, whichever
 * destination it is pinned to (BETA is looked up first, exactly as before).
 * Its event type is never changed. When none exists, the new one follows
 * the flag's existing create job (a live-pinned flag gets a live attach
 * event); with neither, BETA — the previous behaviour.
 */
export async function maybeReArmAttachEvidence(
  supabase: SupabaseClient,
  input: FlagCreatedOutboxInput,
): Promise<void> {
  type Existing = { id: string; status: string; payload: Record<string, unknown> | null }
  const findAttach = async (eventType: string) => {
    const { data } = await supabase
      .from('integration_outbox')
      .select('id, status, payload')
      .eq('company_id', input.companyId)
      .eq('provider', 'asana')
      .eq('event_type', eventType)
      .eq('entity_type', 'flag')
      .eq('entity_id', input.flagId)
      .is('deleted_at', null)
      .maybeSingle<Existing>()
    return data ?? null
  }

  try {
    if (!(await isAsanaEnabled(supabase, input.companyId))) return

    const existing =
      (await findAttach(ASANA_DESTINATIONS.beta.attachEvent)) ??
      (await findAttach(ASANA_DESTINATIONS.live_incidents.attachEvent))

    if (!existing) {
      const pinned = await existingFlagDestination(supabase, input)
      // Cannot tell which destination the flag is pinned to: insert nothing
      // (the next report-relevant change re-arms again).
      if (pinned === 'unknown') return
      await enqueueAttachEvidenceEvent(supabase, input, pinned ?? 'beta')
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
