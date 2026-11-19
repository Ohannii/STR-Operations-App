import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * CONTROLLED LIVE TEST — attachments obey the SAME eligibility rule as task
 * creation. Runs the REAL runNextAttachEvidence + createAttachIO against a
 * stateful fake database; only Asana (list / upload) and the PDF builder
 * are mocked. A VALID live-project link exists in every case, so the only
 * thing that can stop an upload is the scope check itself.
 */

const listTaskAttachments = vi.fn(async () => [] as Array<{ name: string }>)
const addAttachmentToTask = vi.fn(async () => {})
vi.mock('server-only', () => ({}))
vi.mock('@/lib/integrations/asana/client', async (orig) => ({
  ...(await orig<typeof import('@/lib/integrations/asana/client')>()),
  listTaskAttachments: (...a: unknown[]) => listTaskAttachments(...(a as [])),
  addAttachmentToTask: (...a: unknown[]) => addAttachmentToTask(...(a as [])),
}))
vi.mock('@/lib/reports/report-data', () => ({
  loadFlagReportData: async () => ({
    propertyName: 'Test 1',
    issueTitle: 'LIVE TEST',
    raisedAtIso: '2026-11-19T08:00:00Z',
    fingerprint: { photos: [] },
  }),
}))
vi.mock('@/lib/reports/ensure-report-artifact', () => ({
  ensureFlagReportBytes: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentHash: 'abc123def456' }),
}))

import { runNextAttachEvidence } from '@/lib/integrations/worker/attach-evidence'

const LIVE_PROJECT = '1211426202387126'
const BETA_PROJECT = '1216372108028101'
const SCOPE_CO = '1669c464-8d26-40fc-9956-9f8955fd27c7'
const SCOPE_PROP = '3ed2a749-0954-4216-8095-2a1bf2af7aaa'
const FLAG = '96487471-8c6e-48bc-828e-26255ad5277d'
const LIVE_ATTACH = 'asana.live.attach_flag_evidence'
const PIN = { destination: 'live_incidents', destination_project_gid: LIVE_PROJECT }

type Row = Record<string, unknown>
type Filter = { op: string; col: string; val: unknown }

