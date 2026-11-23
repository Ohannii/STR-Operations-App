// Server-side Hostaway transport. Only server actions import this module.
// Project credentials and provider response bodies are never logged or returned.
import 'server-only'
export type HostawayFailure = 'credentials_rejected' | 'rate_limited' | 'unavailable' | 'invalid_response' | 'incomplete_response'
export class HostawayError extends Error {
  constructor(public code: HostawayFailure, public retryAt: number | null = null) { super(code) }
}
export type HostawayListing = { id: string; name: string; timeZone: string | null }
export type HostawayUnit = { id: string; name: string; unitNumber: string | null; linkedListingId: string | null }
type IO = { fetch: typeof fetch; now: () => number; wait: (ms: number) => Promise<void> }
const defaultIO: IO = { fetch: (...args) => fetch(...args), now: Date.now, wait: ms => new Promise(resolve => setTimeout(resolve, ms)) }
const base = 'https://api.hostaway.com/v1'

export function providerId(value: unknown): string | null {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return /^[1-9]\d{0,17}$/.test(text) ? text : null
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostawayError('invalid_response')
  return value as Record<string, unknown>
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new HostawayError('invalid_response')
  return value.trim()
}
function timeZone(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 100) return null
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return value } catch { return null }
}
async function request(path: string, init: RequestInit, io: IO): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await io.fetch(`${base}${path}`, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) })
  } catch { throw new HostawayError('unavailable') }
  if (response.status === 401 || response.status === 403) throw new HostawayError('credentials_rejected')
  if (response.status === 429) {
    // Hostaway's header is an absolute Unix timestamp, not a delay.
    const seconds = Number(response.headers.get('X-RateLimit-Retry-After'))
    throw new HostawayError('rate_limited', Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null)
  }
  if (!response.ok) throw new HostawayError('unavailable')
  try {
    const text = await response.text()
    if (text.length > 2_000_000) throw new HostawayError('invalid_response')
    const body = record(JSON.parse(text))
    if (body.status !== undefined && body.status !== 'success') throw new HostawayError('invalid_response')
    return body
  } catch { throw new HostawayError('invalid_response') }
}
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json' })

export async function exchangeHostawayCredentials(accountId: string, apiKey: string, io: IO = defaultIO) {
  if (!providerId(accountId) || !apiKey.trim() || apiKey.length > 4096) throw new HostawayError('credentials_rejected')
  const body = await request('/accessTokens', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: accountId, client_secret: apiKey.trim(), scope: 'general' }).toString(),
  }, io)
  if (body.token_type !== 'Bearer' || typeof body.access_token !== 'string' || body.access_token.length < 16 || body.access_token.length > 16000
    || typeof body.expires_in !== 'number' || !Number.isSafeInteger(body.expires_in) || body.expires_in < 2 || body.expires_in > 3 * 366 * 86400) {
    throw new HostawayError('invalid_response')
  }
  const token = body.access_token
  const expiresAt = new Date(io.now() + body.expires_in * 1000).toISOString()
  // Newly issued Hostaway tokens are not valid for the first second.
  await io.wait(1000)
  const check = await request('/listings?limit=1&offset=0', { headers: headers(token) }, io)
  if (!Array.isArray(check.result)) throw new HostawayError('invalid_response')
  return { token, expiresAt }
}

export async function readHostawayListings(token: string, io: IO = defaultIO): Promise<HostawayListing[]> {
  const listings: HostawayListing[] = []
  const seen = new Set<string>()
  const limit = 100
  let total: number | undefined
  for (let page = 0; page < 20; page++) {
    const body = await request(`/listings?limit=${limit}&offset=${page * limit}`, { headers: headers(token) }, io)
    if (!Array.isArray(body.result) || body.result.length > limit) throw new HostawayError('invalid_response')
    if (body.count !== undefined) {
      if (typeof body.count !== 'number' || !Number.isSafeInteger(body.count) || body.count < 0) throw new HostawayError('invalid_response')
      if (total !== undefined && total !== body.count) throw new HostawayError('incomplete_response')
      total = body.count
    }
    for (const item of body.result) {
      const row = record(item), id = providerId(row.id)
      if (!id || seen.has(id)) throw new HostawayError('incomplete_response')
      seen.add(id)
      listings.push({ id, name: name(row.internalListingName || row.name), timeZone: timeZone(row.timeZoneName) })
    }
    if (total !== undefined && listings.length > total) throw new HostawayError('incomplete_response')
    if (body.result.length < limit) {
      if (total !== undefined && listings.length !== total) throw new HostawayError('incomplete_response')
      return listings
    }
    if (total !== undefined && listings.length === total) return listings
    // Bound this connection's request rate; do not generate a new token per call.
    await io.wait(100)
  }
  throw new HostawayError('incomplete_response')
}

export async function readHostawayUnits(token: string, listingId: string, io: IO = defaultIO): Promise<HostawayUnit[]> {
  if (!providerId(listingId)) throw new HostawayError('invalid_response')
  const body = await request(`/listingUnits/${listingId}`, { headers: headers(token) }, io)
  if (!Array.isArray(body.result) || body.result.length > 500) throw new HostawayError('invalid_response')
  const seen = new Set<string>()
  return body.result.map(item => {
    const row = record(item), id = providerId(row.id)
    if (!id || seen.has(id)) throw new HostawayError('invalid_response')
    seen.add(id)
    return { id, name: name(row.name), unitNumber: typeof row.unitNumber === 'string' ? row.unitNumber.slice(0, 100) : null, linkedListingId: providerId(row.listingMapIdUnit) }
  })
}
