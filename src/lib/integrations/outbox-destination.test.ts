import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildAttachEvidenceEvent,
  buildFlagOutboxEvent,
  enqueueAttachEvidenceEvent,
  enqueueFlagCreatedEvent,
  maybeEnqueueFlagEvents,
  maybeReArmAttachEvidence,
} from '@/lib/integrations/outbox'

/**
 * ONE DESTINATION PER FLAG — stateful proof.
 *
 * A real in-memory outbox table that ENFORCES unique indexes exactly like
 * Postgres: the existing per-event-type index, and (when `migration` is on)
 * the two indexes of migration 20261119110000 (one create job and one
 * attach job per flag, whichever destination). Reads are asynchronous, so
 * concurrent requests genuinely interleave.
 */

const CO = '1669c464-8d26-40fc-9956-9f8955fd27c7'
const FLAG = '96487471-8c6e-48bc-828e-26255ad5277d'
const input = { companyId: CO, flagId: FLAG, createdBy: 'u1', payload: { property_id: 'p' } }
const CREATES = ['asana.create_task_for_flag', 'asana.live.create_task_for_flag']
const ATTACHES = ['asana.attach_flag_evidence', 'asana.live.attach_flag_evidence']

type Row = Record<string, unknown>

function table(opts: { migration: boolean; beforeFirstInsert?: (rows: Row[]) => void }) {
  const rows: Row[] = []
  let inserts = 0
  const sameFlag = (a: Row, b: Row) =>
    a.company_id === b.company_id && a.provider === b.provider && a.entity_type === b.entity_type && a.entity_id === b.entity_id
  const violates = (r: Row) =>
    rows.some((x) => {
      if (x.deleted_at != null || !sameFlag(x, r)) return false
      if (x.event_type === r.event_type) return true // existing index
      if (!opts.migration) return false
      const kind = (e: unknown) => (CREATES.includes(String(e)) ? 'c' : ATTACHES.includes(String(e)) ? 'a' : null)
      const dest = (e: unknown) => (kind(e) === null ? null : String(e).startsWith('asana.live.') ? 'live' : 'beta')
      // 20261119110000 — index: one job per KIND ...
      if (kind(x.event_type) !== null && kind(x.event_type) === kind(r.event_type)) return true
      // ... and trigger: every job of the flag has the SAME destination.
      return dest(x.event_type) !== null && dest(r.event_type) !== null && dest(x.event_type) !== dest(r.event_type)
    })
  const client = {
    from: (t: string) => {
      const filters: Array<[string, unknown]> = []
      let patch: Row | null = null
      const run = async () => {
        await Promise.resolve() // yield: lets concurrent requests interleave
        if (t === 'integration_settings') return { data: { id: 's' }, error: null }
        const found = rows.filter((r) => filters.every(([c, v]) => (v === null ? r[c] == null : r[c] === v)))
        if (patch) {
          for (const r of found) Object.assign(r, patch)
          return { data: null, error: null }
        }
        return { data: found[0] ? { ...found[0] } : null, error: null }
      }
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push([c, v]), q),
        is: (c: string, v: unknown) => (filters.push([c, v]), q),
        limit: () => q,
        update: (p: Row) => ((patch = p), q),
        maybeSingle: run,
        then: (resolve: (v: unknown) => void) => run().then(resolve),
        insert: async (r: Row) => {
          await Promise.resolve()
          if (inserts++ === 0) opts.beforeFirstInsert?.(rows)
          const row = { id: `ob${rows.length + 1}`, status: 'pending', deleted_at: null, ...r }
          if (violates(row)) return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          rows.push(row)
          return { error: null }
        },
      }
      return q
    },
  } as unknown as SupabaseClient
  const events = () => rows.map((r) => String(r.event_type)).sort()
  return { client, rows, events }
}

const LIVE = ['asana.live.attach_flag_evidence', 'asana.live.create_task_for_flag']
const BETA = ['asana.attach_flag_evidence', 'asana.create_task_for_flag']

