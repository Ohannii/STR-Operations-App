import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  dryRunNextAsanaOutbox,
  runAsanaOutboxBatch,
  runNextAsanaOutbox,
  type RealRunResult,
} from '@/lib/integrations/worker/process-outbox'
import { BETA_FIELD_CONFIG, configForWrite } from '@/lib/integrations/asana/field-config'
import { createWritableFieldValidationLoader } from '@/lib/integrations/asana/field-schema'
import { AsanaApiError } from '@/lib/integrations/asana/client'
import { ASANA_TEST_PROJECT_GID } from '@/lib/integrations/asana/config'
import {
  AMBIGUOUS_QUARANTINE_MS,
  CREATE_PROTOCOL,
  RECONCILE_SPACING_MS,
  flagMarkerLine,
  LEGACY_MARKER,
} from '@/lib/integrations/worker/create-idempotency'
import type { ProviderTask, TaskPayload, TaskProvider } from '@/lib/integrations/types'
import type { WritableFieldValidation } from '@/lib/integrations/asana/field-validation'

/**
 * Stage 0 — STATEFUL proof of task-creation idempotency. A real in-memory
 * outbox row ENFORCES every .eq()/.lt() condition of every update, and a
 * fake BETA Asana store can create a task and then LOSE the response, as a
 * real network can. Nothing here touches Asana or Supabase.
 */

const FLAG = '0b7c2a3e-4d5f-4a6b-8c9d-0e1f2a3b4c5d'
const OTHER = '9f8e7d6c-5b4a-4321-8fed-cba987654321'
const BASE = 'https://staging.example.com'
const PROP = 'prop-1'
const BETA = ASANA_TEST_PROJECT_GID
const T0 = Date.parse('2026-11-02T10:00:00.000Z')
const MIN = 60_000

type Row = Record<string, unknown>
type Filter = { op: 'eq' | 'lt' | 'lte' | 'is'; col: string; val: unknown }

/** Minimal Supabase stand-in: one outbox row, links, flags + lookups. */
function makeDb(opts: { outbox: Row }) {
  const outbox: Row = { ...opts.outbox }
  const links: Row[] = []
  const flagUpdates: Row[] = []
  /** The flag's write-back target (company 'co'). */
  const flag: Row = { id: FLAG, company_id: 'co', asana_task_url: null }
  /** Custom-field facts: the flag's category key and its photo rows. */
  const fixtures: { categoryKey: string | null; photos: Row[]; photosError: boolean; photoSelects: string[] } = {
    categoryKey: 'inventory_missing',
    photos: [],
    photosError: false,
    photoSelects: [],
  }
  const outboxUpdates: Array<{ patch: Row; filters: Filter[]; matched: boolean }> = []
  const hooks: {
    beforeOutboxWrite?: (patch: Row, filters: Filter[]) => 'fail' | void
    /** Apply the update but RETURN this instead (e.g. a different row id). */
    outboxWriteResult?: (patch: Row) => { data: unknown; error?: unknown } | void
    linkInsertError?: { code: string; message: string } | null
    /** Runs just before a link insert (e.g. a concurrent worker links first). */
    beforeLinkInsert?: () => void
    linkReadError?: boolean
    /** Flag URL updates: 'error' returns a Supabase error; 'crash' throws. */
    flagUpdate?: Array<'error' | 'crash'>
    onFlagRead?: () => void
    flagMissing?: boolean
  } = {}

  const matches = (row: Row, filters: Filter[]) =>
    filters.every((f) => {
      const v = row[f.col]
      if (f.op === 'eq') return v === f.val
      if (f.op === 'is') return v === f.val
      if (f.op === 'lt') return typeof v === 'string' && v < String(f.val)
      if (f.op === 'lte') return typeof v === 'string' && v <= String(f.val)
      return true
    })

  function query(table: string) {
    const filters: Filter[] = []
    let patch: Row | null = null
    let insertRow: Row | null = null
    const q = {
      select: (cols?: string) => {
        if (table === 'photos') fixtures.photoSelects.push(String(cols))
        return q
      },
      eq: (col: string, val: unknown) => (filters.push({ op: 'eq', col, val }), q),
      is: (col: string, val: unknown) => (filters.push({ op: 'is', col, val }), q),
      lt: (col: string, val: unknown) => (filters.push({ op: 'lt', col, val }), q),
      lte: (col: string, val: unknown) => (filters.push({ op: 'lte', col, val }), q),
      order: () => q,
      returns: () => q,
      update: (p: Row) => ((patch = p), q),
      insert: (r: Row) => ((insertRow = r), q),
      limit: async () => {
        if (table === 'photos') {
          if (fixtures.photosError) return { data: null, error: { code: 'XX000', message: 'photos down' } }
          return {
            data: fixtures.photos
              .filter((ph) => matches(ph, filters))
              .map((ph) => ({ id: ph.id, storage_path: ph.storage_path })),
          }
        }
        if (table !== 'integration_outbox') return { data: [] }
        const outboxFilters = filters.filter((f) => !['provider', 'event_type'].includes(f.col))
        return { data: matches(outbox, outboxFilters) ? [{ ...outbox }] : [] }
      },
      maybeSingle: async () => exec(),
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve(exec()).then(resolve, reject),
    }
    function exec(): { data: unknown; error?: unknown } {
      if (table === 'integration_outbox' && patch) {
        const outboxFilters = filters.filter((f) => !['provider'].includes(f.col))
        if (hooks.beforeOutboxWrite?.(patch, filters) === 'fail') {
          outboxUpdates.push({ patch, filters: [...filters], matched: false })
          return { data: null }
        }
        const ok = matches(outbox, outboxFilters)
        outboxUpdates.push({ patch, filters: [...filters], matched: ok })
        if (!ok) return { data: null }
        Object.assign(outbox, patch, { updated_at: new Date().toISOString() })
        const override = hooks.outboxWriteResult?.(patch)
        if (override) return override
        return { data: { id: outbox.id } }
      }
      if (table === 'external_task_links') {
        const active = links.filter((l) => l.deleted_at == null)
        if (insertRow) {
          if (hooks.linkInsertError) {
            const err = hooks.linkInsertError
            hooks.linkInsertError = null
            return { data: null, error: err }
          }
          hooks.beforeLinkInsert?.()
          hooks.beforeLinkInsert = undefined
          const r = insertRow
          // Both partial unique indexes from the foundation migration.
          const dup = links.filter((l) => l.deleted_at == null).some(
            (l) =>
              l.company_id === r.company_id &&
              l.provider === r.provider &&
              ((l.internal_entity_type === r.internal_entity_type &&
                l.internal_entity_id === r.internal_entity_id) ||
                l.external_task_gid === r.external_task_gid),
          )
          if (dup) return { data: null, error: { code: '23505', message: 'duplicate key' } }
          links.push({ ...r, deleted_at: null })
          return { data: null, error: null }
        }
        if (hooks.linkReadError) return { data: null, error: { code: 'XX000', message: 'down' } }
        const found = active.filter((l) => matches(l, filters))
        if (found.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } }
        return { data: found[0] ? { id: 'link', ...found[0] } : null }
      }
      if (table === 'flags' && patch) {
        const mode = hooks.flagUpdate?.shift()
        if (mode === 'crash') throw new Error('worker crashed')
        if (mode === 'error') return { data: null, error: { code: 'XX000', message: 'flag write failed' } }
        if (!matches(flag, filters)) return { data: null }
        flagUpdates.push(patch)
        Object.assign(flag, patch)
        return { data: { id: flag.id } }
      }
      if (table === 'flags') {
        hooks.onFlagRead?.()
        if (hooks.flagMissing) return { data: null }
        return {
          data: {
            id: FLAG,
            description: 'Leaking tap',
            issue_title: null,
            severity: 'med',
            status: 'raised',
            chargeable_party_decision: null,
            raised_at: '2026-11-02T09:59:00Z',
            property_id: PROP,
            flag_category_id: 'cat-1',
            raised_by: 'user-1',
          },
        }
      }
      if (table === 'properties') return { data: { name: 'Unit 50' } }
      if (table === 'flag_categories') return { data: { key: fixtures.categoryKey, display_label: 'Item missing' } }
      if (table === 'profiles') return { data: { full_name: 'Reporter' } }
      return { data: null }
    }
    return q
  }

  const client = { from: (t: string) => query(t) } as unknown as SupabaseClient
  return { client, outbox, links, flag, flagUpdates, outboxUpdates, hooks, fixtures }
}

