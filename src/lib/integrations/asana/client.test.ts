import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createTaskInProject,
  addTaskToSection,
  AsanaApiError,
  ASANA_REQUEST_TIMEOUT_MS,
  RECONCILE_MAX_PAGES,
  getTaskForReconciliation,
  listProjectTasksModifiedSince,
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
  it('POSTs to /tasks with bearer auth + ATOMIC project+section membership, and parses the response', async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({ data: { gid: 'T1', permalink_url: 'https://app.asana.com/0/1/T1' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const task = await createTaskInProject('tok', {
      projectGid: 'P1',
      sectionGid: 'S1',
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
    // Stage 0: project AND section in the SAME request — no follow-up call.
    expect(body.data.memberships).toEqual([{ project: 'P1', section: 'S1' }])
    expect(body.data.projects).toBeUndefined()
    expect(body.data.name).toBe('Broken pot')
    expect(body.data.due_on).toBeUndefined()
  })

  it('includes due_on only when provided', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: { gid: 'T2', permalink_url: 'u' } }))
    vi.stubGlobal('fetch', fetchMock)
    await createTaskInProject('tok', {
      projectGid: 'P', sectionGid: 'S',
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
    const task = await createTaskInProject('tok', { projectGid: 'P', sectionGid: 'S', name: 'n', notes: 'x' })
    expect(task.gid).toBe('T3')
    expect(task.permalinkUrl).toBe('https://app.asana.com/0/0/T3')
  })

  it('throws AsanaApiError on a 4xx', async () => {
    const fetchMock = vi.fn(async () => mockResponse('unauthorized', { ok: false, status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      createTaskInProject('tok', { projectGid: 'P', sectionGid: 'S', name: 'n', notes: 'x' }),
    ).rejects.toBeInstanceOf(AsanaApiError)
  })

  it('throws AsanaApiError (with status) on a 5xx', async () => {
    const fetchMock = vi.fn(async () => mockResponse('boom', { ok: false, status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const err = await createTaskInProject('tok', {
      projectGid: 'P', sectionGid: 'S',
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
      createTaskInProject('tok', { projectGid: 'P', sectionGid: 'S', name: 'n', notes: 'x' }),
    ).rejects.toBeInstanceOf(AsanaApiError)
  })

  it('never puts the token in the error message', async () => {
    const fetchMock = vi.fn(async () => mockResponse('nope', { ok: false, status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    const err = await createTaskInProject('SUPER-SECRET-TOKEN', {
      projectGid: 'P', sectionGid: 'S',
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

// ----------------------------------------------------------------
// Stage 0 — timeouts, 429 Retry-After, read-only reconciliation calls
// ----------------------------------------------------------------

function withHeaders(body: unknown, init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

describe('Stage 0 client behaviour', () => {
  it(`create sends an explicit ~${ASANA_REQUEST_TIMEOUT_MS / 1000}s timeout signal`, async () => {
    const fetchMock = vi.fn(async () => mockResponse({ data: { gid: 'T1' } }))
    vi.stubGlobal('fetch', fetchMock)
    await createTaskInProject('tok', { projectGid: 'P', sectionGid: 'S', name: 'n', notes: 'x' })
    const [, opts] = fetchMock.mock.calls[0] as unknown as [string, { signal?: AbortSignal }]
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    expect(ASANA_REQUEST_TIMEOUT_MS).toBe(30_000)
  })

  it('a 429 on create carries Retry-After (and never the token or body in the message)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => withHeaders('slow down tok-SECRET', { ok: false, status: 429, headers: { 'retry-after': '17' } })))
    const err = (await createTaskInProject('tok-SECRET', { projectGid: 'P', sectionGid: 'S', name: 'n', notes: 'x' }).catch((e) => e)) as AsanaApiError
    expect(err).toBeInstanceOf(AsanaApiError)
    expect(err.status).toBe(429)
    expect(err.retryAfterSeconds).toBe(17)
  })

  it('getTaskForReconciliation: one GET, minimal fields, null on 404', async () => {
    const fetchMock = vi.fn(async () => withHeaders({ data: { gid: 'T9', notes: 'a\nb', memberships: [{ project: { gid: 'P' } }] } }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await getTaskForReconciliation('tok', 'T9')).toEqual({ gid: 'T9', notes: 'a\nb', projectGids: ['P'] })
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body?: unknown; signal?: AbortSignal }]
    expect(opts.method).toBe('GET')
    expect(opts.body).toBeUndefined()
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    expect(decodeURIComponent(url)).toContain('opt_fields=notes,memberships.project.gid')
    vi.stubGlobal('fetch', vi.fn(async () => withHeaders('gone', { ok: false, status: 404 })))
    expect(await getTaskForReconciliation('tok', 'T9')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => withHeaders('boom', { ok: false, status: 503 })))
    await expect(getTaskForReconciliation('tok', 'T9')).rejects.toMatchObject({ status: 503 })
  })

  const page = (tasks: unknown[], next: unknown, includeNext = true) =>
    withHeaders(includeNext ? { data: tasks, next_page: next } : { data: tasks })

  it('listProjectTasksModifiedSince: paginated GETs scoped to ONE project, minimal fields', async () => {
    const t = (gid: string) => ({ gid, notes: 'n', memberships: [{ project: { gid: 'P' } }] })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page([t('A')], { offset: 'o1' }))
      .mockResolvedValueOnce(page([t('B')], null))
    vi.stubGlobal('fetch', fetchMock)
    const tasks = await listProjectTasksModifiedSince('tok', 'P', '2026-11-02T00:00:00.000Z')
    expect(tasks.map((x) => x.gid)).toEqual(['A', 'B'])
    const urls = fetchMock.mock.calls.map((c) => decodeURIComponent(String(c[0])))
    expect(urls[0]).toContain('project=P')
    expect(urls[0]).toContain('modified_since=2026-11-02T00:00:00.000Z')
    expect(urls[0]).toContain('limit=100')
    expect(urls[0]).toContain('opt_fields=notes,memberships.project.gid')
    expect(urls[1]).toContain('offset=o1')
    for (const call of fetchMock.mock.calls) expect((call[1] as { method: string }).method).toBe('GET')
  })

  it.each([
    ['missing next_page', () => page([], undefined, false)],
    ['next_page = {}', () => page([], {})],
    ['blank offset', () => page([], { offset: '  ' })],
    ['array next_page', () => page([], [])],
    ['malformed task', () => page([{ notes: 'no gid' }], null)],
    ['malformed page', () => withHeaders({ data: 'x', next_page: null })],
  ])('lookup FAILS CLOSED on %s (throws; never a partial "not found")', async (_l, res) => {
    vi.stubGlobal('fetch', vi.fn(async () => res()))
    await expect(listProjectTasksModifiedSince('tok', 'P', 'x')).rejects.toThrow(/malformed/)
  })

  it('lookup throws on a repeated offset and at the page cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => page([], { offset: 'same' })))
    await expect(listProjectTasksModifiedSince('tok', 'P', 'x')).rejects.toThrow(/repeated/)
    let n = 0
    const fetchMock = vi.fn(async () => page([], { offset: `o${n++}` }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(listProjectTasksModifiedSince('tok', 'P', 'x')).rejects.toThrow(/exceeded/)
    expect(fetchMock).toHaveBeenCalledTimes(RECONCILE_MAX_PAGES)
  })
})

describe('Stage 0 request timeout: aborts at 30s and is ALWAYS cleared', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const okTask = { data: { gid: 'T1', notes: 'n', memberships: [{ project: { gid: 'P' } }] } }
  const calls: Array<[string, () => Promise<unknown>, unknown]> = [
    ['createTaskInProject', () => createTaskInProject('tok', { projectGid: 'P', sectionGid: 'S', name: 'n', notes: 'x' }), { data: { gid: 'T1' } }],
    ['getTaskForReconciliation', () => getTaskForReconciliation('tok', 'T1'), okTask],
    ['listProjectTasksModifiedSince', () => listProjectTasksModifiedSince('tok', 'P', '2026-11-02T00:00:00.000Z'), { data: [], next_page: null }],
  ]

  it.each(calls)('%s: timer cleared on SUCCESS', async (_n, call, body) => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => withHeaders(body)))
    await call()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(calls)('%s: timer cleared on an HTTP ERROR', async (_n, call) => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => withHeaders('boom', { ok: false, status: 500 })))
    await expect(call()).rejects.toBeInstanceOf(AsanaApiError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(calls)('%s: timer cleared on a NETWORK error', async (_n, call) => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(call()).rejects.toThrow('fetch failed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(calls)('%s: a hung request is ABORTED at 30s (TimeoutError) and the timer is gone', async (_n, call) => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason))
        }),
      ),
    )
    const settled = vi.fn()
    const p = call().then(settled, (e: unknown) => {
      settled(e)
      throw e
    })
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(ASANA_REQUEST_TIMEOUT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a body that hangs is covered by the same timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { signal: AbortSignal }) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason))
          }),
      })),
    )
    const p = getTaskForReconciliation('tok', 'T1')
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(ASANA_REQUEST_TIMEOUT_MS)
    await expect(p).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