describe.each([{ migration: true }, { migration: false }])('replays reuse the ORIGINAL destination (migration applied: $migration)', (opts) => {
  it('REPRO: live issue enqueued -> switch turned OFF -> the same save replayed (now requesting BETA): still exactly the two LIVE jobs', async () => {
    const t = table(opts)
    expect(await maybeEnqueueFlagEvents(t.client, input, 'live_incidents')).toEqual({ create: 'enqueued' })
    expect(t.events()).toEqual(LIVE)
    for (let i = 0; i < 3; i++) {
      expect(await maybeEnqueueFlagEvents(t.client, input, 'beta')).toEqual({ create: 'duplicate' })
    }
    expect(t.events()).toEqual(LIVE)
    expect(t.rows.filter((r) => CREATES.includes(String(r.event_type)))).toHaveLength(1)
  })

  it('the mirror: a BETA issue replayed after the switch is turned ON stays BETA', async () => {
    const t = table(opts)
    await maybeEnqueueFlagEvents(t.client, input, 'beta')
    expect(await maybeEnqueueFlagEvents(t.client, input, 'live_incidents')).toEqual({ create: 'duplicate' })
    expect(t.events()).toEqual(BETA)
  })

  it('a live issue whose attach job went missing gets a LIVE attach job back on replay — never a BETA one', async () => {
    const t = table(opts)
    await maybeEnqueueFlagEvents(t.client, input, 'live_incidents')
    t.rows.splice(t.rows.findIndex((r) => r.event_type === 'asana.live.attach_flag_evidence'), 1)
    await maybeEnqueueFlagEvents(t.client, input, 'beta')
    expect(t.events()).toEqual(LIVE)
    t.rows.splice(t.rows.findIndex((r) => r.event_type === 'asana.live.attach_flag_evidence'), 1)
    await maybeReArmAttachEvidence(t.client, input)
    expect(t.events()).toEqual(LIVE)
  })
})

describe('the database boundary (migration 20261119110000) makes it atomic', () => {
  it('CONCURRENT live + BETA requests for the same new issue: ONE create job, ONE attach job, the SAME destination', async () => {
    for (let round = 0; round < 20; round++) {
      const t = table({ migration: true })
      const order = round % 2 ? (['live_incidents', 'beta'] as const) : (['beta', 'live_incidents'] as const)
      const results = await Promise.all(order.map((d) => maybeEnqueueFlagEvents(t.client, input, d)))
      expect(results.map((r) => r.create).sort()).toEqual(['duplicate', 'enqueued'])
      const creates = t.rows.filter((r) => CREATES.includes(String(r.event_type)))
      const attaches = t.rows.filter((r) => ATTACHES.includes(String(r.event_type)))
      expect(creates).toHaveLength(1)
      expect(attaches).toHaveLength(1)
      const live = String(creates[0].event_type).startsWith('asana.live.')
      expect(String(attaches[0].event_type).startsWith('asana.live.')).toBe(live)
    }
  })

  it('LOST RACE, worst ordering: another request\'s LIVE create job lands after our pre-read and before our BETA insert -> our attach job follows the WINNER (live), never our own request', async () => {
    const t = table({
      migration: true,
      beforeFirstInsert: (rows) =>
        rows.push({ id: 'winner', status: 'pending', deleted_at: null, ...buildFlagOutboxEvent(input, 'live_incidents') }),
    })
    expect(await maybeEnqueueFlagEvents(t.client, input, 'beta')).toEqual({ create: 'duplicate' })
    expect(t.events()).toEqual(LIVE) // live create (winner) + LIVE attach — no BETA row at all
  })

  it('WITHOUT the migration the same race CAN leave both destinations — which is why a pre-read alone is not enough', async () => {
    const t = table({ migration: false })
    await Promise.all([
      maybeEnqueueFlagEvents(t.client, input, 'live_incidents'),
      maybeEnqueueFlagEvents(t.client, input, 'beta'),
    ])
    expect(t.rows.filter((r) => CREATES.includes(String(r.event_type))).length).toBe(2)
  })

  it('the OLDER production code (plain BETA inserts, no destination logic) cannot add a job to a live-pinned flag', async () => {
    const t = table({ migration: true })
    await maybeEnqueueFlagEvents(t.client, input, 'live_incidents')
    // exactly what the old enqueue / re-arm do: insert the BETA rows directly
    const create = await t.client.from('integration_outbox').insert(buildFlagOutboxEvent(input))
    const attach = await t.client.from('integration_outbox').insert(buildAttachEvidenceEvent(input))
    expect(create.error?.code).toBe('23505')
    expect(attach.error?.code).toBe('23505')
    expect(t.events()).toEqual(LIVE)
  })

  it('and the other way round: a live insert cannot be added to a BETA-pinned flag', async () => {
    const t = table({ migration: true })
    await maybeEnqueueFlagEvents(t.client, input, 'beta')
    expect((await t.client.from('integration_outbox').insert(buildFlagOutboxEvent(input, 'live_incidents'))).error?.code).toBe('23505')
    expect((await t.client.from('integration_outbox').insert(buildAttachEvidenceEvent(input, 'live_incidents'))).error?.code).toBe('23505')
    expect(t.events()).toEqual(BETA)
  })

  it('other flags are unaffected', async () => {
    const t = table({ migration: true })
    await maybeEnqueueFlagEvents(t.client, input, 'live_incidents')
    const other = { ...input, flagId: '0b7c2a3e-4d5f-4a6b-8c9d-0e1f2a3b4c5d' }
    expect(await maybeEnqueueFlagEvents(t.client, other, 'beta')).toEqual({ create: 'enqueued' })
    expect(t.rows).toHaveLength(4)
  })
})

