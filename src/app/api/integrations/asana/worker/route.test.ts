import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  batch: vi.fn(), attach: vi.fn(), provider: vi.fn(), fields: vi.fn(), client: {},
}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => h.client }))
vi.mock('@/lib/integrations/worker/process-outbox', () => ({
  runAsanaOutboxBatch: h.batch, runNextAsanaOutbox: vi.fn(), dryRunNextAsanaOutbox: vi.fn(),
}))
vi.mock('@/lib/integrations/worker/attach-evidence', () => ({ runNextAttachEvidence: h.attach }))
vi.mock('@/lib/integrations/asana/provider', () => ({ createAsanaProvider: h.provider }))
vi.mock('@/lib/integrations/asana/field-schema', () => ({ createWritableFieldValidationLoader: h.fields }))
import { GET } from './route'

const request = (auth = 'Bearer cron-secret') => new Request('https://app.example/api/integrations/asana/worker', { headers: { authorization: auth, host: 'app.example' } })
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', 'cron-secret')
  vi.stubEnv('ASANA_ACCESS_TOKEN', 'test-token')
  vi.stubEnv('ASANA_WORKER_DRY_RUN', 'false')
  vi.stubEnv('ASANA_WORKER_BATCH', '2')
  vi.stubEnv('ASANA_LIVE_INCIDENTS_ENABLED', 'true')
  vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', '')
  h.batch.mockResolvedValue([{ status: 'no_pending' }])
  h.attach.mockResolvedValue({ status: 'no_pending' })
  h.provider.mockImplementation((_token, destination = 'beta') => ({ destination }))
  h.fields.mockImplementation((_token, config) => ({ projectGid: config.projectGid }))
})
afterEach(() => vi.unstubAllEnvs())

describe('automatic staff Asana processing', () => {
  it('requires the cron secret before creating clients or reading queues', async () => {
    expect((await GET(request('Bearer wrong'))).status).toBe(401)
    expect(h.batch).not.toHaveBeenCalled()
    expect(h.provider).not.toHaveBeenCalled()
  })
  it('dry-run mode writes nothing', async () => {
    vi.stubEnv('ASANA_WORKER_DRY_RUN', 'true')
    expect(await (await GET(request())).json()).toMatchObject({ ran: false })
    expect(h.batch).not.toHaveBeenCalled()
    expect(h.attach).not.toHaveBeenCalled()
  })
  it('production drains the live queue with live schema and attaches without a manual request', async () => {
    h.batch.mockResolvedValueOnce([{ status: 'no_pending' }]).mockResolvedValueOnce([{ status: 'created' }, { status: 'no_pending' }])
    h.attach.mockResolvedValueOnce({ status: 'no_pending' }).mockResolvedValueOnce({ status: 'uploaded' })
    expect(await (await GET(request())).json()).toMatchObject({ ran: true, processed: 1, attach: { status: 'uploaded' } })
    expect(h.batch.mock.calls[1][1]).toEqual({ destination: 'live_incidents' })
    expect(h.batch.mock.calls[1][2]).toMatchObject({ destination: 'live_incidents', loadFieldValidation: { projectGid: '1211426202387126' } })
    expect(h.batch.mock.calls[1][3]).toBe(2)
    expect(h.attach.mock.calls[1][1]).toMatchObject({ destination: 'live_incidents' })
  })
  it('remaining creation budget excludes empty-queue probes', async () => {
    h.batch.mockResolvedValueOnce([{ status: 'created' }, { status: 'no_pending' }])
    await GET(request())
    expect(h.batch.mock.calls[1][3]).toBe(1)
  })
  it('honours the total creation budget and only one attachment pass doing work', async () => {
    h.batch.mockResolvedValueOnce([{ status: 'created' }, { status: 'adopted' }])
    h.attach.mockResolvedValueOnce({ status: 'uploaded' })
    await GET(request())
    expect(h.batch).toHaveBeenCalledTimes(1)
    expect(h.attach).toHaveBeenCalledTimes(1)
  })
  it('does not run a second attachment pass after a BETA error', async () => {
    h.attach.mockResolvedValueOnce({ status: 'error' })
    await GET(request())
    expect(h.attach).toHaveBeenCalledTimes(1)
  })
  it('preview TEST alone still cannot start automatic live writes', async () => {
    vi.stubEnv('ASANA_LIVE_INCIDENTS_ENABLED', '')
    vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', 'true')
    await GET(request())
    expect(h.batch).toHaveBeenCalledTimes(1)
    expect(h.attach).toHaveBeenCalledTimes(1)
    expect(h.provider.mock.calls.every((args) => args[1] !== 'live_incidents')).toBe(true)
  })
})
