import { describe, it, expect, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import {
  exactObjectPresence,
  isStorageObjectNotFound,
  type ObjectInfoApi,
} from '@/lib/photos/object-presence'

/**
 * Exact single-object presence through the INSTALLED Supabase SDK: a fake
 * fetch returns real Storage-shaped HTTP responses and the SDK's own error
 * parsing (storage-js 2.106.1) produces the result we classify. Response
 * bodies mirror what this project's Storage server returns (storage logs,
 * api 1.84.25): a missing object is HTTP 400 with body statusCode "404" and
 * message "Object not found".
 */

const PATH = 'companies/co/flags/f/p.jpg'

function sdkInfo(respond: () => Promise<Response> | Response) {
  const fetchMock = vi.fn(async () => respond())
  const client = createClient('https://example.supabase.co', 'anon-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchMock as unknown as typeof fetch },
  })
  return { files: client.storage.from('evidence-photos') as unknown as ObjectInfoApi, fetchMock }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const OBJECT_INFO = {
  id: 'obj-1',
  name: PATH,
  bucket_id: 'evidence-photos',
  size: 123,
  content_type: 'image/jpeg',
  created_at: '2026-11-03T13:09:27Z',
  updated_at: '2026-11-03T13:09:27Z',
  last_modified: '2026-11-03T13:09:27Z',
}

describe('exactObjectPresence — through the real SDK', () => {
  it('uses ONE exact GET /object/info request for the exact path (no listing)', async () => {
    const { files, fetchMock } = sdkInfo(() => json(200, OBJECT_INFO))
    expect(await exactObjectPresence(files, PATH)).toBe('present')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://example.supabase.co/storage/v1/object/info/evidence-photos/${PATH}`)
    expect((init.method ?? 'GET').toUpperCase()).toBe('GET')
    expect(url).not.toContain('/object/list')
  })

  it.each([
    ['HTTP 400 (this server) + body 404 Object not found', 400],
    ['HTTP 404 + body 404 Object not found', 404],
  ])('GENUINE missing object: %s -> missing', async (_l, status) => {
    const { files } = sdkInfo(() =>
      json(status, { statusCode: '404', error: 'not_found', message: 'Object not found' }),
    )
    expect(await exactObjectPresence(files, PATH)).toBe('missing')
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['missing BUCKET (body 404 "Bucket not found")', () => json(400, { statusCode: '404', error: 'not_found', message: 'Bucket not found' })],
    ['a different 400 (InvalidRequest)', () => json(400, { statusCode: '400', error: 'InvalidRequest', message: 'Invalid key' })],
    ['400 with no JSON body', () => new Response('', { status: 400, statusText: 'Bad Request' })],
    ['401 unauthenticated', () => json(401, { statusCode: '401', error: 'Unauthorized', message: 'jwt expired' })],
    ['403 permission', () => json(403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' })],
    ['429 rate limit', () => json(429, { statusCode: '429', error: 'too_many_requests', message: 'Too many requests' })],
    ['500 server', () => json(500, { statusCode: '500', error: 'internal', message: 'Internal Server Error' })],
    ['503 with no JSON body', () => new Response('upstream', { status: 503, statusText: 'Service Unavailable' })],
    ['200 with a non-object body', () => json(200, null)],
  ])('%s -> unknown (never treated as missing)', async (_l, respond) => {
    const { files } = sdkInfo(respond)
    expect(await exactObjectPresence(files, PATH)).toBe('unknown')
  })

  it('network failure -> unknown (no throw)', async () => {
    const { files } = sdkInfo(() => {
      throw new TypeError('fetch failed')
    })
    expect(await exactObjectPresence(files, PATH)).toBe('unknown')
  })
})

describe('exactObjectPresence — defensive edges', () => {
  it('an info() that throws (non-storage error) -> unknown', async () => {
    const files: ObjectInfoApi = { info: async () => { throw new Error('boom') } }
    expect(await exactObjectPresence(files, PATH)).toBe('unknown')
  })

  it.each([
    [{ name: 'StorageApiError', status: 400, statusCode: '404', message: 'Object not found' }, true],
    [{ name: 'StorageApiError', status: 404, statusCode: '404', message: 'Object not found' }, true],
    [{ name: 'StorageApiError', status: 500, statusCode: '404', message: 'Object not found' }, false],
    [{ name: 'StorageApiError', status: 400, statusCode: '400', message: 'Object not found' }, false],
    [{ name: 'StorageApiError', status: 400, statusCode: '404', message: 'Bucket not found' }, false],
    [{ name: 'StorageUnknownError', status: 400, statusCode: '404', message: 'Object not found' }, false],
    [{ status: 400, statusCode: '404', message: 'Object not found' }, false],
    [null, false],
    ['Object not found', false],
  ])('isStorageObjectNotFound(%j) = %s', (error, expected) => {
    expect(isStorageObjectNotFound(error)).toBe(expected)
  })
})
