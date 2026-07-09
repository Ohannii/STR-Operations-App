import { describe, it, expect, vi, afterEach } from 'vitest'
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

  it('creates the task then adds it to the section, returning gid + url', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/sections/')) return mockResponse({ data: {} })
      return mockResponse({ data: { gid: 'T9', permalink_url: 'https://app.asana.com/0/1/T9' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createAsanaProvider('tok')
    const res = await provider.createTask(payload())

    expect(res).toEqual({ externalTaskGid: 'T9', externalTaskUrl: 'https://app.asana.com/0/1/T9' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('propagates a client API error and does not add to a section', async () => {
    const fetchMock = vi.fn(async () => mockResponse('server error', { ok: false, status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = createAsanaProvider('tok')
    await expect(provider.createTask(payload())).rejects.toBeInstanceOf(AsanaApiError)
    // create failed → addTask never called
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
