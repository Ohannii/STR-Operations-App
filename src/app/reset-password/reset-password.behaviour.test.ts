import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Behavioural tests (mocked Supabase) for the recovery set-password action.
 * It must set the password (and optionally the name) for the AUTHENTICATED
 * recovery user, NEVER claim an invitation, and short-circuit on failure.
 */
const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (u: string) => redirectMock(u) }))

const clientMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => clientMock() }))

import { setRecoveryPasswordAction } from './actions'

function makeSb(o: {
  user?: { id: string } | null
  updateError?: { message: string } | null
  profileError?: { message: string } | null
}) {
  const rpc = vi.fn()
  const eq = vi.fn().mockResolvedValue({ error: o.profileError ?? null })
  const update = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ update }))
  const updateUser = vi.fn().mockResolvedValue({ error: o.updateError ?? null })
  const getUser = vi.fn().mockResolvedValue({ data: { user: o.user === undefined ? { id: 'u1' } : o.user } })
  return { auth: { getUser, updateUser }, from, rpc, _s: { rpc, from, update, eq, updateUser, getUser } }
}
function form(fields: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

beforeEach(() => {
  redirectMock.mockClear()
  clientMock.mockReset()
})

describe('setRecoveryPasswordAction', () => {
  it('with a name: updates password + profile, never claims, -> dashboard', async () => {
    const sb = makeSb({})
    clientMock.mockReturnValue(sb)
    await expect(
      setRecoveryPasswordAction(form({ full_name: 'Jo Smith', password: 'abcd1234', confirm: 'abcd1234' })),
    ).rejects.toThrow('REDIRECT:/dashboard')
    expect(sb._s.updateUser).toHaveBeenCalledWith({ password: 'abcd1234', data: { full_name: 'Jo Smith' } })
    expect(sb._s.eq).toHaveBeenCalled()
    expect(sb._s.rpc).not.toHaveBeenCalled()
  })

  it('without a name: sets password only, no profile write, -> dashboard', async () => {
    const sb = makeSb({})
    clientMock.mockReturnValue(sb)
    await expect(
      setRecoveryPasswordAction(form({ full_name: '', password: 'abcd1234', confirm: 'abcd1234' })),
    ).rejects.toThrow('REDIRECT:/dashboard')
    expect(sb._s.updateUser).toHaveBeenCalledWith({ password: 'abcd1234' })
    expect(sb._s.from).not.toHaveBeenCalled()
    expect(sb._s.rpc).not.toHaveBeenCalled()
  })

  it('a password mismatch stops before any Supabase call', async () => {
    const sb = makeSb({})
    clientMock.mockReturnValue(sb)
    await expect(
      setRecoveryPasswordAction(form({ full_name: '', password: 'abcd1234', confirm: 'nope5678' })),
    ).rejects.toThrow(/REDIRECT:\/reset-password/)
    expect(sb._s.getUser).not.toHaveBeenCalled()
  })

  it('a failed password update stops before the profile write', async () => {
    const sb = makeSb({ updateError: { message: 'weak password' } })
    clientMock.mockReturnValue(sb)
    await expect(
      setRecoveryPasswordAction(form({ full_name: 'Jo', password: 'abcd1234', confirm: 'abcd1234' })),
    ).rejects.toThrow(/REDIRECT:\/reset-password/)
    expect(sb._s.from).not.toHaveBeenCalled()
    expect(sb._s.rpc).not.toHaveBeenCalled()
  })

  it('no recovery session -> /login', async () => {
    const sb = makeSb({ user: null })
    clientMock.mockReturnValue(sb)
    await expect(
      setRecoveryPasswordAction(form({ full_name: '', password: 'abcd1234', confirm: 'abcd1234' })),
    ).rejects.toThrow(/REDIRECT:\/login/)
    expect(sb._s.updateUser).not.toHaveBeenCalled()
  })
})
