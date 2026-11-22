import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TurnoverJob } from './workboard'
const state = vi.hoisted(() => ({ stage: 'due', manager: false }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), redirect: vi.fn(), notFound: vi.fn() }))
vi.mock('@/lib/auth/get-user-context', () => ({ getUserContext: async () => ({ user: { id: 'inspector', email: 'fixture@example.invalid' }, company: { id: 'fixture-company', name: 'Design fixture' }, profile: { full_name: 'Inspector A' }, membership: { role_key: state.manager ? 'ops_manager' : 'inspector' } }) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: query }) }))
vi.mock('@/lib/inspections/load-workspace', () => ({ loadInspectionJobs: async () => ({ data: [job()], error: null }) }))
vi.mock('@/app/dashboard/work/actions', () => ({ startTurnover: vi.fn(), updateTurnover: vi.fn() }))
vi.mock('@/app/properties/[id]/packs/actions', () => ({ startPreArrivalPackAction: vi.fn(), discardEvidencePackAction: vi.fn() }))
vi.mock('@/app/properties/[id]/photos/actions', () => ({ attachEvidencePhoto: vi.fn(), attachEvidencePhotosBatch: vi.fn(), requestPhotoUploadSlot: vi.fn() }))
vi.mock('@/app/properties/[id]/flags/[flagId]/actions', () => ({ updateFlagAction: vi.fn() }))
vi.mock('@/app/properties/[id]/flags/[flagId]/marks/actions', () => ({ toggleFlagMarkAction: vi.fn() }))
import PropertyPage from '@/app/properties/[id]/page'
import { AppShell } from '@/components/app-shell'
import { Workboard } from '@/app/dashboard/work/workboard'
const propertyId = '22222222-2222-4222-8222-222222222222'
const packId = '11111111-1111-4111-8111-111111111111'
const property = { id: propertyId, name: 'Unit 91', address: 'Ballito Life', unit_reference: '91', bedrooms: 2, status: 'idle', notes: null, created_at: '2026-10-01T10:00:00Z' }
function job(): TurnoverJob {
  return { id: 'fixture-job', property_id: propertyId, due_on: '2026-11-22', checkout_at: null, next_arrival_at: null, source: 'manual', cancelled_at: null, revision: 1, pack_id: state.stage === 'due' ? null : packId, pack_deleted: state.stage === 'discarded', pack_status: state.stage === 'completed' ? 'submitted' : 'draft', started_by: 'a', starter_name: 'Inspector A', submitted_by: state.stage === 'completed' ? 'b' : null, submitter_name: state.stage === 'completed' ? 'Inspector B' : null, submitted_at: state.stage === 'completed' ? '2026-11-22T10:30:00Z' : null }
}
function query(table: string) {
  const filters: Record<string, unknown> = {}
  const result = () => {
    let data: unknown = []
    if (table === 'properties') data = property
    if (table === 'evidence_packs') data = filters.status === 'draft' && ['empty', 'photos'].includes(state.stage) ? { id: packId, title: null, started_at: '2026-11-22T08:00:00Z', started_by: 'a' } : filters.status === 'submitted' ? state.stage === 'completed' ? [{ id: packId, title: null, started_at: '2026-11-22T08:00:00Z', submitted_at: '2026-11-22T10:30:00Z', submitted_by: 'b' }] : [] : null
    return { data, error: null, count: table === 'photos' && state.stage === 'photos' ? 3 : 0 }
  }
  const proxy: Record<string, unknown> = new Proxy({}, { get: (_, key) => {
    if (key === 'then') return (resolve: (value: ReturnType<typeof result>) => void) => resolve(result())
    if (key === 'maybeSingle') return async () => result()
    return (...args: unknown[]) => { if (key === 'eq') filters[String(args[0])] = args[1]; return proxy }
  } })
  return proxy
}
function savePreview(name: string, html: string) {
  const dir = process.env.STR_INSPECTION_LAYOUT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const cssDir = join(process.cwd(), '.next/static/chunks')
  const cssFiles = readdirSync(cssDir).filter(f => f.endsWith('.css'))
  const css = cssFiles.map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')
  const font = css.match(/\.([a-zA-Z0-9_-]+)\{--font-geist-sans:/)?.[1] ?? ''
  writeFileSync(join(dir, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inspection layout fixture</title>${cssFiles.map(f => `<link rel="stylesheet" href="/_next/static/chunks/${f}">`).join('')}</head><body class="${font}">${html}</body></html>`)
}
async function apartment(stage: string, submitted: string | undefined = undefined) {
  state.stage = stage
  const html = renderToStaticMarkup(await PropertyPage({ params: Promise.resolve({ id: propertyId }), searchParams: Promise.resolve({ pack_submitted: submitted }) }))
  savePreview(`apartment-${stage}${state.manager ? '-manager' : ''}`, html)
  return html
}
beforeEach(() => { state.manager = false; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-22T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })
describe('actual apartment inspection page with isolated server data', () => {
  it('a due visit offers Start without showing the apartment Idle badge to an inspector', async () => {
    const html = await apartment('due')
    expect(html).toContain('Inspect this apartment'); expect(html).toContain('Start inspection')
    expect(html).not.toContain('Apartment: Idle'); expect(html).not.toContain('Inspection complete')
  })
  it('a fresh inspection leads to the actual camera and has no premature review action', async () => {
    const html = await apartment('empty')
    expect(html).toContain('Take photos'); expect(html).toContain('Upload from gallery')
    expect(html).not.toContain('Review and submit inspection')
    expect(html).toContain('More inspection options'); expect(html).toContain('type="file"')
  })
  it('confirmed photos unlock the report link without adding a direct submit', async () => {
    const html = await apartment('photos')
    expect(html).toContain('Take more photos'); expect(html).toContain('Review and submit inspection')
    expect(html).toContain(`/properties/${propertyId}/packs/${packId}/report`)
    expect(html).not.toContain('Save captions and submit pack')
  })
  it('the submitted exact visit leads back to work, with another Start disclosed separately', async () => {
    const html = await apartment('completed', packId)
    expect(html).toContain('Inspection complete'); expect(html).toContain('Submitted by Inspector B')
    expect(html).toContain('12:30'); expect(html).toContain('Back to my inspections')
    expect(html).toMatch(/<details><summary[^>]*>Start another inspection<\/summary>/)
    expect(html).not.toContain('start a new pack when ready')
  })
  it('a URL flag alone cannot claim an open visit is complete', async () => {
    const html = await apartment('due', packId)
    expect(html).not.toContain('Inspection complete'); expect(html).toContain('Check inspection history')
  })
  it('discard recovery provides an exit for inspectors and only managers receive cancellation', async () => {
    const html = await apartment('discarded')
    expect(html).toContain('Ask a manager'); expect(html).toContain('Back to my inspections')
    expect(html).not.toContain('Cancel inspection…'); expect(html).not.toContain('Start pre-arrival pack')
    const afterDiscard = renderToStaticMarkup(await PropertyPage({ params: Promise.resolve({ id: propertyId }), searchParams: Promise.resolve({ pack_discarded: '1' }) }))
    expect(afterDiscard).toContain('Inspection needs attention'); expect(afterDiscard).not.toContain('Inspection draft discarded.')
    state.manager = true
    const manager = await apartment('discarded')
    expect(manager).toContain('Cancel inspection…'); expect(manager).toContain('Apartment: Idle')
  })
  it('renders the work list from its real component for phone layout inspection', () => {
    state.stage = 'due'
    const html = renderToStaticMarkup(<AppShell companyName="Design fixture" userName="Inspector A" userEmail="fixture@example.invalid"><h1 className="mb-3 text-2xl font-semibold">My inspections</h1><Workboard workspace={{ properties: [{ ...property, revision: 0, inspector_id: null, inspector_name: null, inspector_active: false }], inspectors: [], history: [], managers_only: false, settings_revision: 0 }} jobs={[job()]} manager={false} all={false} userId="a" today="2026-11-22" initialProperty="" /></AppShell>)
    expect(html.indexOf('<article')).toBeLessThan(html.indexOf('Work summary'))
    savePreview('work-list', html)
  })
})