/** A fake BETA Asana: tasks live here; create can create-then-lose the response. */
function makeAsana() {
  const tasks: ProviderTask[] = []
  let n = 0
  const behaviour: {
    create:
      | 'ok'
      | 'lost_response'
      | 'timeout_after_create'
      | 'reject_400'
      | 'reject_400_if_fields'
      | 'rate_429'
      | 'server_500_no_create'
    lookup: 'ok' | 'fail' | 'rate_429'
    get: 'ok' | 'fail'
  } = { create: 'ok', lookup: 'ok', get: 'ok' }
  const provider = {
    createTask: vi.fn(async (payload: TaskPayload) => {
      const make = () => {
        const gid = `T${++n}`
        tasks.push({ gid, notes: payload.notes, projectGids: [payload.projectGid] })
        return gid
      }
      switch (behaviour.create) {
        case 'reject_400':
          throw new AsanaApiError('create task', 400, 'bad')
        case 'reject_400_if_fields':
          if (payload.customFields) throw new AsanaApiError('create task', 400, 'bad field value')
          return { externalTaskGid: make(), externalTaskUrl: `https://app.asana.com/0/1/T${n}` }
        case 'rate_429':
          throw new AsanaApiError('create task', 429, 'slow', 17)
        case 'server_500_no_create':
          throw new AsanaApiError('create task', 500, 'boom')
        case 'lost_response':
          make()
          throw new TypeError('fetch failed') // Asana created it; we never heard
        case 'timeout_after_create':
          make()
          throw new DOMException('The operation timed out.', 'TimeoutError')
        default: {
          const gid = make()
          return { externalTaskGid: gid, externalTaskUrl: `https://app.asana.com/0/1/${gid}` }
        }
      }
    }),
    getTask: vi.fn(async (_p: string, gid: string) => {
      if (behaviour.get === 'fail') throw new AsanaApiError('read task', 503, 'x')
      return tasks.find((t) => t.gid === gid) ?? null
    }),
    listTasksModifiedSince: vi.fn(async () => {
      if (behaviour.lookup === 'fail') throw new Error('reconciliation pagination is malformed')
      if (behaviour.lookup === 'rate_429') throw new AsanaApiError('reconcile tasks', 429, 'x', 9)
      return tasks.map((t) => ({ ...t }))
    }),
  }
  return { provider: provider as unknown as TaskProvider & typeof provider, tasks, behaviour }
}

function setup(
  payload: Row = { flag_id: FLAG, property_id: PROP, create_protocol: CREATE_PROTOCOL },
  extra: {
    allowedCompanyIds?: string[]
    loadFieldValidation?: () => Promise<WritableFieldValidation>
  } = {},
) {
  const clock = { now: T0 }
  const db = makeDb({
    outbox: {
      id: 'ob1',
      company_id: 'co',
      entity_type: 'flag',
      entity_id: FLAG,
      status: 'pending',
      attempt_count: 0,
      payload,
      created_at: new Date(T0 - MIN).toISOString(),
      available_at: new Date(T0 - MIN).toISOString(),
      deleted_at: null,
      locked_at: null,
      locked_by: null,
    },
  })
  const asana = makeAsana()
  let r = 0
  const deps = {
    allowedCompanyIds: extra.allowedCompanyIds ?? ['co'],
    appBaseUrl: BASE,
    now: () => clock.now,
    newRunId: () => `run-${++r}`,
    ...(extra.loadFieldValidation ? { loadFieldValidation: extra.loadFieldValidation } : {}),
  }
  const run = () => runNextAsanaOutbox(db.client, asana.provider, deps)
  /** Make the row due now (simulates the next cron tick at `clock.now`). */
  const due = () => {
    db.outbox.available_at = new Date(clock.now - 1).toISOString()
  }
  const state = () => db.outbox.payload as Row
  return { clock, db, asana, deps, run, due, state }
}

const posts = (asana: ReturnType<typeof makeAsana>) => asana.provider.createTask.mock.calls.length

// ----------------------------------------------------------------

describe('normal path', () => {
  it('first create: attempt recorded BEFORE the POST, GID saved, link + done', async () => {
    const h = setup()
    const order: string[] = []
    h.db.hooks.beforeOutboxWrite = (patch) => {
      const p = patch.payload as Row | undefined
      if (p?.create_attempted_at && !p.created_task_gid) order.push('attempt-saved')
      if (p?.created_task_gid) order.push('gid-saved')
    }
    h.asana.provider.createTask.mockImplementationOnce(async (payload: TaskPayload) => {
      order.push('POST')
      h.asana.tasks.push({ gid: 'T1', notes: payload.notes, projectGids: [payload.projectGid] })
      return { externalTaskGid: 'T1', externalTaskUrl: 'https://app.asana.com/0/1/T1' }
    })
    const res = await h.run()
    expect(res).toMatchObject({ status: 'created', externalTaskGid: 'T1' })
    expect(order.slice(0, 3)).toEqual(['attempt-saved', 'POST', 'gid-saved'])
    expect(h.db.links).toHaveLength(1)
    expect(h.db.outbox.status).toBe('done')
    expect(h.state()).toMatchObject({ flag_id: FLAG, property_id: PROP, created_task_gid: 'T1' })
    expect(h.asana.provider.listTasksModifiedSince).not.toHaveBeenCalled() // untouched row: no lookup
  })

  it('(5) EVERY outbox write after the claim is conditioned on id + processing + locked_by', async () => {
    const h = setup()
    await h.run()
    const afterClaim = h.db.outboxUpdates.slice(1)
    expect(afterClaim.length).toBeGreaterThan(1)
    for (const u of afterClaim) {
      const eq = Object.fromEntries(u.filters.filter((f) => f.op === 'eq').map((f) => [f.col, f.val]))
      expect(eq).toEqual({ id: 'ob1', status: 'processing', locked_by: 'run-1' })
    }
  })

  it('(4) if the attempt cannot be recorded, NO create request is sent', async () => {
    const h = setup()
    h.db.hooks.beforeOutboxWrite = (patch) =>
      (patch.payload as Row | undefined)?.create_attempted_at ? 'fail' : undefined
    const res = await h.run()
    expect(res.status).toBe('lost_lock')
    expect(posts(h.asana)).toBe(0)
  })

  it('(5) a lock lost to another run (locked_by changed) aborts before any POST', async () => {
    const h = setup()
    h.db.hooks.onFlagRead = () => {
      h.db.outbox.locked_by = 'someone-else'
    }
    const res = await h.run()
    expect(res.status).toBe('lost_lock')
    expect(posts(h.asana)).toBe(0)
  })
})

