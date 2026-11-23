import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { handoffJobsFor, reconcileAsanaHandoffs, recordReconcileHeartbeat, type AwaitingHandoffRow } from './reconcile-handoff'
import { ASANA_DESTINATIONS, LIVE_TEST_SCOPE } from '@/lib/integrations/asana/destinations'

const CO = LIVE_TEST_SCOPE.companyId
const PROP = '3ed2a749-0954-4216-8095-2a1bf2af7aaa'
const F1 = '96487471-8c6e-48bc-828e-26255ad5277d'
const F2 = 'a080d3ca-61b3-4dd5-9a56-87a90135761d'
const U = '5bbe6c9a-755b-4e00-82df-484ffad48bce'
const row = (o: Partial<AwaitingHandoffRow> = {}): AwaitingHandoffRow => ({
  flag_id: F1, company_id: CO, property_id: PROP, raised_by: U, is_test: false,
  category_key: 'maintenance_issue', is_pack_photo_issue: false, has_photos: false, ...o,
})

beforeEach(() => { vi.stubEnv('ASANA_LIVE_INCIDENTS_ENABLED', 'true'); vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', '') })
afterEach(() => vi.unstubAllEnvs())

describe('which jobs a reconciled flag gets (same rule as the app)', () => {
  it('normal issue, rollout on -> live create + attach, pinned, created_by = reporter', () => {
    const { destination, jobs } = handoffJobsFor(row())
    expect(destination).toBe('live_incidents')
    expect(jobs.map((j) => j.event_type)).toEqual([ASANA_DESTINATIONS.live_incidents.createEvent, ASANA_DESTINATIONS.live_incidents.attachEvent])
    for (const j of jobs) {
      expect(j).toMatchObject({ company_id: CO, provider: 'asana', entity_type: 'flag', entity_id: F1, created_by: U })
      expect(j.payload).toMatchObject({ flag_id: F1, property_id: PROP, category_key: 'maintenance_issue', destination: 'live_incidents' })
    }
  })
  it('TEST issue -> BETA only, even with rollout on', () => {
    expect(handoffJobsFor(row({ is_test: true })).destination).toBe('beta')
    expect(handoffJobsFor(row({ is_test: true })).jobs.map((j) => j.event_type)).toEqual(['asana.create_task_for_flag'])
    expect(handoffJobsFor(row({ is_test: true, has_photos: true })).jobs.map((j) => j.event_type))
      .toEqual(['asana.create_task_for_flag', 'asana.attach_flag_evidence'])
  })
  it('rollout off -> BETA (create only without photos)', () => {
    vi.stubEnv('ASANA_LIVE_INCIDENTS_ENABLED', '')
    const { destination, jobs } = handoffJobsFor(row())
    expect(destination).toBe('beta')
    expect(jobs).toHaveLength(1)
    expect(jobs[0].payload).not.toHaveProperty('destination')
  })
})

function db(opts: { rows?: unknown; lookupError?: boolean; lookupThrows?: boolean; enqueue?: (flagId: string) => unknown }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      if (fn === 'asana_flags_awaiting_handoff') {
        if (opts.lookupThrows) throw new Error('network')
        return opts.lookupError ? { data: null, error: { code: 'XX000' } } : { data: opts.rows ?? [], error: null }
      }
      const r = opts.enqueue?.(args.p_flag_id as string)
      if (r instanceof Error) throw r
      return r ?? { data: 'enqueued', error: null }
    },
  } as unknown as SupabaseClient
  return { client, calls }
}

describe('reconcileAsanaHandoffs', () => {
  it('asks for at most `limit` flags at least 2 minutes old, then enqueues each through the validated function', async () => {
    const h = db({ rows: [row(), row({ flag_id: F2, is_test: true })] })
    const r = await reconcileAsanaHandoffs(h.client, 7)
    expect(h.calls[0]).toEqual({ fn: 'asana_flags_awaiting_handoff', args: { p_limit: 7, p_min_age_seconds: 120 } })
    expect(h.calls.slice(1).map((c) => [c.fn, c.args.p_flag_id])).toEqual([['enqueue_asana_handoff', F1], ['enqueue_asana_handoff', F2]])
    const test = h.calls[2].args.p_jobs as Array<{ event_type: string }>
    expect(test.every((j) => !j.event_type.startsWith('asana.live.'))).toBe(true)
    expect(r).toEqual({ ok: true, checked: 2, outcomes: [{ flagId: F1, outcome: 'enqueued' }, { flagId: F2, outcome: 'enqueued' }] })
  })
  it('idempotent outcomes are reported as such (no second task)', async () => {
    const h = db({ rows: [row(), row({ flag_id: F2 })], enqueue: (id) => ({ data: id === F1 ? 'already_has_job' : 'not_expected', error: null }) })
    expect((await reconcileAsanaHandoffs(h.client)).outcomes).toEqual([{ flagId: F1, outcome: 'already_has_job' }, { flagId: F2, outcome: 'not_expected' }])
  })
  it('one failing flag (error / thrown / odd answer) does not stop the others; it stays awaiting for the next run', async () => {
    const h = db({ rows: [row(), row({ flag_id: F2 })], enqueue: (id) => (id === F1 ? new Error('lost response') : { data: 'enqueued', error: null }) })
    expect((await reconcileAsanaHandoffs(h.client)).outcomes).toEqual([{ flagId: F1, outcome: 'failed' }, { flagId: F2, outcome: 'enqueued' }])
    const h2 = db({ rows: [row()], enqueue: () => ({ data: 'weird', error: null }) })
    expect((await reconcileAsanaHandoffs(h2.client)).outcomes).toEqual([{ flagId: F1, outcome: 'failed' }])
    const h3 = db({ rows: [row()], enqueue: () => ({ data: null, error: { code: '23514' } }) })
    expect((await reconcileAsanaHandoffs(h3.client)).outcomes).toEqual([{ flagId: F1, outcome: 'failed' }])
  })
  it('lookup failure or throw -> ok:false, nothing enqueued, never throws', async () => {
    for (const o of [{ lookupError: true }, { lookupThrows: true }]) {
      const h = db(o)
      expect(await reconcileAsanaHandoffs(h.client)).toEqual({ ok: false, checked: 0, outcomes: [] })
      expect(h.calls).toHaveLength(1)
    }
  })
  it('malformed rows are skipped, never enqueued', async () => {
    const h = db({ rows: [{ ...row(), flag_id: 'x' }, { ...row(), is_test: 'false' }, null, row({ flag_id: F2 })] })
    const r = await reconcileAsanaHandoffs(h.client)
    expect(r.checked).toBe(1)
    expect(h.calls.slice(1).map((c) => c.args.p_flag_id)).toEqual([F2])
  })
})

describe('recordReconcileHeartbeat', () => {
  it('records the run and whether it worked; never throws', async () => {
    const calls: unknown[] = []
    const ok = { rpc: async (fn: string, args: unknown) => (calls.push([fn, args]), { error: null }) } as unknown as SupabaseClient
    expect(await recordReconcileHeartbeat(ok, false)).toBe(true)
    expect(calls).toEqual([['record_worker_heartbeat', { p_worker: 'asana_reconcile', p_ok: false }]])
    const bad = { rpc: async () => ({ error: { code: 'XX000' } }) } as unknown as SupabaseClient
    expect(await recordReconcileHeartbeat(bad, true)).toBe(false)
    const throws = { rpc: async () => { throw new Error('down') } } as unknown as SupabaseClient
    expect(await recordReconcileHeartbeat(throws, true)).toBe(false)
  })
})