describe('ONE destination across BOTH job kinds (the trigger in migration 20261119110000)', () => {
  const oldCaller = async (t: ReturnType<typeof table>) => ({
    // exactly what the older production code does: two plain BETA inserts
    create: (await t.client.from('integration_outbox').insert(buildFlagOutboxEvent(input))).error?.code ?? 'ok',
    attach: (await t.client.from('integration_outbox').insert(buildAttachEvidenceEvent(input))).error?.code ?? 'ok',
  })

  it('REPRO (review): LIVE create -> older caller tries both BETA inserts -> LIVE attach. Result: LIVE create + LIVE attach', async () => {
    const t = table({ migration: true })
    expect(await enqueueFlagCreatedEvent(t.client, input, 'live_incidents')).toEqual({ enqueued: true })
    // ...before the LIVE attach insert:
    expect(await oldCaller(t)).toEqual({ create: '23505', attach: '23505' })
    expect(await enqueueAttachEvidenceEvent(t.client, input, 'live_incidents')).toEqual({ enqueued: true })
    expect(t.events()).toEqual(LIVE)
  })

  it('the same interleaving through maybeEnqueueFlagEvents (the older caller lands between its create and attach inserts)', async () => {
    let inserts = 0
    const t = table({ migration: true })
    const original = t.client.from.bind(t.client)
    let injected: { create: string; attach: string } | null = null
    // wrap inserts: just before the 2nd insert of the live request (its attach), run the old caller
    ;(t.client as unknown as { from: (n: string) => unknown }).from = (name: string) => {
      const q = original(name) as unknown as { insert: (r: Row) => Promise<unknown> }
      const insert = q.insert
      q.insert = async (r: Row) => {
        if (name === 'integration_outbox' && ++inserts === 2 && !injected) {
          injected = { create: 'pending', attach: 'pending' }
          injected = await oldCaller(t)
        }
        return insert(r)
      }
      return q
    }
    expect(await maybeEnqueueFlagEvents(t.client, input, 'live_incidents')).toEqual({ create: 'enqueued' })
    expect(injected).toEqual({ create: '23505', attach: '23505' })
    expect(t.events()).toEqual(LIVE)
  })

  it('REVERSE: BETA create -> a live caller tries both live inserts -> BETA attach. Result: BETA create + BETA attach', async () => {
    const t = table({ migration: true })
    expect(await enqueueFlagCreatedEvent(t.client, input, 'beta')).toEqual({ enqueued: true })
    expect((await enqueueFlagCreatedEvent(t.client, input, 'live_incidents')).skipped).toBe('duplicate')
    expect((await enqueueAttachEvidenceEvent(t.client, input, 'live_incidents')).skipped).toBe('duplicate')
    expect(await enqueueAttachEvidenceEvent(t.client, input, 'beta')).toEqual({ enqueued: true })
    expect(t.events()).toEqual(BETA)
  })

  it('WITHOUT the trigger rule the review interleaving DOES leave "live create + BETA attach" (one index per kind is not enough)', async () => {
    const t = table({ migration: false })
    await enqueueFlagCreatedEvent(t.client, input, 'live_incidents')
    await oldCaller(t)
    await enqueueAttachEvidenceEvent(t.client, input, 'live_incidents')
    expect(t.events()).toContain('asana.attach_flag_evidence')
    expect(t.events()).toContain('asana.live.create_task_for_flag')
  })
})