describe('ambiguous outcomes are reconciled, never blindly retried', () => {
  it('(6) Asana created it but the response was lost: the retry ADOPTS it, no second POST', async () => {
    const h = setup()
    h.asana.behaviour.create = 'lost_response'
    expect(await h.run()).toMatchObject({ status: 'error', error: 'create_ambiguous' })
    expect(h.asana.tasks).toHaveLength(1)
    h.asana.behaviour.create = 'ok'
    h.clock.now += 5 * MIN
    h.due()
    expect(await h.run()).toMatchObject({ status: 'adopted', externalTaskGid: 'T1' })
    expect(posts(h.asana)).toBe(1)
    expect(h.asana.tasks).toHaveLength(1)
    expect(h.db.links).toHaveLength(1)
  })

  it('(17) a TIMEOUT and a 5xx are ambiguous: the next run looks up before any POST', async () => {
    for (const mode of ['timeout_after_create', 'server_500_no_create'] as const) {
      const h = setup()
      h.asana.behaviour.create = mode
      expect(await h.run()).toMatchObject({ error: 'create_ambiguous' })
      expect(h.state().create_attempted_at).toBeTruthy()
      h.asana.behaviour.create = 'ok'
      h.clock.now += 5 * MIN
      h.due()
      await h.run()
      expect(h.asana.provider.listTasksModifiedSince).toHaveBeenCalledTimes(1)
      expect(posts(h.asana)).toBe(1) // never re-POSTed straight away
    }
  })

  it('(7) worker crashes after the 2xx, before saving the GID: reconciliation adopts EXACTLY one task', async () => {
    const h = setup()
    h.db.hooks.beforeOutboxWrite = (patch) =>
      (patch.payload as Row | undefined)?.created_task_gid ? 'fail' : undefined
    expect((await h.run()).status).toBe('lost_lock') // task exists in Asana, GID not saved
    expect(h.db.outbox.status).toBe('processing')
    h.db.hooks.beforeOutboxWrite = undefined
    // 6 minutes later the stale reset hands the row to a NEW run.
    h.clock.now += 6 * MIN
    const results = await runAsanaOutboxBatch(h.db.client, h.asana.provider, h.deps, 1)
    expect(results[0]).toMatchObject({ status: 'adopted', externalTaskGid: 'T1' })
    expect(posts(h.asana)).toBe(1)
    expect(h.asana.tasks).toHaveLength(1)
  })

  it('(8) link insert fails: the retry REUSES the saved GID and never POSTs again', async () => {
    const h = setup()
    h.db.hooks.linkInsertError = { code: 'XX000', message: 'db down' }
    expect(await h.run()).toMatchObject({ status: 'error', error: 'link_insert_failed' })
    expect(h.state().created_task_gid).toBe('T1')
    h.clock.now += 5 * MIN
    h.due()
    expect(await h.run()).toMatchObject({ status: 'adopted', externalTaskGid: 'T1' })
    expect(posts(h.asana)).toBe(1)
    expect(h.asana.provider.listTasksModifiedSince).not.toHaveBeenCalled() // saved GID path, no lookup
  })
})

describe('two-check quarantine before any replacement attempt', () => {
  async function ambiguousNothingCreated() {
    const h = setup()
    h.asana.behaviour.create = 'server_500_no_create'
    await h.run()
    h.asana.behaviour.create = 'ok'
    return h
  }

  it('(9) ONE not-found reconciliation never POSTs', async () => {
    const h = await ambiguousNothingCreated()
    h.clock.now += 30 * MIN
    h.due()
    expect(await h.run()).toMatchObject({ status: 'rescheduled', code: 'reconcile_not_found' })
    expect(posts(h.asana)).toBe(1)
    expect(h.state().reconciliation_not_found_count).toBe(1)
  })

  it('(10) two misses TOO CLOSE together never POST', async () => {
    const h = await ambiguousNothingCreated()
    h.clock.now += 11 * MIN
    h.due()
    await h.run()
    h.clock.now += RECONCILE_SPACING_MS - MIN // forced early tick
    h.due()
    expect(await h.run()).toMatchObject({ status: 'rescheduled' })
    expect(h.state().reconciliation_not_found_count).toBe(1)
    expect(posts(h.asana)).toBe(1)
  })

  it('(10b) two spaced misses but younger than the quarantine never POST', async () => {
    const h = await ambiguousNothingCreated()
    h.clock.now += 1 * MIN
    h.due()
    await h.run()
    h.clock.now += RECONCILE_SPACING_MS // 6 min after the attempt (< 10)
    h.due()
    expect(await h.run()).toMatchObject({ status: 'rescheduled' })
    expect(h.state().reconciliation_not_found_count).toBe(2)
    expect(posts(h.asana)).toBe(1)
  })

  it('(11) two properly spaced misses after >= 10 minutes permit ONE replacement attempt', async () => {
    const h = await ambiguousNothingCreated()
    h.clock.now += 5 * MIN
    h.due()
    await h.run() // miss 1 at +5
    h.clock.now = T0 + AMBIGUOUS_QUARANTINE_MS
    h.due()
    const res = await h.run() // miss 2 at +10 -> replacement
    expect(res).toMatchObject({ status: 'created', externalTaskGid: 'T1' })
    expect(posts(h.asana)).toBe(2)
    expect(h.asana.tasks).toHaveLength(1)
    // The replacement re-recorded a fresh attempt with reset counters.
    expect(h.state()).toMatchObject({ reconciliation_not_found_count: 0, last_reconciled_at: null })
  })

  it('(12) a lookup failure or broken pagination NEVER POSTs (and 429 waits Retry-After)', async () => {
    const h = await ambiguousNothingCreated()
    h.asana.behaviour.lookup = 'fail'
    h.clock.now += 30 * MIN
    h.due()
    expect(await h.run()).toMatchObject({ status: 'error', error: 'reconcile_lookup_failed' })
    h.asana.behaviour.lookup = 'rate_429'
    h.clock.now += 30 * MIN
    h.due()
    const before = h.db.outbox.attempt_count
    expect(await h.run()).toMatchObject({ status: 'rescheduled', code: 'reconcile_lookup_failed' })
    expect(h.db.outbox.attempt_count).toBe(before)
    expect(h.db.outbox.available_at).toBe(new Date(h.clock.now + 9_000).toISOString())
    expect(posts(h.asana)).toBe(1)
  })

  it('(13) TWO marker matches: manual review, task GIDs reported, nothing created or deleted', async () => {
    const h = setup()
    h.asana.behaviour.create = 'lost_response'
    await h.run()
    h.asana.tasks.push({ gid: 'T2', notes: `copy\n${flagMarkerLine(FLAG)}`, projectGids: [BETA] })
    h.clock.now += 5 * MIN
    h.due()
    const res = (await h.run()) as Extract<RealRunResult, { status: 'manual_review' }>
    expect(res).toMatchObject({ status: 'manual_review', code: 'manual_review:duplicate_tasks' })
    expect(res.taskGids?.sort()).toEqual(['T1', 'T2'])
    expect(h.db.outbox.status).toBe('dead')
    expect(h.db.outbox.last_error).toBe('manual_review:duplicate_tasks')
    expect(h.asana.tasks).toHaveLength(2) // nothing deleted
    expect(posts(h.asana)).toBe(1)
    expect(h.db.links).toHaveLength(0) // neither silently adopted
  })

  it('(18) another flag’s marker or a loose substring is NOT a match', async () => {
    const h = await ambiguousNothingCreated()
    h.asana.tasks.push(
      { gid: 'X1', notes: flagMarkerLine(OTHER), projectGids: [BETA] },
      { gid: 'X2', notes: `${flagMarkerLine(FLAG)} (copied)`, projectGids: [BETA] },
      { gid: 'X3', notes: `see ${FLAG}`, projectGids: [BETA] },
    )
    h.clock.now += 5 * MIN
    h.due()
    expect(await h.run()).toMatchObject({ status: 'rescheduled', code: 'reconcile_not_found' })
    expect(h.db.links).toHaveLength(0)
  })
})

