import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/** The dashboard alert must never give false assurance (lead review, PR #78). */
const s = vi.hoisted(() => ({ rpc: null as unknown, asanaOn: true as boolean | 'error' }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: async () => s.rpc,
    from: () => {
      const q = { select: () => q, eq: () => q, is: () => q, limit: () => q,
        maybeSingle: async () => (s.asanaOn === 'error' ? { data: null, error: { code: 'XX000' } } : { data: s.asanaOn ? { id: 'x' } : null, error: null }) }
      return q
    },
  }),
}))
import { AsanaHandoffStatus } from './asana-handoff-status'

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const health = (o: Record<string, unknown> = {}) => ({ data: {
  asana_enabled: true, missing: 0, missing_beyond_retry: 0, stopped: 0, stuck: 0, oldest_problem_at: null, items: [],
  monitoring_since: ago(60 * 24), last_check_at: ago(1), last_check_ok_at: ago(1), last_check_ok: true, ...o,
}, error: null })
const render = async (variant: 'alert' | 'panel') => {
  const el = await AsanaHandoffStatus({ companyId: 'co', variant })
  return el ? renderToStaticMarkup(el as ReactElement) : ''
}
beforeEach(() => { s.rpc = health(); s.asanaOn = true })

describe('dashboard alert (managers)', () => {
  it('healthy: nothing on the dashboard', async () => {
    expect(await render('alert')).toBe('')
  })
  it('REGRESSION: worker never ran, nothing waiting -> the dashboard SHOWS it', async () => {
    s.rpc = health({ last_check_at: null, last_check_ok_at: null, last_check_ok: null })
    const html = await render('alert')
    expect(html).toContain('Automatic sending to Asana is not running')
    expect(html).toContain('has never run since it was installed')
  })
  it('within the 15-minute start-up grace: nothing on the dashboard yet', async () => {
    s.rpc = health({ monitoring_since: ago(5), last_check_at: null, last_check_ok_at: null, last_check_ok: null })
    expect(await render('alert')).toBe('')
  })
  it('check could not be made (outage): neutral notice, never "failed"', async () => {
    s.rpc = { data: null, error: { code: '57014' } }
    const html = await render('alert')
    expect(html).toContain('Could not verify Asana delivery right now')
    expect(html).toContain('does not mean any issue failed')
    expect(html).not.toContain('not reached Asana')
  })
  it('check could not be made and Asana status unknown: still shown', async () => {
    s.rpc = { data: null, error: { code: '57014' } }
    s.asanaOn = 'error'
    expect(await render('alert')).toContain('Could not verify Asana delivery')
  })
  it('database update not installed (preview): says so, distinct from an outage', async () => {
    s.rpc = { data: null, error: { code: 'PGRST202' } }
    expect(await render('alert')).toContain('not installed on this database yet')
  })
  it('Asana known to be switched off: no notice at all', async () => {
    s.rpc = { data: null, error: { code: '57014' } }
    s.asanaOn = false
    expect(await render('alert')).toBe('')
    s.rpc = health({ asana_enabled: false, last_check_at: null, last_check_ok: null })
    expect(await render('alert')).toBe('')
  })
})

describe('Testing page panel', () => {
  it('always shows the status, including healthy', async () => {
    expect(await render('panel')).toContain('All issues reached Asana.')
  })
})