describe.each([{ migration: true }, { migration: false }])('an existing ATTACH job WITHOUT a create job still pins the flag (migration applied: $migration)', (opts) => {
  it('live attach job only -> a later save (requesting BETA) completes it with a LIVE create job', async () => {
    const t = table(opts)
    await enqueueAttachEvidenceEvent(t.client, input, 'live_incidents')
    expect(await maybeEnqueueFlagEvents(t.client, input, 'beta')).toEqual({ create: 'enqueued' })
    expect(t.events()).toEqual(LIVE)
  })

  it('BETA attach job only -> a later save (requesting live) completes it with a BETA create job', async () => {
    const t = table(opts)
    await enqueueAttachEvidenceEvent(t.client, input, 'beta')
    expect(await maybeEnqueueFlagEvents(t.client, input, 'live_incidents')).toEqual({ create: 'enqueued' })
    expect(t.events()).toEqual(BETA)
  })

  it('re-arm with only a live CREATE job -> a LIVE attach job', async () => {
    const t = table(opts)
    await enqueueFlagCreatedEvent(t.client, input, 'live_incidents')
    await maybeReArmAttachEvidence(t.client, input)
    expect(t.events()).toEqual(LIVE)
  })
})

describe('an existing attach job without a create job, at the database boundary', () => {
  it('live attach only: plain BETA create AND BETA attach inserts are refused; a live create is accepted', async () => {
    const t = table({ migration: true })
    await enqueueAttachEvidenceEvent(t.client, input, 'live_incidents')
    expect((await t.client.from('integration_outbox').insert(buildFlagOutboxEvent(input))).error?.code).toBe('23505')
    expect((await t.client.from('integration_outbox').insert(buildAttachEvidenceEvent(input))).error?.code).toBe('23505')
    expect((await t.client.from('integration_outbox').insert(buildFlagOutboxEvent(input, 'live_incidents'))).error).toBeNull()
    expect(t.events()).toEqual(LIVE)
  })

  it('BETA attach only: live inserts are refused; a BETA create is accepted', async () => {
    const t = table({ migration: true })
    await enqueueAttachEvidenceEvent(t.client, input, 'beta')
    expect((await t.client.from('integration_outbox').insert(buildFlagOutboxEvent(input, 'live_incidents'))).error?.code).toBe('23505')
    expect((await t.client.from('integration_outbox').insert(buildAttachEvidenceEvent(input, 'live_incidents'))).error?.code).toBe('23505')
    expect((await t.client.from('integration_outbox').insert(buildFlagOutboxEvent(input))).error).toBeNull()
    expect(t.events()).toEqual(BETA)
  })
})
