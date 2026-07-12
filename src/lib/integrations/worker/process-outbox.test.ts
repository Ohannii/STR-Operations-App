import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  dryRunNextAsanaOutbox,
  runNextAsanaOutbox,
  runAsanaOutboxBatch,
} from '@/lib/integrations/worker/process-outbox'
import {
  ASANA_TEST_PROJECT_GID,
  ASANA_TEST_SECTION_GIDS,
} from '@/lib/integrations/asana/config'
import type { TaskProvider } from '@/lib/integrations/types'

type Result = { data?: unknown; error?: unknown }

// A table fixture: `read` is returned by select terminals; `claim` is
// returned by maybeSingle after an update (the atomic claim).
interface TableFixture {
  read?: Result
  claim?: Result
}

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
  lt: () => FakeQuery
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

// Write spies are called with the table name first so tests can assert
// which table was written. `maybeSingle` returns the fixture's `claim`
// result when the chain included an update (else `read`).
function makeClient(perTable: Record<string, TableFixture>, writes: WriteSpies): SupabaseClient {
  const build = (table: string): FakeQuery => {
    let isWrite = false
    const fixture = perTable[table] ?? {}
    const q: FakeQuery = {
      select: () => q,
      eq: () => q,
      is: () => q,
      lt: () => q,
      lte: () => q,
      order: () => q,
      limit: async () => fixture.read ?? { data: [] },
      maybeSingle: async () =>
        isWrite ? (fixture.claim ?? { data: null }) : (fixture.read ?? { data: null }),
      insert: (...a) => {
        writes.insert(table, ...a)
        return q
      },
      update: (...a) => {
        writes.update(table, ...a)
        isWrite = true
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
  return { from: (table: string) => build(table) } as unknown as SupabaseClient
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
  issue_title: null,
}

const FLAG_TABLES: Record<string, TableFixture> = {
  flags: { read: { data: FLAG_ROW } },
  properties: { read: { data: { name: 'Real Property' } } },
  flag_categories: { read: { data: { key: 'maintenance_issue', display_label: 'Broken thing' } } },
  profiles: { read: { data: { full_name: 'Quraisha R.' } } },
}

const deps = {
  allowedCompanyIds: ['good-co'],
  appBaseUrl: 'https://staging.example.com',
  todayIso: '2026-07-08',
}

function okProvider() {
  return {
    createTask: vi.fn(async () => ({
      externalTaskGid: 'T100',
      externalTaskUrl: 'https://app.asana.com/0/1/T100',
    })),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dryRunNextAsanaOutbox', () => {
  it('returns no_pending when there is no pending row', async () => {
    const client = makeClient({ integration_outbox: { read: { data: [] } } }, writeSpies())
    const res = await dryRunNextAsanaOutbox(client, deps)
    expect(res.status).toBe('no_pending')
  })

  it('refuses a company not on the allowlist (and writes nothing in dry run)', async () => {
    const writes = writeSpies()
    const client = makeClient(
      { integration_outbox: { read: { data: [{ ...OUTBOX_ROW, company_id: 'evil-co' }] } } },
      writes,
    )
    const res = await dryRunNextAsanaOutbox(client, deps)
    expect(res.status).toBe('refused')
    expect(writes.update).not.toHaveBeenCalled()
  })

  it('builds the payload from DB data, no Asana call, no writes', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const writes = writeSpies()
    const client = makeClient(
      { integration_outbox: { read: { data: [OUTBOX_ROW] } }, ...FLAG_TABLES },
      writes,
    )

    const res = await dryRunNextAsanaOutbox(client, deps)

    expect(res.status).toBe('dry_run_ok')
    if (res.status !== 'dry_run_ok') return
    expect(res.payload.projectGid).toBe(ASANA_TEST_PROJECT_GID)
    expect(res.payload.sectionGid).toBe(ASANA_TEST_SECTION_GIDS.maintenance)
    expect(res.payload.name).toBe('Leaking tap — Real Property [Maintenance]')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(writes.insert).not.toHaveBeenCalled()
    expect(writes.update).not.toHaveBeenCalled()
  })
})

describe('runNextAsanaOutbox', () => {
  it('claim-lost: skips without a provider call or writes', async () => {
    const writes = writeSpies()
    const provider = { createTask: vi.fn() }
    const client = makeClient(
      { integration_outbox: { read: { data: [OUTBOX_ROW] }, claim: { data: null } } },
      writes,
    )
    const res = await runNextAsanaOutbox(client, provider as unknown as TaskProvider, deps)
    expect(res.status).toBe('skipped')
    expect(provider.createTask).not.toHaveBeenCalled()
    expect(writes.insert).not.toHaveBeenCalled()
  })

  it('already-linked: claims, no provider call, marks outbox done, no link insert', async () => {
    const writes = writeSpies()
    const provider = { createTask: vi.fn() }
    const client = makeClient(
      {
        integration_outbox: { read: { data: [OUTBOX_ROW] }, claim: { data: { id: 'ob1' } } },
        external_task_links: { read: { data: { id: 'link-1' } } },
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

  it('success: claim won → provider once → link inserted → flag updated → outbox done', async () => {
    const writes = writeSpies()
    const provider = okProvider()
    const client = makeClient(
      {
        integration_outbox: { read: { data: [OUTBOX_ROW] }, claim: { data: { id: 'ob1' } } },
        external_task_links: { read: { data: null } },
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
      expect.objectContaining({ internal_entity_id: 'flag-1', external_task_gid: 'T100' }),
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
        integration_outbox: { read: { data: [OUTBOX_ROW] }, claim: { data: { id: 'ob1' } } },
        external_task_links: { read: { data: null } },
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

describe('runAsanaOutboxBatch', () => {
  it('stops early when the queue is empty', async () => {
    const provider = okProvider()
    const client = makeClient({ integration_outbox: { read: { data: [] } } }, writeSpies())
    const results = await runAsanaOutboxBatch(client, provider as unknown as TaskProvider, deps, 3)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('no_pending')
    expect(provider.createTask).not.toHaveBeenCalled()
  })

  it('processes up to the batch size', async () => {
    const provider = okProvider()
    const client = makeClient(
      {
        integration_outbox: { read: { data: [OUTBOX_ROW] }, claim: { data: { id: 'ob1' } } },
        external_task_links: { read: { data: null } },
        ...FLAG_TABLES,
      },
      writeSpies(),
    )
    const results = await runAsanaOutboxBatch(client, provider as unknown as TaskProvider, deps, 2)
    expect(results).toHaveLength(2)
    expect(provider.createTask).toHaveBeenCalledTimes(2)
  })
})
