import { describe, it, expect } from 'vitest'
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
}): { client: SupabaseClient; sink: Sink } {
  const sink: Sink = { inserts: [], updates: [] }
  const makeQ = (table: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      is: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (table === 'integration_settings') {
          return { data: opts.asanaEnabled ? { id: 's' } : null, error: null }
        }
        if (table === 'integration_outbox') return { data: opts.existingRow ?? null, error: null }
        return { data: null, error: null }
      },
      insert: async (row: unknown) => {
        sink.inserts.push({ table, rows: Array.isArray(row) ? row : [row] })
        return { error: null }
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
    await maybeEnqueueFlagEvents(client, input)
    const eventTypes = sink.inserts.flatMap((i) => i.rows).map((r) => (r as { event_type: string }).event_type)
    expect(eventTypes).toContain('asana.create_task_for_flag')
    expect(eventTypes).toContain('asana.attach_flag_evidence')
  })

  it('enqueues nothing when Asana is disabled', async () => {
    const { client, sink } = fakeClient({ asanaEnabled: false })
    await maybeEnqueueFlagEvents(client, input)
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
