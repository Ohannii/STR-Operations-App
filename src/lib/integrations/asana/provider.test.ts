import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAsanaProvider } from '@/lib/integrations/asana/provider'
import { AsanaApiError } from '@/lib/integrations/asana/client'
import {
  ASANA_TEST_PROJECT_GID,
  DisallowedAsanaProjectError,
} from '@/lib/integrations/asana/config'
import type { TaskPayload } from '@/lib/integrations/types'

function mockResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

function payload(overrides: Partial<TaskPayload> = {}): TaskPayload {
  return {
    workspaceGid: 'W',
    projectGid: ASANA_TEST_PROJECT_GID,
    sectionGid: 'S1',
    name: '[Maintenance] Unit — Broken pot',
    notes: 'body',
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createAsanaProvider', () => {
  it('refuses a disallowed project and makes NO fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const provider = createAsanaProvider('tok')
    await expect(
      // live "Incidents & Damages Reporting" project — must be rejected
      provider.createTask(payload({ projectGid: '1211426202387126' })),
    ).rejects.toBeInstanceOf(DisallowedAsanaProjectError)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Stage 0: creates the task in project AND section in ONE request — no separate section call', async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({ data: { gid: 'T9', permalink_url: 'https://app.asana.com/0/1/T9' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = createAsanaProvider('tok')
    const res = await provider.createTask(payload())

    expect(res).toEqual({ externalTaskGid: 'T9', externalTaskUrl: 'https://app.asana.com/0/1/T9' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(String(url)).not.toContain('/sections/')
    expect(JSON.parse(opts.body).data.memberships).toEqual([
      { project: ASANA_TEST_PROJECT_GID, section: 'S1' },
    ])
  })

  it('propagates a client API error (one request, nothing else attempted)', async () => {
    const fetchMock = vi.fn(async () => mockResponse('server error', { ok: false, status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = createAsanaProvider('tok')
    await expect(provider.createTask(payload())).rejects.toBeInstanceOf(AsanaApiError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the read-only lookups refuse a live/disallowed project BEFORE any network call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const provider = createAsanaProvider('tok')
    await expect(provider.getTask('1211426202387126', 'T1')).rejects.toBeInstanceOf(DisallowedAsanaProjectError)
    await expect(provider.listTasksModifiedSince('1211426202387126', '2026-01-01T00:00:00Z')).rejects.toBeInstanceOf(
      DisallowedAsanaProjectError,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('source contract: the provider no longer calls addTaskToSection', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/integrations/asana/provider.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toContain('addTaskToSection')
  })
})

describe('BETA custom-field boundary (before any network call)', () => {
  const CAT = '1220057630679849'
  const INV_OPT = '1220057630679850'

  it('passes configured BETA fields through in the ONE create request', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: { gid: 'T9' } }))
    vi.stubGlobal('fetch', fetchMock)
    await createAsanaProvider('tok').createTask(payload({ customFields: { [CAT]: INV_OPT } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, opts] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(JSON.parse(opts.body).data.custom_fields).toEqual({ [CAT]: INV_OPT })
  })

  it.each([
    ['an unknown field GID', { '999': INV_OPT }],
    ['a LIVE field GID (Category)', { '1211490712226251': '1211490712226253' }],
    ['a LIVE option on a BETA field', { [CAT]: '1211490712226253' }],
    ['an unconfigured option (Evidence "No")', { '1220057561518792': '1220057561518794' }],
    ['a name instead of a GID', { [CAT]: 'Inventory' }],
    ['an array for an enum', { [CAT]: [INV_OPT] }],
    ['a string for a multi_enum', { '1220057561518796': '1220057561518797' }],
    ['an empty multi_enum', { '1220057561518796': [] as string[] }],
    ['an array for text', { '1210401516520213': ['x'] }],
  ])('refuses %s and makes NO fetch', async (_l, customFields) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      createAsanaProvider('tok').createTask(payload({ customFields: customFields as Record<string, string | string[]> })),
    ).rejects.toMatchObject({ name: 'DisallowedAsanaFieldError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a live PROJECT is refused before the field check and before any fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      createAsanaProvider('tok').createTask(payload({ projectGid: '1211426202387126', customFields: { [CAT]: INV_OPT } })),
    ).rejects.toBeInstanceOf(DisallowedAsanaProjectError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('empty fields -> no custom_fields key', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: { gid: 'T9' } }))
    vi.stubGlobal('fetch', fetchMock)
    await createAsanaProvider('tok').createTask(payload({ customFields: {} }))
    const [, opts] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(JSON.parse(opts.body).data).not.toHaveProperty('custom_fields')
  })
})