function makeDb(over: {
  job?: Row
  flag?: Row | null
  selections?: Row | null
  link?: Row | null
  otherJobs?: Row[]
  fail?: Array<'flags' | 'flag_issue_selections' | 'other_job'>
} = {}) {
  const job: Row = {
    id: 'ob-attach', company_id: SCOPE_CO, provider: 'asana', event_type: LIVE_ATTACH, entity_type: 'flag', entity_id: FLAG,
    status: 'pending', attempt_count: 0, payload: { flag_id: FLAG, content_generation: 1, ...PIN },
    created_at: '2026-11-19T08:00:00Z', available_at: '2026-11-19T08:00:00Z', deleted_at: null, locked_at: null, locked_by: null,
    ...(over.job ?? {}),
  }
  const flag = over.flag === undefined ? { id: FLAG, company_id: SCOPE_CO, property_id: SCOPE_PROP, deleted_at: null } : over.flag
  const selections = over.selections === undefined ? { flag_id: FLAG, company_id: SCOPE_CO, source_pack_photo_id: 'a080d3ca-61b3-4dd5-9a56-87a90135761d' } : over.selections
  const link = over.link === undefined
    ? { company_id: SCOPE_CO, provider: 'asana', internal_entity_type: 'flag', internal_entity_id: FLAG, external_project_gid: LIVE_PROJECT, external_task_gid: 'LIVE-TASK-1', deleted_at: null }
    : over.link
  const outboxRows = [job, ...(over.otherJobs ?? [])]
  const reads: string[] = []
  const matches = (r: Row, fs: Filter[]) =>
    fs.every((f) => {
      const v = f.col.includes('->>') ? String((r.payload as Row)?.[f.col.split('->>')[1]]) : r[f.col]
      if (f.op === 'is') return (v ?? null) === f.val
      if (f.op === 'lte') return String(v) <= String(f.val)
      return v === f.val
    })
  const client = {
    from: (table: string) => {
      const fs: Filter[] = []
      let patch: Row | null = null
      const exec = (many: boolean) => {
        reads.push(table)
        if (table === 'flags') {
          if (over.fail?.includes('flags')) return { data: null, error: { code: 'XX000' } }
          return { data: flag && matches(flag, fs) ? flag : null, error: null }
        }
        if (table === 'flag_issue_selections') {
          if (over.fail?.includes('flag_issue_selections')) return { data: null, error: { code: 'XX000' } }
          return { data: selections && matches(selections, fs) ? selections : null, error: null }
        }
        if (table === 'external_task_links') return { data: link && matches(link, fs) ? link : null, error: null }
        if (table === 'companies') return { data: { name: 'Drop-Inn' }, error: null }
        if (table === 'integration_outbox') {
          const isOtherJobCheck = fs.some((f) => f.col === 'company_id') && !patch
          if (isOtherJobCheck && over.fail?.includes('other_job')) return { data: null, error: { code: 'XX000' } }
          const found = outboxRows.filter((r) => matches(r, fs.filter((f) => f.col !== 'provider')))
          if (patch) {
            for (const r of found) Object.assign(r, patch)
            return many ? { data: found.map((r) => ({ ...r })), error: null } : { data: found[0] ? { ...found[0] } : null, error: null }
          }
          return many ? { data: found.map((r) => ({ ...r })), error: null } : { data: found[0] ? { ...found[0] } : null, error: null }
        }
        return { data: null, error: null }
      }
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => (fs.push({ op: 'eq', col, val }), q),
        is: (col: string, val: unknown) => (fs.push({ op: 'is', col, val }), q),
        lte: (col: string, val: unknown) => (fs.push({ op: 'lte', col, val }), q),
        filter: (col: string, _op: string, val: unknown) => (fs.push({ op: 'eq', col, val }), q),
        order: () => q,
        update: (p: Row) => ((patch = p), q),
        limit: async () => exec(true),
        maybeSingle: async () => exec(false),
        then: (resolve: (v: unknown) => void) => resolve(exec(true)),
      }
      return q
    },
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'x' } }) }) },
  } as unknown as SupabaseClient
  return { client, job, reads }
}

const deps = { allowedCompanyIds: [SCOPE_CO, 'co'], appBaseUrl: 'https://x.example', destination: 'live_incidents' as const, onlyFlagId: FLAG }
const run = (db: ReturnType<typeof makeDb>, d: Record<string, unknown> = deps) =>
  runNextAttachEvidence(db.client, d as never, 'tok')

const expectNoAsanaAndNoLinkLookup = (db: ReturnType<typeof makeDb>) => {
  expect(listTaskAttachments).not.toHaveBeenCalled()
  expect(addAttachmentToTask).not.toHaveBeenCalled()
  expect(db.reads).not.toContain('external_task_links')
  expect(db.job.locked_by).toBeNull() // never claimed
}

