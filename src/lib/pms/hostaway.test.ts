import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { exchangeHostawayCredentials, providerId, readHostawayListings, readHostawayUnits } from './hostaway'
const NOW = Date.parse('2026-11-23T08:00:00Z'), TOKEN = 'synthetic-access-token-only'
const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers })
const listing = (id = 91) => ({ id, internalListingName: 'BL 91', name: 'Public name', timeZoneName: 'Africa/Johannesburg', privateField: 'omit-me' })
function io(...responses: Response[]) {
  return { fetch: vi.fn<typeof fetch>().mockImplementation(async () => { const next = responses.shift(); if (!next) throw Error('unexpected call'); return next }), now: () => NOW, wait: vi.fn().mockResolvedValue(undefined) }
}
describe('Hostaway server transport', () => {
  it('uses documented client credentials, waits for activation, verifies token and uses actual expiry', async () => {
    const transport = io(response({ token_type: 'Bearer', access_token: TOKEN, expires_in: 3600 }), response({ status: 'success', result: [] }))
    expect(await exchangeHostawayCredentials('123', ' secret&key ', transport)).toEqual({ token: TOKEN, expiresAt: '2026-11-23T09:00:00.000Z' })
    const [url, init] = transport.fetch.mock.calls[0]
    expect(url).toBe('https://api.hostaway.com/v1/accessTokens')
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' })
    expect(Object.fromEntries(new URLSearchParams(init?.body as string))).toEqual({ client_id: '123', client_secret: 'secret&key', grant_type: 'client_credentials', scope: 'general' })
    expect(transport.wait).toHaveBeenCalledExactlyOnceWith(1000)
    expect(transport.fetch.mock.calls[1]).toMatchObject(['https://api.hostaway.com/v1/listings?limit=1&offset=0', { headers: { Authorization: `Bearer ${TOKEN}` } }])
    expect(transport.wait.mock.invocationCallOrder[0]).toBeLessThan(transport.fetch.mock.invocationCallOrder[1])
  })
  it.each([0, -1, '01', '../listings', 'https://evil.invalid'])('rejects unsafe identifier %s before any request', async value => {
    expect(providerId(value)).toBeNull()
    const transport = io()
    await expect(readHostawayUnits(TOKEN, String(value), transport)).rejects.toMatchObject({ code: 'invalid_response' })
    expect(transport.fetch).not.toHaveBeenCalled()
  })
  it('rejects unsafe numeric IDs while preserving exact long string IDs', () => {
    expect(providerId(9007199254740992)).toBeNull()
    expect(providerId('9007199254740992')).toBe('9007199254740992')
  })
  it.each([401, 403, 500])('sanitizes provider failure %s and never exposes response bodies', async status => {
    const transport = io(response({ error: `private-${TOKEN}` }, status))
    await expect(exchangeHostawayCredentials('123', 'private-api-key', transport)).rejects.toMatchObject({ code: status === 500 ? 'unavailable' : 'credentials_rejected' })
    try { await readHostawayListings(TOKEN, io(response({ private: TOKEN }, status))) } catch (e) { expect(JSON.stringify(e)).not.toContain(TOKEN) }
  })
  it('handles rate-limit header as an absolute timestamp with no automatic repeated POST', async () => {
    const transport = io(response({}, 429, { 'X-RateLimit-Retry-After': '1795420830' }))
    await expect(exchangeHostawayCredentials('123', 'private-api-key', transport)).rejects.toMatchObject({ code: 'rate_limited', retryAt: 1795420830000 })
    expect(transport.fetch).toHaveBeenCalledOnce()
  })
  it.each([
    { token_type: 'Basic', access_token: TOKEN, expires_in: 3600 },
    { token_type: 'Bearer', access_token: TOKEN, expires_in: 0 },
    { token_type: 'Bearer', access_token: 'short', expires_in: 3600 },
    { token_type: 'Bearer', access_token: TOKEN, expires_in: '3600' },
  ])('never stores an unverified token response', async body => {
    const transport = io(response(body))
    await expect(exchangeHostawayCredentials('123', 'private-api-key', transport)).rejects.toMatchObject({ code: 'invalid_response' })
    expect(transport.fetch).toHaveBeenCalledOnce()
  })
  it('requires the token to work, even after a successful exchange', async () => {
    const transport = io(response({ token_type: 'Bearer', access_token: TOKEN, expires_in: 3600 }), response({}, 403))
    await expect(exchangeHostawayCredentials('123', 'private-api-key', transport)).rejects.toMatchObject({ code: 'credentials_rejected' })
  })
  it('projects only listing identity, display name and valid timezone', async () => {
    const result = await readHostawayListings(TOKEN, io(response({ result: [listing()] })))
    expect(result).toEqual([{ id: '91', name: 'BL 91', timeZone: 'Africa/Johannesburg' }])
    expect(await readHostawayListings(TOKEN, io(response({ result: [{ ...listing(), timeZoneName: 'Unknown/Place' }] })))).toEqual([{ id: '91', name: 'BL 91', timeZone: null }])
  })
  it('pages without truncating listings or minting another token', async () => {
    const transport = io(response({ count: 101, result: Array.from({ length: 100 }, (_, n) => listing(n + 1)) }), response({ count: 101, result: [listing(101)] }))
    expect(await readHostawayListings(TOKEN, transport)).toHaveLength(101)
    expect(transport.fetch.mock.calls.map(c => c[0])).toEqual(['https://api.hostaway.com/v1/listings?limit=100&offset=0', 'https://api.hostaway.com/v1/listings?limit=100&offset=100'])
  })
  it.each([
    { count: 5, result: [listing()] }, { result: [listing(), listing()] }, { result: null }, { status: 'error', result: [] },
  ])('refuses incomplete or ambiguous listing collections', async body => {
    await expect(readHostawayListings(TOKEN, io(response(body)))).rejects.toMatchObject({ code: expect.stringMatching(/invalid_response|incomplete_response/) })
  })
  it('refuses a changing collection during pagination', async () => {
    const transport = io(response({ count: 101, result: Array.from({ length: 100 }, (_, n) => listing(n + 1)) }), response({ count: 102, result: [listing(101), listing(102)] }))
    await expect(readHostawayListings(TOKEN, transport)).rejects.toMatchObject({ code: 'incomplete_response' })
  })
  it('bounds collection discovery instead of returning a partial 2000-listing snapshot', async () => {
    const pages = Array.from({ length: 20 }, (_, page) => response({ result: Array.from({ length: 100 }, (_, n) => listing(page * 100 + n + 1)) }))
    await expect(readHostawayListings(TOKEN, io(...pages))).rejects.toMatchObject({ code: 'incomplete_response' })
  })
  it('reads physical subunit identities without guessing from unit number or retaining provider extras', async () => {
    const transport = io(response({ result: [{ id: 7, name: 'Apartment 91', unitNumber: '91', listingMapIdUnit: 900, privateField: TOKEN }] }))
    expect(await readHostawayUnits(TOKEN, '45', transport)).toEqual([{ id: '7', name: 'Apartment 91', unitNumber: '91', linkedListingId: '900' }])
    expect(transport.fetch.mock.calls[0][0]).toBe('https://api.hostaway.com/v1/listingUnits/45')
  })
  it('does not interpret failed or malformed subunit discovery as one apartment', async () => {
    await expect(readHostawayUnits(TOKEN, '45', io(response({ result: null })))).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(readHostawayUnits(TOKEN, '45', io(response({ result: [{ id: 7, name: 'A' }, { id: 7, name: 'B' }] })))).rejects.toMatchObject({ code: 'invalid_response' })
  })
})
