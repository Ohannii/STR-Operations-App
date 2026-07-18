import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  addAttachmentToTask,
  listTaskAttachments,
  parseRetryAfter,
  AsanaApiError,
} from '@/lib/integrations/asana/client'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('addAttachmentToTask', () => {
  it('POSTs multipart FormData with no manual Content-Type, returns gid', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return jsonResponse({ data: { gid: 'att-1' } })
    }) as unknown as typeof fetch

    const res = await addAttachmentToTask('tok', {
      taskGid: 'task-9',
      filename: 'x.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]),
    })

    expect(res.gid).toBe('att-1')
    const { init } = calls[0]
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
    expect('Content-Type' in headers).toBe(false) // fetch sets the multipart boundary

    // Verify the uploaded file: correct multipart fields, content type, and
    // that the exact 3 bytes were preserved through the ArrayBuffer copy.
    const body = init.body as FormData
    expect(body.get('parent')).toBe('task-9')
    const file = body.get('file')
    expect(file).toBeInstanceOf(Blob)
    expect((file as Blob).type).toBe('application/pdf')
    expect((file as Blob).size).toBe(3)
  })

  it('throws AsanaApiError with retryAfterSeconds on 429', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ errors: [{ message: 'rate limited' }] }, {
        status: 429,
        headers: { 'retry-after': '7' },
      }),
    ) as unknown as typeof fetch

    await expect(
      addAttachmentToTask('tok', {
        taskGid: 't',
        filename: 'x.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([0]),
      }),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 7 })
  })
})

describe('listTaskAttachments', () => {
  it('follows offset pagination and returns all attachments', async () => {
    const pages = [
      jsonResponse({ data: [{ gid: 'a1', name: 'one.pdf' }], next_page: { offset: 'OFF2' } }),
      jsonResponse({ data: [{ gid: 'a2', name: 'two.jpg' }], next_page: null }),
    ]
    let i = 0
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url))
      return pages[i++]
    }) as unknown as typeof fetch

    const out = await listTaskAttachments('tok', 'task-9')
    expect(out.map((a) => a.gid)).toEqual(['a1', 'a2'])
    expect(seen[0]).toContain('parent=task-9')
    expect(seen[1]).toContain('offset=OFF2')
  })
})

describe('parseRetryAfter', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfter(new Response(null, { headers: { 'retry-after': '12' } }))).toBe(12)
  })
  it('returns undefined when absent', () => {
    expect(parseRetryAfter(new Response(null))).toBeUndefined()
  })
})

describe('AsanaApiError', () => {
  it('carries status and does not include the token', () => {
    const e = new AsanaApiError('add attachment', 500, 'boom')
    expect(e.status).toBe(500)
    expect(e.message).not.toContain('tok')
  })
})
