import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dryRunNextAsanaOutbox } from '@/lib/integrations/worker/process-outbox'
import {
  ASANA_TEST_PROJECT_GID,
  ASANA_TEST_SECTION_GIDS,
} from '@/lib/integrations/asana/config'

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

function makeClient(perTable: Record<string, Result>, writes: WriteSpies): SupabaseClient {
  const build = (result: Result): FakeQuery => {
    const q: FakeQuery = {
      select: () => q,
      eq: () => q,
      is: () => q,
      lte: () => q,
      order: () => q,
      limit: async () => result,
      maybeSingle: async () => result,
      insert: (...a) => {
        writes.insert(...a)
        return q
      },
      update: (...a) => {
        writes.update(...a)
        return q
      },
      delete: (...a) => {
        writes.delete(...a)
        return q
      },
      upsert: (...a) => {
        writes.upsert(...a)
        return q
      },
    }
    return q
  }
  return {
    from: (table: string) => build(perTable[table] ?? { data: null }),
  } as unknown as SupabaseClient
}

const OUTBOX_ROW = {
  id: 'ob1',
  company_id: 'good-co',
  entity_type: 'flag',
  entity_id: 'flag-1',
  status: 'pending',
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
    const client = makeClient(
      {
        integration_outbox: { data: [OUTBOX_ROW] },
        flags: { data: FLAG_ROW },
        properties: { data: { name: 'Real Property' } },
        flag_categories: { data: { key: 'maintenance_issue', display_label: 'Broken thing' } },
        profiles: { data: { full_name: 'Quraisha R.' } },
      },
      writes,
    )

    const res = await dryRunNextAsanaOutbox(client, deps)

    expect(res.status).toBe('dry_run_ok')
    if (res.status !== 'dry_run_ok') return

    // Payload is derived from the DB read (project/section/name/link).
    expect(res.payload.projectGid).toBe(ASANA_TEST_PROJECT_GID)
    expect(res.payload.sectionGid).toBe(ASANA_TEST_SECTION_GIDS.maintenance)
    expect(res.payload.name).toBe('[Maintenance] Real Property — Leaking tap')
    expect(res.payload.notes).toContain(
      'Open in app: https://staging.example.com/properties/prop-1/flags/flag-1',
    )

    // No Asana network call.
    expect(fetchSpy).not.toHaveBeenCalled()

    // No DB writes of any kind.
    expect(writes.insert).not.toHaveBeenCalled()
    expect(writes.update).not.toHaveBeenCalled()
    expect(writes.delete).not.toHaveBeenCalled()
    expect(writes.upsert).not.toHaveBeenCalled()
  })
})
