import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Behavioural tests (mocked Supabase) for /auth/recover.
 * GET must be a prefetch-safe interstitial (no client, no verify, no updateUser).
 * POST must verify a RECOVERY token and never change the password itself.
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

function makeSb(o: { otpError?: { message: string } | null }) {
  const verifyOtp = vi.fn().mockResolvedValue({ error: o.otpError ?? null })
  const updateUser = vi.fn()
  const rpc = vi.fn()
  return { auth: { verifyOtp, updateUser }, rpc, _s: { verifyOtp, updateUser, rpc } }
}
function form(fields: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

describe('GET /auth/recover (prefetch-safe interstitial)', () => {
  it('renders an HTML POST form and touches no Supabase client', async () => {
    const res = await GET({
      url: 'https://app.example.com/auth/recover?token_hash=abc&type=recovery',
    } as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('method="POST"')
    expect(body).toContain('value="recovery"')
    expect(body).toContain('abc')
    expect(clientMock).not.toHaveBeenCalled()
  })

  it('fails safely to /login on a missing/invalid token', async () => {
    const res = await GET({ url: 'https://app.example.com/auth/recover' } as never)
    expect(res.headers.get('location')).toContain('/login')
    expect(clientMock).not.toHaveBeenCalled()
  })
})

describe('POST /auth/recover (verify recovery only)', () => {
  it('verifies the recovery token and routes to reset-password; never updates the password', async () => {
    const sb = makeSb({})
    clientMock.mockReturnValue(sb)
    const res = await POST({
      formData: async () => form({ token_hash: 'abc', type: 'recovery' }),
    } as never)
    expect(sb._s.verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: 'abc' })
    expect(sb._s.updateUser).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toContain('/reset-password')
  })

  it('fails safely to /login when the recovery token is invalid or consumed', async () => {
    const sb = makeSb({ otpError: { message: 'token is invalid or has expired' } })
    clientMock.mockReturnValue(sb)
    const res = await POST({
      formData: async () => form({ token_hash: 'spent', type: 'recovery' }),
    } as never)
    expect(res.headers.get('location')).toContain('/login')
  })

  it('rejects a wrong type without verifying', async () => {
    const sb = makeSb({})
    clientMock.mockReturnValue(sb)
    const res = await POST({
      formData: async () => form({ token_hash: 'abc', type: 'invite' }),
    } as never)
    expect(res.headers.get('location')).toContain('/login')
    expect(sb._s.verifyOtp).not.toHaveBeenCalled()
  })
})