describe('saved task GID: verified, never recreated', () => {
  function withSavedGid(gid: string) {
    return setup({
      flag_id: FLAG,
      create_protocol: CREATE_PROTOCOL,
      create_marker: flagMarkerLine(FLAG),
      create_attempted_at: new Date(T0 - 2 * MIN).toISOString(),
      created_task_gid: gid,
    })
  }

  it('(14) a matching saved task skips creation and finishes the write-backs', async () => {
    const h = withSavedGid('T7')
    h.asana.tasks.push({ gid: 'T7', notes: `x\n${flagMarkerLine(FLAG)}`, projectGids: [BETA] })
    expect(await h.run()).toMatchObject({ status: 'adopted', externalTaskGid: 'T7' })
    expect(posts(h.asana)).toBe(0)
    expect(h.db.outbox.status).toBe('done')
  })

  it('(15) saved GID returns 404: manual review, NEVER recreated', async () => {
    const h = withSavedGid('GONE')
    expect(await h.run()).toMatchObject({ status: 'manual_review', code: 'manual_review:saved_task_missing' })
    expect(posts(h.asana)).toBe(0)
    expect(h.db.outbox.status).toBe('dead')
  })

  it('(15b) saved GID whose marker or project does not match: manual review', async () => {
    const h = withSavedGid('T8')
    h.asana.tasks.push({ gid: 'T8', notes: flagMarkerLine(OTHER), projectGids: [BETA] })
    expect(await h.run()).toMatchObject({ code: 'manual_review:saved_task_mismatch' })
    const h2 = withSavedGid('T9')
    h2.asana.tasks.push({ gid: 'T9', notes: flagMarkerLine(FLAG), projectGids: ['1211426202387126'] })
    expect(await h2.run()).toMatchObject({ code: 'manual_review:saved_task_mismatch' })
    expect(posts(h.asana) + posts(h2.asana)).toBe(0)
  })

  it('a transient read failure of the saved task reschedules, never creates', async () => {
    const h = withSavedGid('T7')
    h.asana.behaviour.get = 'fail'
    expect(await h.run()).toMatchObject({ status: 'error', error: 'saved_task_read_failed' })
    expect(h.db.outbox.status).toBe('pending')
    expect(posts(h.asana)).toBe(0)
  })
})

describe('definite outcomes', () => {
  it('(16) 429 on create: Retry-After respected, attempt NOT consumed, no immediate create', async () => {
    const h = setup()
    h.asana.behaviour.create = 'rate_429'
    expect(await h.run()).toMatchObject({ status: 'rescheduled', code: 'create_rate_limited' })
    expect(h.db.outbox.attempt_count).toBe(0)
    expect(h.db.outbox.available_at).toBe(new Date(T0 + 17_000).toISOString())
    expect(h.state().create_attempted_at).toBeNull() // 429 = not processed
    expect(await h.run()).toMatchObject({ status: 'no_pending' }) // not due yet
  })

  it('400 rejection: nothing was created, so the next run creates WITHOUT a lookup', async () => {
    const h = setup()
    h.asana.behaviour.create = 'reject_400'
    expect(await h.run()).toMatchObject({ status: 'error', error: 'create_rejected_http_400' })
    expect(h.state().create_attempted_at).toBeNull()
    h.asana.behaviour.create = 'ok'
    h.clock.now += 5 * MIN
    h.due()
    expect(await h.run()).toMatchObject({ status: 'created' })
    expect(h.asana.provider.listTasksModifiedSince).not.toHaveBeenCalled()
  })
})

describe('(19) legacy in-flight rows (enqueued before Stage 0)', () => {
  const legacyPayload = { flag_id: FLAG, property_id: PROP } // no create_protocol
  const route = `/properties/${PROP}/flags/${FLAG}`
  const legacyLine = (origin: string, path = route) => `Open in app: ${origin}${path}`

  it('reconciles by the EXACT "Open in app:" route and adopts — never by name', async () => {
    const h = setup(legacyPayload)
    h.asana.tasks.push({ gid: 'L1', notes: `Property: Unit 50\n\n${legacyLine(BASE)}\n\n- Auto-created`, projectGids: [BETA] })
    expect(await h.run()).toMatchObject({ status: 'adopted', externalTaskGid: 'L1' })
    expect(posts(h.asana)).toBe(0)
    expect(h.state()).toMatchObject({ create_marker: LEGACY_MARKER, created_task_gid: 'L1' })
  })

  it('APP_BASE_URL CHANGED: a different valid origin with the exact route is still adopted', async () => {
    const h = setup(legacyPayload) // worker now runs with BASE; the task was made elsewhere
    h.asana.tasks.push({ gid: 'L9', notes: legacyLine('https://old-preview-123.vercel.app'), projectGids: [BETA] })
    expect(await h.run()).toMatchObject({ status: 'adopted', externalTaskGid: 'L9' })
    expect(posts(h.asana)).toBe(0)
  })

  it('same origin but wrong flag / property, loose UUID text, extra segment, query trick, malformed URL or a name: NOT adopted', async () => {
    const h = setup(legacyPayload)
    h.asana.tasks.push(
      { gid: 'W1', notes: legacyLine(BASE, `/properties/${PROP}/flags/${OTHER}`), projectGids: [BETA] },
      { gid: 'W2', notes: legacyLine(BASE, `/properties/prop-2/flags/${FLAG}`), projectGids: [BETA] },
      { gid: 'W3', notes: `About flag ${FLAG} ${route}`, projectGids: [BETA] },
      { gid: 'W4', notes: legacyLine(BASE, `${route}/edit`), projectGids: [BETA] },
      { gid: 'W5', notes: legacyLine(BASE, `/?next=${route}`), projectGids: [BETA] },
      { gid: 'W6', notes: `Open in app: https://${route}`, projectGids: [BETA] },
      { gid: 'W7', notes: legacyLine('https://x.app', `/a/..${route}`), projectGids: [BETA] },
      { gid: 'W8', notes: 'Leaking tap — Unit 50 [Inventory]', projectGids: [BETA] },
    )
    expect(await h.run()).toMatchObject({ status: 'rescheduled', code: 'reconcile_not_found' })
    expect(posts(h.asana)).toBe(0)
    expect(h.db.links).toHaveLength(0)
  })

  it('protocol-2 rows NEVER match by the legacy route (only STR-APP-REF)', async () => {
    const h = setup()
    h.asana.behaviour.create = 'server_500_no_create'
    await h.run()
    h.asana.tasks.push({ gid: 'L5', notes: legacyLine(BASE), projectGids: [BETA] })
    h.clock.now += 5 * MIN
    h.due()
    expect(await h.run()).toMatchObject({ status: 'rescheduled', code: 'reconcile_not_found' })
    expect(h.db.links).toHaveLength(0)
  })

  it('a saved legacy GID is verified by the route (origin ignored), never by base URL', async () => {
    const h = setup({
      ...legacyPayload,
      create_marker: LEGACY_MARKER,
      create_attempted_at: new Date(T0 - 2 * MIN).toISOString(),
      created_task_gid: 'L6',
    })
    h.asana.tasks.push({ gid: 'L6', notes: legacyLine('https://another.example'), projectGids: [BETA] })
    expect(await h.run()).toMatchObject({ status: 'adopted', externalTaskGid: 'L6' })
    expect(posts(h.asana)).toBe(0)
  })

  it('nothing found: the same two-check quarantine, THEN one create with the new marker', async () => {
    const h = setup(legacyPayload)
    expect(await h.run()).toMatchObject({ status: 'rescheduled' }) // first observation: miss 1
    expect(posts(h.asana)).toBe(0)
    h.clock.now += AMBIGUOUS_QUARANTINE_MS
    h.due()
    expect(await h.run()).toMatchObject({ status: 'created' })
    expect(posts(h.asana)).toBe(1)
    expect(h.asana.tasks[0].notes).toContain(flagMarkerLine(FLAG))
    expect(h.state().create_protocol).toBe(CREATE_PROTOCOL)
  })
})