beforeEach(() => {
  vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', 'true')
  listTaskAttachments.mockClear()
  addAttachmentToTask.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('live attachment: eligible issue', () => {
  it('Test 1 pack-photo issue with a live link -> the PDF is uploaded to THAT task, job done', async () => {
    const db = makeDb()
    expect(await run(db)).toMatchObject({ status: 'attached', flagId: FLAG, uploaded: 1 })
    expect(addAttachmentToTask).toHaveBeenCalledTimes(1)
    expect((addAttachmentToTask.mock.calls[0] as unknown as [string, { taskGid: string }])[1].taskGid).toBe('LIVE-TASK-1')
    expect(db.job).toMatchObject({ status: 'done', event_type: LIVE_ATTACH })
  })
})

describe('live attachment: REFUSED before any link lookup, listing or upload (a valid live link exists in every case)', () => {
  const refused = async (db: ReturnType<typeof makeDb>, code: string, d: Record<string, unknown> = deps) => {
    expect(await run(db, d)).toMatchObject({ status: 'refused', reason: code })
    expectNoAsanaAndNoLinkLookup(db)
    expect(db.job).toMatchObject({ status: 'dead', last_error: code, event_type: LIVE_ATTACH })
  }

  it('REPRO 1: a flag OUTSIDE Test 1 (another property of the test company)', async () => {
    await refused(makeDb({ flag: { id: FLAG, company_id: SCOPE_CO, property_id: 'another-property', deleted_at: null } }), 'live_test:out_of_scope')
  })

  it('REPRO 2: an ORDINARY flag without pack-photo selections', async () => {
    await refused(makeDb({ selections: null }), 'live_test:not_pack_photo_issue')
  })

  it('selections without a source pack photo', async () => {
    await refused(makeDb({ selections: { flag_id: FLAG, company_id: SCOPE_CO, source_pack_photo_id: null } }), 'live_test:not_pack_photo_issue')
  })

  it('a job from another company naming the in-scope flag', async () => {
    await refused(makeDb({ job: { company_id: 'co' } }), 'live_test:out_of_scope')
  })

  it('a deleted / missing flag', async () => {
    await refused(makeDb({ flag: null }), 'live_test:out_of_scope')
  })

  it('a job without the live destination record', async () => {
    await refused(makeDb({ job: { payload: { flag_id: FLAG, content_generation: 1 } } }), 'live_test:destination_pin_mismatch')
  })

  it('the flag has a BETA create job (it belongs to the other destination)', async () => {
    await refused(
      makeDb({ otherJobs: [{ id: 'ob-beta', company_id: SCOPE_CO, provider: 'asana', event_type: 'asana.create_task_for_flag', entity_type: 'flag', entity_id: FLAG, status: 'done', deleted_at: null }] }),
      'live_test:other_destination_job',
    )
  })
})

describe('live attachment: unknowns and the switch', () => {
  it.each(['flags', 'flag_issue_selections', 'other_job'] as const)('a FAILED %s read -> nothing uploaded, retried later (not retired)', async (which) => {
    const db = makeDb({ fail: [which] })
    expect(await run(db)).toMatchObject({ status: 'error', error: 'live_test:scope_read_failed' })
    expectNoAsanaAndNoLinkLookup(db)
    expect(db.job).toMatchObject({ status: 'pending', attempt_count: 1, last_error: 'live_test:scope_read_failed' })
  })

  it('switch OFF -> the live attach queue is not read at all', async () => {
    vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', '')
    const db = makeDb()
    expect(await run(db)).toMatchObject({ status: 'refused', reason: 'live_test:switched_off' })
    expect(db.reads).toEqual([])
    expect(addAttachmentToTask).not.toHaveBeenCalled()
    expect(db.job.status).toBe('pending')
  })

  it('a BETA attach worker (default destination) never sees the live attach job', async () => {
    const db = makeDb()
    expect(await run(db, { allowedCompanyIds: [SCOPE_CO], appBaseUrl: 'https://x.example' })).toEqual({ status: 'no_pending' })
    expect(addAttachmentToTask).not.toHaveBeenCalled()
    expect(db.job.status).toBe('pending')
  })

  it('an eligible live job whose only link is a BETA task: nothing is uploaded to it (waits for a live link)', async () => {
    const db = makeDb({
      link: { company_id: SCOPE_CO, provider: 'asana', internal_entity_type: 'flag', internal_entity_id: FLAG, external_project_gid: BETA_PROJECT, external_task_gid: 'BETA-TASK-1', deleted_at: null },
    })
    expect(await run(db)).toMatchObject({ status: 'dependency_wait' })
    expect(addAttachmentToTask).not.toHaveBeenCalled()
    expect(listTaskAttachments).not.toHaveBeenCalled()
  })
})
