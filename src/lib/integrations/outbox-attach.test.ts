import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildAttachEvidenceEvent,
  maybeEnqueueFlagEvents,
  maybeReArmAttachEvidence,
  type FlagCreatedOutboxInput,
} from '@/lib/integrations/outbox'

const input: FlagCreatedOutboxInput = {
  companyId: 'co-1',
  flagId: 'flag-1',
  createdBy: 'user-1',
}

type Sink = { inserts: { table: string; rows: unknown[] }[]; updates: { table: string; patch: Record<string, unknown> }[] }

function fakeClient(opts: {
  asanaEnabled?: boolean
  existingRow?: { id: string; status: string; payload: Record<string, unknown> } | null
  insertError?: { code: string; message: string }
  /** Outbox rows by event type (takes precedence over existingRow). */
  rowsByEvent?: Record<string, { id: string; status: string; payload: Record<string, unknown> } | null>
  /** Event types whose outbox read fails. */
  readErrorFor?: string[]
}): { client: SupabaseClient; sink: Sink } {
  const sink: Sink = { inserts: [], updates: [] }
  const makeQ = (table: string) => {
    let eventType: string | undefined
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        if (col === 'event_type') eventType = String(val)
        return q
      },
      is: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (table === 'integration_settings') {
          return { data: opts.asanaEnabled ? { id: 's' } : null, error: null }
        }
        if (table === 'integration_outbox') {
          if (eventType && opts.readErrorFor?.includes(eventType)) return { data: null, error: { code: 'XX000', message: 'down' } }
          if (opts.rowsByEvent && eventType) return { data: opts.rowsByEvent[eventType] ?? null, error: null }
          return { data: opts.existingRow ?? null, error: null }
        }
        return { data: null, error: null }
      },
      insert: async (row: unknown) => {
        sink.inserts.push({ table, rows: Array.isArray(row) ? row : [row] })
        return { error: opts.insertError ?? null }
      },
      update: (patch: Record<string, unknown>) => {
        sink.updates.push({ table, patch })
        return q
      },
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    }
    return q
  }
  const client = { from: (table: string) => makeQ(table) } as unknown as SupabaseClient
  return { client, sink }
}

describe('buildAttachEvidenceEvent', () => {
  it('is the attach event with content_generation = 1', () => {
    const row = buildAttachEvidenceEvent(input)
    expect(row.event_type).toBe('asana.attach_flag_evidence')
    expect(row.entity_type).toBe('flag')
    expect(row.entity_id).toBe('flag-1')
    expect((row.payload as Record<string, unknown>).content_generation).toBe(1)
  })
})

describe('maybeEnqueueFlagEvents', () => {
  it('enqueues BOTH create-task and attach-evidence when Asana is enabled', async () => {
    const { client, sink } = fakeClient({ asanaEnabled: true })
    expect(await maybeEnqueueFlagEvents(client, input)).toEqual({ create: 'enqueued' })
    const eventTypes = sink.inserts.flatMap((i) => i.rows).map((r) => (r as { event_type: string }).event_type)
    expect(eventTypes).toContain('asana.create_task_for_flag')
    expect(eventTypes).toContain('asana.attach_flag_evidence')
  })

  it('a failed create enqueue -> failed (the UI never claims it is on its way)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = fakeClient({ asanaEnabled: true, insertError: { code: 'XX000', message: 'down' } })
    expect(await maybeEnqueueFlagEvents(client, input)).toEqual({ create: 'failed' })
  })

  it('an existing create job -> duplicate (says NOTHING about its state: the caller must read it)', async () => {
    const { client } = fakeClient({ asanaEnabled: true, insertError: { code: '23505', message: 'duplicate' } })
    expect(await maybeEnqueueFlagEvents(client, input)).toEqual({ create: 'duplicate' })
  })

  it('enqueues nothing when Asana is disabled', async () => {
    const { client, sink } = fakeClient({ asanaEnabled: false })
    expect(await maybeEnqueueFlagEvents(client, input)).toEqual({ create: 'disabled' })
    expect(sink.inserts).toHaveLength(0)
  })
})