describe('conditional writes must PROVE the expected row was updated', () => {
  it('an update that returns a DIFFERENT row id is a lost lock: no Asana request', async () => {
    const h = setup()
    h.db.hooks.outboxWriteResult = (patch) =>
      (patch.payload as Row | undefined)?.create_attempted_at ? { data: { id: 'some-other-row' } } : undefined
    expect(await h.run()).toMatchObject({ status: 'lost_lock' })
    expect(posts(h.asana)).toBe(0)
    expect(h.asana.provider.listTasksModifiedSince).not.toHaveBeenCalled()
  })

  it('an update that returns no row, or an error, is a lost lock: no Asana request', async () => {
    for (const result of [{ data: null }, { data: null, error: { code: 'PGRST116', message: 'x' } }, { data: [{ id: 'ob1' }] }]) {
      const h = setup()
      h.db.hooks.outboxWriteResult = (patch) =>
        (patch.payload as Row | undefined)?.create_attempted_at ? result : undefined
      expect(await h.run()).toMatchObject({ status: 'lost_lock' })
      expect(posts(h.asana)).toBe(0)
    }
  })

  it('a claim that returns a different row id is NOT a claim: skipped, nothing else happens', async () => {
    const h = setup()
    h.db.hooks.outboxWriteResult = (patch) => (patch.status === 'processing' ? { data: { id: 'x' } } : undefined)
    expect(await h.run()).toMatchObject({ status: 'skipped' })
    expect(posts(h.asana)).toBe(0)
    expect(h.db.outboxUpdates).toHaveLength(1)
  })

  it('a failed conditional write on a LEGACY row (before reconciliation) sends no lookup and no POST', async () => {
    const h = setup({ flag_id: FLAG, property_id: PROP })
    h.db.hooks.beforeOutboxWrite = (patch) => ((patch.payload as Row | undefined)?.create_marker ? 'fail' : undefined)
    expect(await h.run()).toMatchObject({ status: 'lost_lock' })
    expect(h.asana.provider.listTasksModifiedSince).not.toHaveBeenCalled()
    expect(posts(h.asana)).toBe(0)
  })
})

describe('EVERY terminal / manual-review / retry write is conditioned on id + processing + locked_by', () => {
  const ownedEq = (h: ReturnType<typeof setup>) =>
    h.db.outboxUpdates.slice(1).map((u) =>
      Object.fromEntries(u.filters.filter((f) => f.op === 'eq').map((f) => [f.col, f.val])),
    )

  const scenarios: Array<[string, () => Promise<ReturnType<typeof setup>>, string]> = [
    ['done (created)', async () => { const h = setup(); await h.run(); return h }, 'done'],
    ['retry (ambiguous)', async () => { const h = setup(); h.asana.behaviour.create = 'server_500_no_create'; await h.run(); return h }, 'pending'],
    ['reschedule (429)', async () => { const h = setup(); h.asana.behaviour.create = 'rate_429'; await h.run(); return h }, 'pending'],
    ['manual review (saved task missing)', async () => {
      const h = setup({ flag_id: FLAG, create_protocol: CREATE_PROTOCOL, create_marker: flagMarkerLine(FLAG), create_attempted_at: new Date(T0).toISOString(), created_task_gid: 'GONE' })
      await h.run(); return h
    }, 'dead'],
    ['manual review (duplicates)', async () => {
      const h = setup(); h.asana.behaviour.create = 'lost_response'; await h.run()
      h.asana.tasks.push({ gid: 'T2', notes: flagMarkerLine(FLAG), projectGids: [BETA] })
      h.clock.now += 5 * MIN; h.due(); h.db.outboxUpdates.length = 0; await h.run(); return h
    }, 'dead'],
    ['dead (flag not found)', async () => { const h = setup(); h.db.hooks.flagMissing = true; await h.run(); return h }, 'dead'],
    ['dead (company refused)', async () => { const h = setup(undefined, { allowedCompanyIds: ['other'] }); await h.run(); return h }, 'dead'],
  ]

  it.each(scenarios)('%s', async (_l, make, finalStatus) => {
    const h = await make()
    expect(h.db.outbox.status).toBe(finalStatus)
    expect(h.db.outboxUpdates[0].patch.status).toBe('processing') // the claim
    const runId = h.db.outboxUpdates[0].patch.locked_by
    const owned = ownedEq(h)
    expect(owned.length).toBeGreaterThan(0)
    for (const eq of owned) expect(eq).toEqual({ id: 'ob1', status: 'processing', locked_by: runId })
    expect(h.db.outbox.locked_by).toBeNull()
  })
})

describe('429 never consumes — and never refunds — a normal attempt', () => {
  it('two consecutive create 429s: attempt_count stays 0, each waits Retry-After, then creates', async () => {
    const h = setup()
    h.asana.behaviour.create = 'rate_429'
    expect(await h.run()).toMatchObject({ status: 'rescheduled', code: 'create_rate_limited' })
    expect(h.db.outbox.attempt_count).toBe(0)
    h.clock.now += 17_000
    h.due()
    expect(await h.run()).toMatchObject({ status: 'rescheduled', code: 'create_rate_limited' })
    expect(h.db.outbox.attempt_count).toBe(0)
    expect(h.db.outbox.available_at).toBe(new Date(h.clock.now + 17_000).toISOString())
    h.asana.behaviour.create = 'ok'
    h.clock.now += 17_000
    h.due()
    expect(await h.run()).toMatchObject({ status: 'created' })
    expect(h.db.outbox.attempt_count).toBe(0)
    expect(posts(h.asana)).toBe(3)
    expect(h.asana.tasks).toHaveLength(1)
    // No write in the whole sequence touched attempt_count (claim included).
    expect(h.db.outboxUpdates.every((u) => !('attempt_count' in u.patch))).toBe(true)
  })

  it('429s AFTER a consumed attempt neither consume another nor refund it (never negative)', async () => {
    const h = setup()
    h.asana.behaviour.create = 'reject_400'
    await h.run()
    expect(h.db.outbox.attempt_count).toBe(1)
    h.asana.behaviour.create = 'rate_429'
    for (let i = 0; i < 2; i++) {
      h.clock.now += 6 * MIN
      h.due()
      expect(await h.run()).toMatchObject({ status: 'rescheduled' })
      expect(h.db.outbox.attempt_count).toBe(1)
    }
  })

  it('two consecutive LOOKUP 429s during reconciliation: no attempt consumed, no POST', async () => {
    const h = setup()
    h.asana.behaviour.create = 'server_500_no_create'
    await h.run()
    expect(h.db.outbox.attempt_count).toBe(1)
    h.asana.behaviour.lookup = 'rate_429'
    for (let i = 0; i < 2; i++) {
      h.clock.now += 6 * MIN
      h.due()
      expect(await h.run()).toMatchObject({ status: 'rescheduled', code: 'reconcile_lookup_failed' })
      expect(h.db.outbox.attempt_count).toBe(1)
    }
    expect(posts(h.asana)).toBe(1)
  })
})

