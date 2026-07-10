import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  dryRunNextAsanaOutbox,
  runNextAsanaOutbox,
} from '@/lib/integrations/worker/process-outbox'
import {
  ASANA_TEST_PROJECT_GID,
  ASANA_TEST_SECTION_GIDS,
} from '@/lib/integrations/asana/config'
import type { TaskProvider } from '@/lib/integrations/types'

type Result = { data?: unknown; error?: unknown }

interface WriteSpies {
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  upsert: ReturnType<typeof vi.fn>
}

interface FakeQuery {
  select: () => FakeQuery
  eq: () => FakeQuery
  is: () => FakeQuery
  lte: () => FakeQuery
  order: () => FakeQuery
  limit: () => Promise<Result>
  maybeSingle: () => Promise<Result>
  insert: (...a: unknown[]) => FakeQuery
  update: (...a: unknown[]) => FakeQuery
  delete: (...a: unknown[]) => FakeQuery
  upsert: (...a: unknown[]) => FakeQuery
}

function writeSpies(): WriteSpies {
  return { insert: vi.fn(), update: vi.fn(), delete: vi.fn(), upsert: vi.fn() }
}

// Fake client. Write spies are called with the table name first so tests
// can assert which table was written.
function makeClient(perTable: Record<string, Result>, writes: WriteSpies): SupabaseClient {
  const build = (table: string, result: Result): FakeQuery => {
    const q: FakeQuery = {
      select: () => q,
      eq: () => q,
      is: () => q,
      lte: () => q,
      order: () => q,
      limit: async () => result,
      maybeSingle: async () => result,
      insert: (...a) => {
        writes.insert(table, ...a)
        return q
      },
      update: (...a) => {
        writes.update(table, ...a)
        return q
      },
      delete: (...a) => {
        writes.delete(table, ...a)
        return q
      },
      upsert: (...a) => {
        writes.upsert(table, ...a)
        return q
      },
    }
    return q
  }
  return {
    from: (table: string) => build(table, perTable[table] ?? { data: null }),
  } as unknown as SupabaseClient
}

const OUTBOX_ROW = {
  id: 'ob1',
  company_id: 'good-co',
  entity_type: 'flag',
  entity_id: 'flag-1',
  status: 'pending',
  attempt_count: 0,
}

const FLAG_ROW = {
  id: 'flag-1',
  description: 'Leaking tap',
  severity: 'med',
  status: 'raised',
  chargeable_party_decision: null,
  raised_at: '2026-07-08T12:00:00Z',
  property_id: 'prop-1',
  flag_category_id: 'cat-1',
  raised_by: 'user-1',
}

const deps = {
  allowedCompanyIds: ['good-co'],
  appBaseUrl: 'https://staging.example.com',
  todayIso: '2026-07-08',
}

// Full happy-path table set for the flag re-read.
const FLAG_TABLES: Record<string, Result> = {
  flags: { data: FLAG_ROW },
  properties: { data: { name: 'Real Property' } },
  flag_categories: { data: { key: 'maintenance_issue', display_label: 'Broken thing' } },
  profiles: { data: { full_name: 'Quraisha R.' } },
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dryRunNextAsanaOutbox', () => {
  it('returns no_pending when there is no pending row', async () => {
    const client = makeClient({ integration_outbox: { data: [] } }, writeSpies())
    const res = await dryRunNextAsanaOutbox(client, deps)
    expect(res.status).toBe('no_pending')
  })

  it('refuses a company that is not on the allowlist', async () => {
    const client = makeClient(
      { integration_outbox: { data: [{ ...OUTBOX_ROW, company_id: 'evil-co' }] } },
      writeSpies(),
    )
    const res = await dryRunNextAsanaOutbox(client, deps)
    expect(res.status).toBe('refused')
  })

  it('refuses when the flag cannot be re-read', async () => {
    const client = makeClient(
      { integration_outbox: { data: [OUTBOX_ROW] }, flags: { data: null } },
      writeSpies(),
    )
    const res = await dryRunNextAsanaOutbox(client, deps)
    expect(res.status).toBe('refused')
  })

  it('builds the payload from DB data, makes no Asana call, and writes nothing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const writes = writeSpies()
    const client = makeClient({ integration_outbox: { data: [OUTBOX_ROW] }, ...FLAG_TABLES }, writes)

    const res = await dryRunNextAsanaOutbox(client, deps)

    expect(res.status).toBe('dry_run_ok')
    if (res.status !== 'dry_run_ok') return
    expect(res.payload.projectGid).toBe(ASANA_TEST_PROJECT_GID)
    expect(res.payload.sectionGid).toBe(ASANA_TEST_SECTION_GIDS.maintenance)
    expect(res.payload.name).toBe('[Maintenance] Real Property — Leaking tap')
    expect(res.payload.notes).toContain(
      'Open in app: https://staging.example.com/properties/prop-1/flags/flag-1',
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(writes.insert).not.toHaveBeenCalled()
    expect(writes.update).not.toHaveBeenCalled()
    expect(writes.delete).not.toHaveBeenCalled()
    expect(writes.upsert).not.toHaveBeenCalled()
  })
})