describe('maybeReArmAttachEvidence', () => {
  it('inserts a fresh attach event when none exists', async () => {
    const { client, sink } = fakeClient({ asanaEnabled: true, existingRow: null })
    await maybeReArmAttachEvidence(client, input)
    expect(sink.inserts.flatMap((i) => i.rows)).toHaveLength(1)
  })

  it('re-arms a completed event: back to pending, generation bumped', async () => {
    const { client, sink } = fakeClient({
      asanaEnabled: true,
      existingRow: { id: 'ob-1', status: 'done', payload: { content_generation: 1 } },
    })
    await maybeReArmAttachEvidence(client, input)
    const patch = sink.updates[0].patch
    expect(patch.status).toBe('pending')
    expect((patch.payload as Record<string, unknown>).content_generation).toBe(2)
  })

  it('mid-processing re-arm bumps generation ONLY (does not disturb status)', async () => {
    const { client, sink } = fakeClient({
      asanaEnabled: true,
      existingRow: { id: 'ob-1', status: 'processing', payload: { content_generation: 3 } },
    })
    await maybeReArmAttachEvidence(client, input)
    const patch = sink.updates[0].patch
    expect((patch.payload as Record<string, unknown>).content_generation).toBe(4)
    expect('status' in patch).toBe(false) // never re-arms the running worker's status
  })

  it('never re-arms when Asana is disabled', async () => {
    const { client, sink } = fakeClient({ asanaEnabled: false })
    await maybeReArmAttachEvidence(client, input)
    expect(sink.updates).toHaveLength(0)
    expect(sink.inserts).toHaveLength(0)
  })
})