describe('write-backs: never "done" before the link is proven and the flag URL is written', () => {
  const link = (over: Row = {}): Row => ({
    company_id: 'co',
    provider: 'asana',
    internal_entity_type: 'flag',
    internal_entity_id: FLAG,
    external_task_gid: 'T1',
    external_task_url: 'https://app.asana.com/0/1/T1',
    deleted_at: null,
    ...over,
  })

  it('crash AFTER the link insert, BEFORE the flag URL update: the retry restores the URL, no second POST', async () => {
    const h = setup()
    h.db.hooks.flagUpdate = ['crash']
    await expect(h.run()).rejects.toThrow('worker crashed')
    expect(h.db.links).toHaveLength(1)
    expect(h.db.flag.asana_task_url).toBeNull()
    expect(h.db.outbox.status).toBe('processing') // never marked done
    h.clock.now += 6 * MIN // stale reset hands it to a new run
    const [res] = await runAsanaOutboxBatch(h.db.client, h.asana.provider, h.deps, 1)
    expect(res).toMatchObject({ status: 'already_linked' })
    expect(h.db.flag.asana_task_url).toBe('https://app.asana.com/0/1/T1')
    expect(h.db.outbox.status).toBe('done')
    expect(posts(h.asana)).toBe(1)
  })

  it('flag URL update FAILS: retry (value-free code, GID kept), then a successful retry — exactly one POST', async () => {
    const h = setup()
    h.db.hooks.flagUpdate = ['error']
    expect(await h.run()).toMatchObject({ status: 'error', error: 'flag_url_update_failed' })
    expect(h.db.outbox).toMatchObject({ status: 'pending', last_error: 'flag_url_update_failed', attempt_count: 1 })
    expect(h.state().created_task_gid).toBe('T1')
    expect(h.db.flag.asana_task_url).toBeNull()
    expect(JSON.stringify(h.db.outboxUpdates)).not.toContain('flag write failed')
    h.clock.now += 5 * MIN
    h.due()
    expect(await h.run()).toMatchObject({ status: 'already_linked' })
    expect(h.db.flag.asana_task_url).toBe('https://app.asana.com/0/1/T1')
    expect(h.db.outbox.status).toBe('done')
    expect(posts(h.asana)).toBe(1)
  })

  it('flag URL update that touches NO row (e.g. wrong company) is a failure, not done', async () => {
    const h = setup()
    h.db.flag.company_id = 'another-co'
    expect(await h.run()).toMatchObject({ status: 'error', error: 'flag_url_update_failed' })
    expect(h.db.outbox.status).toBe('pending')
  })

  it('an existing link restores a MISSING flag URL without any Asana call', async () => {
    const h = setup()
    h.db.links.push(link({ external_task_gid: 'T5', external_task_url: 'https://app.asana.com/0/1/T5' }))
    expect(await h.run()).toMatchObject({ status: 'already_linked' })
    expect(h.db.flag.asana_task_url).toBe('https://app.asana.com/0/1/T5')
    expect(h.db.outbox.status).toBe('done')
    expect(posts(h.asana)).toBe(0)
    expect(h.asana.provider.getTask).not.toHaveBeenCalled()
    expect(h.asana.provider.listTasksModifiedSince).not.toHaveBeenCalled()
  })

  it('existing link but the flag URL write fails: NOT done, retried, still no POST', async () => {
    const h = setup()
    h.db.links.push(link())
    h.db.hooks.flagUpdate = ['error']
    expect(await h.run()).toMatchObject({ status: 'error', error: 'flag_url_update_failed' })
    expect(h.db.outbox.status).toBe('pending')
    expect(posts(h.asana)).toBe(0)
  })

  it('the existing-link lookup is COMPANY-scoped: another company’s link is ignored', async () => {
    const h = setup()
    h.db.links.push(link({ company_id: 'other-co', external_task_gid: 'X9', external_task_url: 'https://app.asana.com/0/1/X9' }))
    expect(await h.run()).toMatchObject({ status: 'created', externalTaskGid: 'T1' })
    expect(h.db.flag.asana_task_url).toBe('https://app.asana.com/0/1/T1')
    const preCheck = h.db.links.filter((l) => l.company_id === 'co')
    expect(preCheck).toHaveLength(1)
  })

  it('a link-read failure retries and never creates', async () => {
    const h = setup()
    h.db.hooks.linkReadError = true
    expect(await h.run()).toMatchObject({ status: 'error', error: 'link_read_failed' })
    expect(posts(h.asana)).toBe(0)
  })

  it('23505 where the active link is the SAME task: completes safely (flag URL written, done)', async () => {
    const h = setup()
    h.db.hooks.beforeLinkInsert = () => h.db.links.push(link()) // a concurrent run linked T1 first
    expect(await h.run()).toMatchObject({ status: 'created', externalTaskGid: 'T1' })
    expect(h.db.links).toHaveLength(1)
    expect(h.db.flag.asana_task_url).toBe('https://app.asana.com/0/1/T1')
    expect(h.db.outbox.status).toBe('done')
  })

  it('23505 where the active link is a DIFFERENT task: manual review, flag URL untouched, nothing deleted', async () => {
    const h = setup()
    h.db.flag.asana_task_url = 'https://app.asana.com/0/1/T-OLD'
    h.db.hooks.beforeLinkInsert = () =>
      h.db.links.push(link({ external_task_gid: 'T-OTHER', external_task_url: 'https://app.asana.com/0/1/T-OTHER' }))
    const res = await h.run()
    expect(res).toMatchObject({ status: 'manual_review', code: 'manual_review:link_conflict', taskGids: ['T1', 'T-OTHER'] })
    expect(h.db.flag.asana_task_url).toBe('https://app.asana.com/0/1/T-OLD')
    expect(h.db.flagUpdates).toHaveLength(0)
    expect(h.db.outbox.status).toBe('dead')
    expect(h.state().created_task_gid).toBe('T1') // kept for the reviewer
    expect(h.db.links).toHaveLength(1)
    expect(h.asana.tasks).toHaveLength(1) // nothing deleted
  })

  it('23505 that NO active link for this flag explains (task GID linked to another flag): manual review', async () => {
    const h = setup()
    h.db.hooks.beforeLinkInsert = () => h.db.links.push(link({ internal_entity_id: OTHER })) // T1 on another flag
    expect(await h.run()).toMatchObject({ status: 'manual_review', code: 'manual_review:link_conflict', taskGids: ['T1'] })
    expect(h.db.flagUpdates).toHaveLength(0)
    expect(h.db.outbox.status).toBe('dead')
  })

  it('a plain 23505 with no matching link at all is NOT treated as success', async () => {
    const h = setup()
    h.db.hooks.linkInsertError = { code: '23505', message: 'duplicate key' }
    expect(await h.run()).toMatchObject({ status: 'manual_review', code: 'manual_review:link_conflict' })
    expect(h.db.flagUpdates).toHaveLength(0)
  })
})

describe('refused-company row', () => {
  it('terminal write that loses its lock returns lost_lock, not refused', async () => {
    const h = setup(undefined, { allowedCompanyIds: ['other'] })
    h.db.hooks.beforeOutboxWrite = (patch) => (patch.status === 'dead' ? 'fail' : undefined)
    expect(await h.run()).toMatchObject({ status: 'lost_lock', outboxId: 'ob1', flagId: FLAG })
    expect(h.db.outbox.status).toBe('processing')
    expect(posts(h.asana)).toBe(0)
  })

  it('normal case still retires the row as refused', async () => {
    const h = setup(undefined, { allowedCompanyIds: ['other'] })
    expect(await h.run()).toMatchObject({ status: 'refused' })
    expect(h.db.outbox.status).toBe('dead')
  })
})

// ================================================================
// BETA custom fields (Category, INVENTORY type, Evidence Received)
// ================================================================

const F = {
  unit: '1213116492387386',
  unitNumber: '1210401516520213',
  category: '1220057630679849',
  inventoryType: '1220057630679854',
  linenType: '1220057561518787',
  evidence: '1220057561518792',
  accountable: '1220057561518796',
}
const O = {
  inventory: '1220057630679850',
  maintenance: '1220057630679851',
  missing: '1220057561518784',
  damage: '1220057561518785',
  yes: '1220057561518793',
  no: '1220057561518794',
}

type Setting = { project: { gid: string }; custom_field: Record<string, unknown> }

/** A BETA-shaped custom_field_settings response built from the config (GIDs only). */
function betaMetadata(mutate?: (byGid: Map<string, Setting>) => void) {
  const byGid = new Map<string, Setting>()
  for (const spec of Object.values(BETA_FIELD_CONFIG.fields)) {
    if (!spec) continue
    const isEnum = spec.type === 'enum' || spec.type === 'multi_enum'
    const optionGids = spec.dynamicOptions ? ['1213116492387387'] : Object.values(spec.options ?? {})
    if (spec.gid === F.evidence) optionGids.push(O.no) // "No" exists in BETA
    byGid.set(spec.gid, {
      project: { gid: BETA },
      custom_field: {
        gid: spec.gid,
        resource_subtype: spec.type,
        ...(isEnum ? { enum_options: optionGids.map((gid) => ({ gid, enabled: true })) } : {}),
      },
    })
  }
  mutate?.(byGid)
  return { gid: BETA, custom_field_settings: [...byGid.values()] }
}

