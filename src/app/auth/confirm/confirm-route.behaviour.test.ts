import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Behavioural tests (mocked Supabase) for /auth/confirm.
 * GET must be a prefetch-safe interstitial (no client, no verify, no claim).
 * POST must verify the token but NEVER claim - regression for the
 * anni@drop-inn.co.za auto-accept.
 */

const clientMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => clientMock() }))

import { GET, POST } from './route'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example.com'
})
beforeEach(() => {
  clientMock.mockReset()
})

function makeSb(o: {
  otpError?: { message: string } | null
  user?: { id: string } | null
  memberships?: Array<{ id: string }>
}) {
  const verifyOtp = vi.fn().mockResolvedValue({ error: o.otpError ?? null })
  const getUser = vi
    .fn()
    .mockResolvedValue({ data: { user: o.user === undefined ? { id: 'u1' } : o.user } })
  const limit = vi.fn().mockResolvedValue({ data: o.memberships ?? [] })
  const is = vi.fn(() => ({ limit }))
  const eq2 = vi.fn(() => ({ is }))
  const eq1 = vi.fn(() => ({ eq: eq2 }))
  const select = vi.fn(() => ({ eq: eq1 }))
  const from = vi.fn(() => ({ select }))
  const rpc = vi.fn()
  return { auth: { verifyOtp, getUser }, from, rpc, _s: { verifyOtp, getUser, from, rpc, limit } }
}

function form(fields: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

describe('GET /auth/confirm (prefetch-safe interstitial)', () => {
  it('renders an HTML POST form and touches no Supabase client', async () => {
    const res = await GET({
      url: 'https://app.example.com/auth/confirm?token_hash=abc&type=invite',
    } as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('method="POST"')
    expect(body).toContain('abc')
    expect(clientMock).not.toHaveBeenCalled()
  })

  it('fails safely to /login on a missing/invalid token', async () => {
    const res = await GET({ url: 'https://app.example.com/auth/confirm' } as never)
    expect(res.headers.get('location')).toContain('/login')
    expect(clientMock).not.toHaveBeenCalled()
  })
})

describe('POST /auth/confirm (verify only, never claim)', () => {
  it('verifies the token and routes a new invitee to set-password, without claiming', async () => {
    const sb = makeSb({ memberships: [] })
    clientMock.mockReturnValue(sb)
    const res = await POST({
      formData: async () => form({ token_hash: 'abc', type: 'invite' }),
    } as never)
    expect(sb._s.verifyOtp).toHaveBeenCalledWith({ type: 'invite', token_hash: 'abc' })
    expect(sb._s.rpc).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toContain('/invite/set-password')
  })

  it('routes an already-active member to the dashboard, still without claiming', async () => {
    const sb = makeSb({ memberships: [{ id: 'm1' }] })
    clientMock.mockReturnValue(sb)
    const res = await POST({
      formData: async () => form({ token_hash: 'abc', type: 'invite' }),
    } as never)
    expect(res.headers.get('location')).toContain('/dashboard')
    expect(sb._s.rpc).not.toHaveBeenCalled()
  })

  it('fails safely to /login when the token is invalid or already consumed', async () => {
    const sb = makeSb({ otpError: { message: 'token has expired or is invalid' } })
    clientMock.mockReturnValue(sb)
    const res = await POST({
      formData: async () => form({ token_hash: 'spent', type: 'invite' }),
    } as never)
    expect(res.headers.get('location')).toContain('/login')
    expect(sb._s.rpc).not.toHaveBeenCalled()
  })

  it('rejects a wrong type without verifying anything', async () => {
    const sb = makeSb({})
    clientMock.mockReturnValue(sb)
    const res = await POST({
      formData: async () => form({ token_hash: 'abc', type: 'signup' }),
    } as never)
    expect(res.headers.get('location')).toContain('/login')
    expect(sb._s.verifyOtp).not.toHaveBeenCalled()
  })
})
