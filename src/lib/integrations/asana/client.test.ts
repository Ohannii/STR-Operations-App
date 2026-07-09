import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createTaskInProject,
  addTaskToSection,
  AsanaApiError,
} from '@/lib/integrations/asana/client'

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

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createTaskInProject', () => {
  it('POSTs to /tasks with bearer auth + project, and parses the response', async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({ data: { gid: 'T1', permalink_url: 'https://app.asana.com/0/1/T1' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const task = await createTaskInProject('tok', {
      projectGid: 'P1',
      name: 'Broken pot',
      notes: 'body',
    })

    expect(task).toEqual({ gid: 'T1', permalinkUrl: 'https://app.asana.com/0/1/T1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ]
    expect(url).toContain('/tasks')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer tok')
    const body = JSON.parse(opts.body)
    expect(body.data.projects).toEqual(['P1'])
    expect(body.data.name).toBe('Broken pot')
    expect(body.data.due_on).toBeUndefined()
  })

  it('includes due_on only when provided', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: { gid: 'T2', permalink_url: 'u' } }))
    vi.stubGlobal('fetch', fetchMock)
    await createTaskInProject('tok', {
      projectGid: 'P',
      name: 'n',
      notes: 'x',
      dueOn: '2026-07-08',
    })
    const [, opts] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect(JSON.parse(opts.body).data.due_on).toBe('2026-07-08')
  })

  it('falls back to a constructed permalink when none is returned', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: { gid: 'T3' } }))
    vi.stubGlobal('fetch', fetchMock)
    const task = await createTaskInProject('tok', { projectGid: 'P', name: 'n', notes: 'x' })
    expect(task.gid).toBe('T3')
    expect(task.permalinkUrl).toBe('https://app.asana.com/0/0/T3')
  })

  it('throws AsanaApiError on a 4xx', async () => {
    const fetchMock = vi.fn(async () => mockResponse('unauthorized', { ok: false, status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      createTaskInProject('tok', { projectGid: 'P', name: 'n', notes: 'x' }),
    ).rejects.toBeInstanceOf(AsanaApiError)
  })

  it('throws AsanaApiError (with status) on a 5xx', async () => {
    const fetchMock = vi.fn(async () => mockResponse('boom', { ok: false, status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const err = await createTaskInProject('tok', {
      projectGid: 'P',
      name: 'n',
      notes: 'x',
    }).catch((e) => e)
    expect(err).toBeInstanceOf(AsanaApiError)
    expect((err as AsanaApiError).status).toBe(500)
  })

  it('throws when the response has no task gid', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: {} }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      createTaskInProject('tok', { projectGid: 'P', name: 'n', notes: 'x' }),
    ).rejects.toBeInstanceOf(AsanaApiError)
  })

  it('never puts the token in the error message', async () => {
    const fetchMock = vi.fn(async () => mockResponse('nope', { ok: false, status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    const err = await createTaskInProject('SUPER-SECRET-TOKEN', {
      projectGid: 'P',
      name: 'n',
      notes: 'x',
    }).catch((e) => e)
    expect(String(err)).not.toContain('SUPER-SECRET-TOKEN')
  })
})

describe('addTaskToSection', () => {
  it('POSTs the task to the section addTask endpoint', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: {} }))
    vi.stubGlobal('fetch', fetchMock)
    await addTaskToSection('tok', { taskGid: 'T1', sectionGid: 'S1' })
    const [url, opts] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ]
    expect(url).toContain('/sections/S1/addTask')
    expect(opts.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(opts.body).data.task).toBe('T1')
  })

  it('throws AsanaApiError on failure', async () => {
    const fetchMock = vi.fn(async () => mockResponse('nope', { ok: false, status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      addTaskToSection('tok', { taskGid: 'T', sectionGid: 'S' }),
    ).rejects.toBeInstanceOf(AsanaApiError)
  })
})