function loaderFor(fetchSchema: () => Promise<unknown>) {
  const fetchMock = vi.fn(fetchSchema)
  const load = createWritableFieldValidationLoader('tok', configForWrite(BETA), fetchMock)
  const spy = vi.fn(load)
  return { load: spy, fetchMock }
}
const goodLoader = () => loaderFor(async () => betaMetadata())

const photo = (id: string, over: Row = {}): Row => ({
  id,
  company_id: 'co',
  flag_id: FLAG,
  sync_status: 'synced',
  deleted_at: null,
  bytes_deleted_at: null,
  storage_path: `companies/co/flags/${FLAG}/${id}.jpg`,
  ...over,
})

function fieldsSetup(categoryKey: string | null, photos: Row[] = [photo('p1')], loader = goodLoader()) {
  const h = setup(undefined, { loadFieldValidation: loader.load })
  h.db.fixtures.categoryKey = categoryKey
  h.db.fixtures.photos = photos
  return { ...h, loader }
}
const sent = (h: { asana: ReturnType<typeof makeAsana> }, i = 0) =>
  h.asana.provider.createTask.mock.calls[i][0] as TaskPayload

describe('BETA custom fields — happy paths (exactly one POST each)', () => {
  it('inventory_missing -> Category Inventory + Missing Item + Evidence Yes', async () => {
    const h = fieldsSetup('inventory_missing')
    expect(await h.run()).toMatchObject({ status: 'created' })
    expect(posts(h.asana)).toBe(1)
    expect(sent(h).customFields).toEqual({ [F.category]: O.inventory, [F.inventoryType]: O.missing, [F.evidence]: O.yes })
    expect(h.loader.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('inventory_damaged -> Category Inventory + Physical Damage + Evidence Yes', async () => {
    const h = fieldsSetup('inventory_damaged')
    await h.run()
    expect(sent(h).customFields).toEqual({ [F.category]: O.inventory, [F.inventoryType]: O.damage, [F.evidence]: O.yes })
  })

  it('maintenance_issue -> Category Maintenance, NO incident type', async () => {
    const h = fieldsSetup('maintenance_issue')
    await h.run()
    expect(sent(h).customFields).toEqual({ [F.category]: O.maintenance, [F.evidence]: O.yes })
  })

  it.each(['cleaning_issue', 'safety_urgent', 'condition_note', 'guest_damage', 'owner_chargeable', 'company_responsibility', 'follow_up_required', 'no_action_record', 'mystery', '', null])(
    '%s -> no Category, no incident type (Evidence still independent)',
    async (key) => {
      const h = fieldsSetup(key as string | null)
      await h.run()
      expect(sent(h).customFields).toEqual({ [F.evidence]: O.yes })
    },
  )

  it('Unit #, Unit Number, Linen type, Accountable Party and Evidence "No" are NEVER sent', async () => {
    for (const key of ['inventory_missing', 'inventory_damaged', 'maintenance_issue', 'cleaning_issue']) {
      for (const photos of [[photo('p1')], []]) {
        const h = fieldsSetup(key, photos)
        await h.run()
        const cf = sent(h).customFields ?? {}
        for (const forbidden of [F.unit, F.unitNumber, F.linenType, F.accountable]) expect(cf).not.toHaveProperty(forbidden)
        expect(Object.values(cf).flat()).not.toContain(O.no)
      }
    }
  })
})

describe('Evidence Received = Yes only for a durable qualifying photo', () => {
  it.each<[string, Row[]]>([
    ['zero photos', []],
    ['only a deleted photo', [photo('p1', { deleted_at: '2026-11-01T00:00:00Z' })]],
    ['only a photo whose bytes were deleted', [photo('p1', { bytes_deleted_at: '2026-11-01T00:00:00Z' })]],
    ['only a photo of another company', [photo('p1', { company_id: 'other' })]],
    ['only a photo of another flag', [photo('p1', { flag_id: OTHER })]],
    ['only a non-canonical path (other company prefix)', [photo('p1', { storage_path: `companies/other/flags/${FLAG}/p1.jpg` })]],
    ['only a non-canonical path (other flag)', [photo('p1', { storage_path: `companies/co/flags/${OTHER}/p1.jpg` })]],
    ['only a thumbnail path', [photo('p1', { storage_path: `companies/co/flags/${FLAG}/p1_thumb.jpg` })]],
    ['only a path for a different photo id', [photo('p1', { storage_path: `companies/co/flags/${FLAG}/p2.jpg` })]],
    ['only a photo not finalised (sync_status != synced)', [photo('p1', { sync_status: 'uploading' })]],
  ])('%s -> Evidence omitted, task still created', async (_l, photos) => {
    const h = fieldsSetup('inventory_missing', photos)
    expect(await h.run()).toMatchObject({ status: 'created' })
    expect(sent(h).customFields).toEqual({ [F.category]: O.inventory, [F.inventoryType]: O.missing })
  })

  it('one qualifying photo among bad ones -> Yes', async () => {
    const h = fieldsSetup('maintenance_issue', [photo('bad', { deleted_at: 'x' }), photo('good')])
    await h.run()
    expect(sent(h).customFields).toMatchObject({ [F.evidence]: O.yes })
  })

  it('evidence query FAILS -> Evidence omitted, value-free warning, task still created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = fieldsSetup('inventory_missing')
    h.db.fixtures.photosError = true
    expect(await h.run()).toMatchObject({ status: 'created' })
    expect(sent(h).customFields).toEqual({ [F.category]: O.inventory, [F.inventoryType]: O.missing })
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('source_unavailable')
    warn.mockRestore()
  })

  it('reads photo ids and paths ONLY (no captions / notes / contents)', async () => {
    const h = fieldsSetup('inventory_missing')
    await h.run()
    expect(h.db.fixtures.photoSelects).toEqual(['id, storage_path'])
  })
})

describe('schema problems never block the task', () => {
  it('schema unavailable -> POST WITHOUT any custom_fields key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = fieldsSetup('inventory_missing', [photo('p1')], loaderFor(async () => { throw new AsanaApiError('read project fields', 503, 'down') }))
    expect(await h.run()).toMatchObject({ status: 'created' })
    expect(sent(h)).not.toHaveProperty('customFields')
    warn.mockRestore()
  })

  it('a loader that REJECTS (should never happen) still creates the task without fields', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = setup(undefined, { loadFieldValidation: async () => { throw new Error('boom') } })
    expect(await h.run()).toMatchObject({ status: 'created' })
    expect(sent(h)).not.toHaveProperty('customFields')
    warn.mockRestore()
  })

  it('ONE malformed field (Evidence) -> only that field omitted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = fieldsSetup('inventory_missing', [photo('p1')], loaderFor(async () =>
      betaMetadata((m) => { delete (m.get(F.evidence)!.custom_field as Record<string, unknown>).enum_options }),
    ))
    await h.run()
    expect(sent(h).customFields).toEqual({ [F.category]: O.inventory, [F.inventoryType]: O.missing })
    warn.mockRestore()
  })

  it('a DISABLED option (Physical Damage) -> only that option omitted, Category kept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = fieldsSetup('inventory_damaged', [photo('p1')], loaderFor(async () =>
      betaMetadata((m) => {
        const cf = m.get(F.inventoryType)!.custom_field as { enum_options: Array<{ gid: string; enabled: boolean }> }
        cf.enum_options = cf.enum_options.map((o) => (o.gid === O.damage ? { ...o, enabled: false } : o))
      }),
    ))
    await h.run()
    expect(sent(h).customFields).toEqual({ [F.category]: O.inventory, [F.evidence]: O.yes })
    warn.mockRestore()
  })

  it('a malformed Category drops Category AND the dependent incident type', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = fieldsSetup('inventory_missing', [photo('p1')], loaderFor(async () =>
      betaMetadata((m) => { (m.get(F.category)!.custom_field as Record<string, unknown>).resource_subtype = '' }),
    ))
    await h.run()
    expect(sent(h).customFields).toEqual({ [F.evidence]: O.yes })
    warn.mockRestore()
  })
})

