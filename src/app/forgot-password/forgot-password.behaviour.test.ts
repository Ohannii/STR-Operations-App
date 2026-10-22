import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Behavioural tests (mocked Supabase) for the password-reset request.
 * It must call resetPasswordForEmail with the trusted /auth/recover redirect
 * and ALWAYS return the same neutral response - never revealing whether the
 * account exists.
 */
const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (u: string) => redirectMock(u) }))

const clientMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => clientMock() }))

import { requestPasswordResetAction } from './actions'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example.com'
})
beforeEach(() => {
  redirectMock.mockClear()
  clientMock.mockReset()
})

function makeSb(o: { error?: { message: string } | null }) {
  const resetPasswordForEmail = vi.fn().mockResolvedValue({ data: {}, error: o.error ?? null })
  return { auth: { resetPasswordForEmail }, _s: { resetPasswordForEmail } }
}
function form(fields: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

describe('requestPasswordResetAction', () => {
  it('calls resetPasswordForEmail with the trusted /auth/recover redirect, then neutral confirm', async () => {
    const sb = makeSb({})
    clientMock.mockReturnValue(sb)
    await expect(requestPasswordResetAction(form({ email: 'A@Example.com' }))).rejects.toThrow(
      'REDIRECT:/forgot-password?sent=1',
    )
    expect(sb._s.resetPasswordForEmail).toHaveBeenCalledWith('a@example.com', {
      redirectTo: 'https://app.example.com/auth/recover',
    })
  })

  it('gives the SAME neutral response when the SDK reports no such user', async () => {
    const sb = makeSb({ error: { message: 'user not found' } })
    clientMock.mockReturnValue(sb)
    await expect(requestPasswordResetAction(form({ email: 'ghost@example.com' }))).rejects.toThrow(
      'REDIRECT:/forgot-password?sent=1',
    )
  })

  it('does not call the SDK for an obviously invalid email but still responds neutrally', async () => {
    const sb = makeSb({})
    clientMock.mockReturnValue(sb)
    await expect(requestPasswordResetAction(form({ email: 'notanemail' }))).rejects.toThrow(
      'REDIRECT:/forgot-password?sent=1',
    )
    expect(sb._s.resetPasswordForEmail).not.toHaveBeenCalled()
  })
})
