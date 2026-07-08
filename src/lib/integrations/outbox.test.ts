import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildFlagOutboxEvent,
  maybeEnqueueFlagCreated,
  type FlagCreatedOutboxInput,
} from '@/lib/integrations/outbox'

function baseInput(overrides: Partial<FlagCreatedOutboxInput> = {}): FlagCreatedOutboxInput {
  return {
    companyId: 'company-1',
    flagId: 'flag-123',
    createdBy: 'user-9',
    ...overrides,
  }
}

describe('buildFlagOutboxEvent (pure)', () => {
  it('sets the identity fields for a flag-created Asana event', () => {
    const row = buildFlagOutboxEvent(baseInput())
    expect(row.company_id).toBe('company-1')
    expect(row.provider).toBe('asana')
    expect(row.event_type).toBe('asana.create_task_for_flag')
    expect(row.entity_type).toBe('flag')
    expect(row.entity_id).toBe('flag-123')
    expect(row.created_by).toBe('user-9')
  })

  it('defaults payload to { flag_id } when no hints are given', () => {
    const row = buildFlagOutboxEvent(baseInput())
    expect(row.payload).toEqual({ flag_id: 'flag-123' })
  })

  it('merges extra payload hints while keeping flag_id', () => {
    const row = buildFlagOutboxEvent(
      baseInput({ payload: { propertyId: 'prop-1', note: 'x' } }),
    )
    expect(row.payload).toEqual({ propertyId: 'prop-1', note: 'x', flag_id: 'flag-123' })
  })

  it('does NOT let a payload hint overwrite flag_id', () => {
    const row = buildFlagOutboxEvent(baseInput({ payload: { flag_id: 'HACKED' } }))
    expect(row.payload.flag_id).toBe('flag-123')
  })

  it('omits DB-owned fields from the insert row', () => {
    const row = buildFlagOutboxEvent(baseInput())
    for (const key of [
      'id',
      'status',
      'attempt_count',
      'available_at',
      'locked_at',
      'locked_by',
      'processed_at',
      'last_error',
      'created_at',
      'updated_at',
      'deleted_at',
    ]) {
      expect(row).not.toHaveProperty(key)
    }
  })

  it('includes only the expected keys', () => {
    const row = buildFlagOutboxEvent(baseInput())
    expect(Object.keys(row).sort()).toEqual(
      [
        'company_id',
        'created_by',
        'entity_id',
        'entity_type',
        'event_type',
        'payload',
        'provider',
      ].sort(),
    )
  })
})

// ---------------------------------------------------------------
// maybeEnqueueFlagCreated — failure isolation (Slice 4b).
// A tiny explicitly-typed fake Supabase client (no network) lets us
// prove the helper NEVER throws, regardless of enabled state or errors.
// ---------------------------------------------------------------

type QResult = { data?: unknown; error?: unknown }

interface FakeQuery {
  select: () => FakeQuery
  eq: () => FakeQuery
  is: () => FakeQuery
  limit: () => FakeQuery
  maybeSingle: () => Promise<QResult>
  insert: () => Promise<QResult>
}

function makeQuery(terminal: QResult): FakeQuery {
  const q: FakeQuery = {
    select: () => q,
    eq: () => q,
    is: () => q,
    limit: () => q,
    maybeSingle: async () => terminal,
    insert: async () => terminal,
  }
  return q
}

function fakeClient(
  perTable: Record<string, QResult>,
  opts: { throwOnFrom?: boolean } = {},
): SupabaseClient {
  return {
    from(table: string): FakeQuery {
      if (opts.throwOnFrom) throw new Error('boom from()')
      return makeQuery(perTable[table] ?? { data: null, error: null })
    },
  } as unknown as SupabaseClient
}

const enqueueInput: FlagCreatedOutboxInput = {
  companyId: 'c1',
  flagId: 'f1',
  createdBy: 'u1',
  payload: { property_id: 'p1', category_key: 'maintenance_issue' },
}

describe('maybeEnqueueFlagCreated (failure isolation)', () => {
  it('never throws and enqueues nothing when Asana is disabled', async () => {
    const client = fakeClient({ integration_settings: { data: null, error: null } })
    await expect(maybeEnqueueFlagCreated(client, enqueueInput)).resolves.toBeUndefined()
  })

  it('never throws when the client itself throws', async () => {
    const client = fakeClient({}, { throwOnFrom: true })
    await expect(maybeEnqueueFlagCreated(client, enqueueInput)).resolves.toBeUndefined()
  })

  it('never throws when enabled and the enqueue hits a duplicate (23505)', async () => {
    const client = fakeClient({
      integration_settings: { data: { id: 's1' }, error: null },
      integration_outbox: { error: { code: '23505' } },
    })
    await expect(maybeEnqueueFlagCreated(client, enqueueInput)).resolves.toBeUndefined()
  })

  it('never throws when enabled and the enqueue errors', async () => {
    const client = fakeClient({
      integration_settings: { data: { id: 's1' }, error: null },
      integration_outbox: { error: { code: '500', message: 'db down' } },
    })
    await expect(maybeEnqueueFlagCreated(client, enqueueInput)).resolves.toBeUndefined()
  })
})