describe('CONTROLLED LIVE TEST: enqueue pins ONE destination per flag', () => {
  const BETA_CREATE = 'asana.create_task_for_flag'
  const LIVE_CREATE = 'asana.live.create_task_for_flag'
  const LIVE_ATTACH = 'asana.live.attach_flag_evidence'
  const events = (sink: Sink) => sink.inserts.flatMap((i) => i.rows).map((r) => (r as { event_type: string }).event_type)

  it('live: BOTH jobs are enqueued with the live event types and the destination pin', async () => {
    const { client, sink } = fakeClient({ asanaEnabled: true, rowsByEvent: {} })
    expect(await maybeEnqueueFlagEvents(client, input, 'live_incidents')).toEqual({ create: 'enqueued' })
    expect(events(sink)).toEqual([LIVE_CREATE, LIVE_ATTACH])
    for (const r of sink.inserts.flatMap((i) => i.rows)) {
      expect((r as { payload: Record<string, unknown> }).payload).toMatchObject({
        destination: 'live_incidents',
        destination_project_gid: '1211426202387126',
      })
    }
  })

  it('live requested, but the flag ALREADY has a BETA create job -> it stays BETA: no live job of any kind', async () => {
    const { client, sink } = fakeClient({
      asanaEnabled: true,
      rowsByEvent: { [BETA_CREATE]: { id: 'ob-beta', status: 'done', payload: {} } },
    })
    await maybeEnqueueFlagEvents(client, input, 'live_incidents')
    // every write this request makes is for the ORIGINAL destination (this
    // fake has no unique indexes; outbox-destination.test.ts proves the
    // resulting rows and the 'duplicate' outcome against a stateful table)
    expect(events(sink)).toEqual([BETA_CREATE, 'asana.attach_flag_evidence'])
  })

  it('REPLAY AFTER THE SWITCH IS TURNED OFF: BETA requested, flag already pinned to live -> it stays live: NO BETA job', async () => {
    const { client, sink } = fakeClient({
      asanaEnabled: true,
      rowsByEvent: { [LIVE_CREATE]: { id: 'ob-live', status: 'pending', payload: {} } },
    })
    await maybeEnqueueFlagEvents(client, input, 'beta')
    await maybeEnqueueFlagEvents(client, input)
    expect(events(sink)).toEqual([LIVE_CREATE, LIVE_ATTACH, LIVE_CREATE, LIVE_ATTACH])
    expect(events(sink)).not.toContain(BETA_CREATE)
    expect(events(sink)).not.toContain('asana.attach_flag_evidence')
  })

  it('live create insert FAILS -> no live attach job is left behind', async () => {
    const { client, sink } = fakeClient({ asanaEnabled: true, rowsByEvent: {}, insertError: { code: 'XX000', message: 'down' } })
    expect(await maybeEnqueueFlagEvents(client, input, 'live_incidents')).toEqual({ create: 'failed' })
    expect(events(sink)).toEqual([LIVE_CREATE])
  })

  it('live: the other-destination check FAILS -> nothing is enqueued (never a guess)', async () => {
    const { client, sink } = fakeClient({ asanaEnabled: true, rowsByEvent: {}, readErrorFor: [BETA_CREATE] })
    expect(await maybeEnqueueFlagEvents(client, input, 'live_incidents')).toEqual({ create: 'failed' })
    expect(sink.inserts).toEqual([])
  })

  it('BETA (default) with the existing-job read unavailable: proceeds as before (BETA event types, no destination keys)', async () => {
    const { client, sink } = fakeClient({ asanaEnabled: true, rowsByEvent: {}, readErrorFor: [LIVE_CREATE, BETA_CREATE] })
    expect(await maybeEnqueueFlagEvents(client, input)).toEqual({ create: 'enqueued' })
    expect(events(sink)).toEqual([BETA_CREATE, 'asana.attach_flag_evidence'])
    for (const r of sink.inserts.flatMap((i) => i.rows)) {
      expect((r as { payload: Record<string, unknown> }).payload).not.toHaveProperty('destination')
    }
  })

  it('re-arm: a flag pinned to live gets its LIVE attach job re-armed — its event type is never changed', async () => {
    const { client, sink } = fakeClient({
      asanaEnabled: true,
      rowsByEvent: { [LIVE_ATTACH]: { id: 'ob-live-attach', status: 'done', payload: { content_generation: 1, destination: 'live_incidents' } } },
    })
    await maybeReArmAttachEvidence(client, input)
    expect(sink.inserts).toEqual([])
    expect(sink.updates).toHaveLength(1)
    expect(sink.updates[0].patch).toMatchObject({ status: 'pending' })
    expect(sink.updates[0].patch).not.toHaveProperty('event_type')
    expect((sink.updates[0].patch.payload as Record<string, unknown>)).toMatchObject({ content_generation: 2, destination: 'live_incidents' })
  })

  it('re-arm with no attach job yet: follows the flag\'s existing create job (live -> live attach; none -> BETA as before)', async () => {
    const live = fakeClient({ asanaEnabled: true, rowsByEvent: { [LIVE_CREATE]: { id: 'ob-live', status: 'done', payload: {} } } })
    await maybeReArmAttachEvidence(live.client, input)
    expect(events(live.sink)).toEqual([LIVE_ATTACH])

    const none = fakeClient({ asanaEnabled: true, rowsByEvent: {} })
    await maybeReArmAttachEvidence(none.client, input)
    expect(events(none.sink)).toEqual(['asana.attach_flag_evidence'])

    const unknown = fakeClient({ asanaEnabled: true, rowsByEvent: {}, readErrorFor: [LIVE_CREATE] })
    await maybeReArmAttachEvidence(unknown.client, input)
    expect(unknown.sink.inserts).toEqual([])
  })
})

describe('an existing ATTACH job alone also pins the destination', () => {
  const events = (sink: Sink) => sink.inserts.flatMap((i) => i.rows).map((r) => (r as { event_type: string }).event_type)
  it('live attach job, no create job, BETA requested -> every write is LIVE', async () => {
    const { client, sink } = fakeClient({
      asanaEnabled: true,
      rowsByEvent: { 'asana.live.attach_flag_evidence': { id: 'ob-la', status: 'pending', payload: {} } },
    })
    await maybeEnqueueFlagEvents(client, input, 'beta')
    expect(events(sink)).toEqual(['asana.live.create_task_for_flag', 'asana.live.attach_flag_evidence'])
  })
  it('BETA attach job, no create job, live requested -> every write is BETA', async () => {
    const { client, sink } = fakeClient({
      asanaEnabled: true,
      rowsByEvent: { 'asana.attach_flag_evidence': { id: 'ob-ba', status: 'pending', payload: {} } },
    })
    await maybeEnqueueFlagEvents(client, input, 'live_incidents')
    expect(events(sink)).toEqual(['asana.create_task_for_flag', 'asana.attach_flag_evidence'])
  })
})