describe('schema loading: once per request, only for a genuine new create', () => {
  it('several creates in one request -> at most ONE schema load', async () => {
    const loader = goodLoader()
    for (let i = 0; i < 3; i++) {
      const h = fieldsSetup('maintenance_issue', [photo('p1')], loader) // same request-scoped loader
      expect(await h.run()).toMatchObject({ status: 'created' })
    }
    expect(loader.fetchMock).toHaveBeenCalledTimes(1)
    expect(loader.load).toHaveBeenCalledTimes(3)
  })

  it('a FAILED load is memoised for the request too (no retry storm)', async () => {
    const loader = loaderFor(async () => { throw new TypeError('fetch failed') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 3; i++) await fieldsSetup('maintenance_issue', [photo('p1')], loader).run()
    expect(loader.fetchMock).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('NO load: empty queue', async () => {
    const h = fieldsSetup('maintenance_issue')
    h.db.outbox.status = 'done'
    expect(await h.run()).toMatchObject({ status: 'no_pending' })
    expect(h.loader.load).not.toHaveBeenCalled()
  })

  it('NO load: refused company', async () => {
    const loader = goodLoader()
    const h = setup(undefined, { allowedCompanyIds: ['other'], loadFieldValidation: loader.load })
    expect(await h.run()).toMatchObject({ status: 'refused' })
    expect(loader.load).not.toHaveBeenCalled()
  })

  it('NO load: an external link already exists', async () => {
    const h = fieldsSetup('maintenance_issue')
    h.db.links.push({ company_id: 'co', provider: 'asana', internal_entity_type: 'flag', internal_entity_id: FLAG, external_task_gid: 'T5', external_task_url: 'https://app.asana.com/0/1/T5', deleted_at: null })
    expect(await h.run()).toMatchObject({ status: 'already_linked' })
    expect(h.loader.load).not.toHaveBeenCalled()
  })

  it('NO load: a saved task GID is verified and adopted', async () => {
    const loader = goodLoader()
    const h = setup({ flag_id: FLAG, create_protocol: CREATE_PROTOCOL, create_marker: flagMarkerLine(FLAG), create_attempted_at: new Date(T0 - 2 * MIN).toISOString(), created_task_gid: 'T7' }, { loadFieldValidation: loader.load })
    h.asana.tasks.push({ gid: 'T7', notes: flagMarkerLine(FLAG), projectGids: [BETA] })
    expect(await h.run()).toMatchObject({ status: 'adopted' })
    expect(loader.load).not.toHaveBeenCalled()
  })

  it('NO load: reconciliation finds the existing task, or is still quarantined', async () => {
    const loader = goodLoader()
    const h = setup(undefined, { loadFieldValidation: loader.load })
    h.asana.behaviour.create = 'lost_response'
    await h.run() // one load + one POST (fields attempted)
    expect(loader.load).toHaveBeenCalledTimes(1)
    h.asana.behaviour.create = 'ok'
    h.clock.now += 5 * MIN
    h.due()
    expect(await h.run()).toMatchObject({ status: 'adopted' })
    expect(loader.load).toHaveBeenCalledTimes(1)

    const q = setup(undefined, { loadFieldValidation: loader.load })
    q.asana.behaviour.create = 'server_500_no_create'
    await q.run()
    const before = loader.load.mock.calls.length
    q.clock.now += 5 * MIN
    q.due()
    expect(await q.run()).toMatchObject({ status: 'rescheduled', code: 'reconcile_not_found' })
    expect(loader.load).toHaveBeenCalledTimes(before)
  })

  it('NO load: dry run', async () => {
    const h = fieldsSetup('maintenance_issue')
    const res = await dryRunNextAsanaOutbox(h.db.client, h.deps)
    expect(res.status).toBe('dry_run_ok')
    expect(h.loader.load).not.toHaveBeenCalled()
    expect((res as { payload: TaskPayload }).payload).not.toHaveProperty('customFields')
  })
})

describe('fields never change the task identity, marker or placement', () => {
  it('name, notes (marker), project, section, due date identical with and without fields', async () => {
    const withF = fieldsSetup('inventory_missing')
    await withF.run()
    const without = setup()
    await without.run()
    const a = { ...sent(withF) }
    const b = { ...sent(without) }
    expect(a.customFields).toBeDefined()
    delete a.customFields
    expect(a).toEqual(b)
    expect(a.notes).toContain(flagMarkerLine(FLAG))
  })

  it('an empty resolution sends NO customFields property at all', async () => {
    const h = fieldsSetup('cleaning_issue', [])
    await h.run()
    expect(sent(h)).not.toHaveProperty('customFields')
  })
})

describe('HTTP 400 fallback', () => {
  it('400 WITH fields -> custom_fields_rejected recorded, normal retry; next run creates WITHOUT fields; one task', async () => {
    const h = fieldsSetup('inventory_missing')
    h.asana.behaviour.create = 'reject_400_if_fields'
    expect(await h.run()).toMatchObject({ status: 'error', error: 'create_rejected_custom_fields_http_400' })
    expect(posts(h.asana)).toBe(1) // never retried in the same run
    expect(h.db.outbox).toMatchObject({ status: 'pending', attempt_count: 1 })
    expect(h.state()).toMatchObject({ custom_fields_rejected: true, create_attempted_at: null, flag_id: FLAG, property_id: PROP })
    expect(h.asana.tasks).toHaveLength(0)

    // Next request: a fresh loader that must NOT be used.
    const next = goodLoader()
    h.deps.loadFieldValidation = next.load
    h.clock.now += 5 * MIN
    h.due()
    expect(await h.run()).toMatchObject({ status: 'created' })
    expect(next.load).not.toHaveBeenCalled()
    expect(posts(h.asana)).toBe(2)
    expect(sent(h, 1)).not.toHaveProperty('customFields')
    expect(h.asana.provider.listTasksModifiedSince).not.toHaveBeenCalled() // a 400 is never reconciled
    expect(h.asana.tasks).toHaveLength(1)
    const first = { ...sent(h, 0) }
    delete first.customFields
    expect(sent(h, 1)).toEqual(first) // identical apart from the fields
    expect(h.state().custom_fields_rejected).toBe(true) // never cleared
  })

  it('400 WITHOUT fields keeps the normal rejection (no fallback flag)', async () => {
    const h = setup()
    h.asana.behaviour.create = 'reject_400'
    expect(await h.run()).toMatchObject({ status: 'error', error: 'create_rejected_http_400' })
    expect(h.state()).not.toHaveProperty('custom_fields_rejected')
  })

  it('400 when fields resolved to EMPTY keeps the normal rejection', async () => {
    const h = fieldsSetup('cleaning_issue', [])
    h.asana.behaviour.create = 'reject_400'
    expect(await h.run()).toMatchObject({ error: 'create_rejected_http_400' })
    expect(h.state()).not.toHaveProperty('custom_fields_rejected')
  })

  it('other rejections (401/403/404) with fields do NOT set the fallback', async () => {
    const h = fieldsSetup('maintenance_issue')
    h.asana.provider.createTask.mockImplementationOnce(async () => { throw new AsanaApiError('create task', 403, 'no') })
    expect(await h.run()).toMatchObject({ error: 'create_rejected_http_403' })
    expect(h.state()).not.toHaveProperty('custom_fields_rejected')
  })
})

describe('warning privacy', () => {
  it('field warnings carry codes, field keys and GIDs only — no values, names, notes, reporter or token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = fieldsSetup('cleaning_issue', [], loaderFor(async () =>
      betaMetadata((m) => { m.delete(F.evidence) }),
    ))
    h.db.fixtures.photosError = true
    await h.run()
    const out = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(out).toContain('unmapped_value')
    expect(out).toContain('source_unavailable')
    for (const leak of ['cleaning_issue', 'Unit 50', 'Leaking tap', 'Reporter', 'Item missing', 'tok', 'photos down', BASE]) {
      expect(out).not.toContain(leak)
    }
    warn.mockRestore()
  })
})
