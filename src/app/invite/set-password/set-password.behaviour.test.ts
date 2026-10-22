import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Behavioural tests (mocked Supabase) for the invite set-password action.
 * Proves acceptance (claim) happens ONLY after name+password+profile succeed,
 * and never on a partial failure - the core of the anni@drop-inn.co.za fix.
 */

// redirect() throws in Next; model that so we can assert the destination.
const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (u: string) => redirectMock(u) }))

const clientMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => clientMock() }))

import { setInvitePasswordAction } from './actions'

type Opts = {
  user?: { id: string } | null
  updateError?: { message: string } | null
  profileError?: { message: string } | null
  claim?: string
  claimError?: { message: string } | null
}

function makeSupabase(o: Opts) {
  const rpc = vi.fn().mockResolvedValue({ data: o.claim ?? 'claimed', error: o.claimError ?? null })
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

const good = { full_name: 'Jo Smith', password: 'abcd1234', confirm: 'abcd1234' }

beforeEach(() => {
  redirectMock.mockClear()
  clientMock.mockReset()
})

describe('setInvitePasswordAction', () => {
  it('claims exactly once and only after password + profile succeed', async () => {
    const sb = makeSupabase({})
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow('REDIRECT:/dashboard')
    expect(sb._s.updateUser).toHaveBeenCalledTimes(1)
    expect(sb._s.rpc).toHaveBeenCalledTimes(1)
    expect(sb._s.rpc).toHaveBeenCalledWith('claim_pending_invitation')
    // claim must be the LAST supabase call (after updateUser + profile update)
    expect(sb._s.updateUser.mock.invocationCallOrder[0]).toBeLessThan(
      sb._s.rpc.mock.invocationCallOrder[0],
    )
    expect(sb._s.eq.mock.invocationCallOrder[0]).toBeLessThan(
      sb._s.rpc.mock.invocationCallOrder[0],
    )
  })

  it('does NOT claim when the password update fails', async () => {
    const sb = makeSupabase({ updateError: { message: 'weak' } })
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow(/REDIRECT:\/invite\/set-password/)
    expect(sb._s.rpc).not.toHaveBeenCalled()
  })

  it('does NOT claim when the profile update fails', async () => {
    const sb = makeSupabase({ profileError: { message: 'rls' } })
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow(/REDIRECT:\/invite\/set-password/)
    expect(sb._s.rpc).not.toHaveBeenCalled()
  })

  it('rejects a missing name before touching Supabase at all', async () => {
    const sb = makeSupabase({})
    clientMock.mockReturnValue(sb)
    await expect(
      setInvitePasswordAction(form({ ...good, full_name: '   ' })),
    ).rejects.toThrow(/REDIRECT:\/invite\/set-password/)
    expect(sb._s.getUser).not.toHaveBeenCalled()
    expect(sb._s.updateUser).not.toHaveBeenCalled()
    expect(sb._s.rpc).not.toHaveBeenCalled()
  })

  it('surfaces a conflict from the claim without granting membership silently', async () => {
    const sb = makeSupabase({ claim: 'conflict' })
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow(/REDIRECT:\/invite\/set-password/)
    expect(sb._s.rpc).toHaveBeenCalledTimes(1)
  })
})