describe('runNextAsanaOutbox', () => {
  it('already-linked: no provider call, marks the outbox done, no link insert', async () => {
    const writes = writeSpies()
    const provider = { createTask: vi.fn() }
    const client = makeClient(
      {
        integration_outbox: { data: [OUTBOX_ROW] },
        external_task_links: { data: { id: 'link-1' } },
      },
      writes,
    )

    const res = await runNextAsanaOutbox(client, provider as unknown as TaskProvider, deps)

    expect(res.status).toBe('already_linked')
    expect(provider.createTask).not.toHaveBeenCalled()
    expect(writes.update).toHaveBeenCalledWith(
      'integration_outbox',
      expect.objectContaining({ status: 'done' }),
    )
    expect(writes.insert).not.toHaveBeenCalled()
  })

  it('success: provider called once, link inserted, flag updated, outbox done', async () => {
    const writes = writeSpies()
    const provider = {
      createTask: vi.fn(async () => ({
        externalTaskGid: 'T100',
        externalTaskUrl: 'https://app.asana.com/0/1/T100',
      })),
    }
    const client = makeClient(
      {
        integration_outbox: { data: [OUTBOX_ROW] },
        external_task_links: { data: null },
        ...FLAG_TABLES,
      },
      writes,
    )

    const res = await runNextAsanaOutbox(client, provider as unknown as TaskProvider, deps)

    expect(res.status).toBe('created')
    if (res.status !== 'created') return
    expect(res.externalTaskGid).toBe('T100')
    expect(provider.createTask).toHaveBeenCalledTimes(1)
    expect(writes.insert).toHaveBeenCalledWith(
      'external_task_links',
      expect.objectContaining({
        internal_entity_type: 'flag',
        internal_entity_id: 'flag-1',
        external_task_gid: 'T100',
      }),
    )
    expect(writes.update).toHaveBeenCalledWith(
      'flags',
      expect.objectContaining({ asana_task_url: 'https://app.asana.com/0/1/T100' }),
    )
    expect(writes.update).toHaveBeenCalledWith(
      'integration_outbox',
      expect.objectContaining({ status: 'done' }),
    )
  })

  it('provider error: records attempt_count/last_error, no link insert, no flag update', async () => {
    const writes = writeSpies()
    const provider = {
      createTask: vi.fn(async () => {
        throw new Error('asana 500')
      }),
    }
    const client = makeClient(
      {
        integration_outbox: { data: [OUTBOX_ROW] },
        external_task_links: { data: null },
        ...FLAG_TABLES,
      },
      writes,
    )

    const res = await runNextAsanaOutbox(client, provider as unknown as TaskProvider, deps)

    expect(res.status).toBe('error')
    expect(writes.update).toHaveBeenCalledWith(
      'integration_outbox',
      expect.objectContaining({ attempt_count: 1, last_error: expect.stringContaining('asana 500') }),
    )
    expect(writes.insert).not.toHaveBeenCalled()
    expect(writes.update).not.toHaveBeenCalledWith('flags', expect.anything())
  })
})
