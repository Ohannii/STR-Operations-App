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
  updateError?: { message: string; code?: string } | null
  nameError?: { message: string } | null
  profileError?: { message: string } | null
  profile?: { id: string } | null
  claim?: string
  claimError?: { message: string } | null
}

function makeSupabase(o: Opts) {
  const rpc = vi.fn().mockResolvedValue({ data: o.claim ?? 'claimed', error: o.claimError ?? null })
  const maybeSingle = vi.fn().mockResolvedValue({
    data: o.profile === undefined ? { id: 'u1' } : o.profile,
    error: o.profileError ?? null,
  })
  const select = vi.fn(() => ({ maybeSingle }))
  const eq = vi.fn(() => ({ select }))
  const update = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ update }))
  const updateUser = vi.fn().mockResolvedValue({ error: o.nameError ?? null })
    .mockResolvedValueOnce({ error: o.updateError ?? null })
  const getUser = vi.fn().mockResolvedValue({ data: { user: o.user === undefined ? { id: 'u1' } : o.user } })
  return { auth: { getUser, updateUser }, from, rpc, _s: { rpc, from, update, eq, select, maybeSingle, updateUser, getUser } }
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

  it('resumes setup for the exact same_password code, including the rejected name metadata', async () => {
    const sb = makeSupabase({ updateError: { code: 'same_password', message: 'Already set' } })
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow('REDIRECT:/dashboard')
    expect(sb._s.updateUser.mock.calls).toEqual([
      [{ password: good.password, data: { full_name: good.full_name } }],
      [{ data: { full_name: good.full_name } }],
    ])
    expect(sb._s.update).toHaveBeenCalledWith({ full_name: good.full_name })
    expect(sb._s.eq).toHaveBeenCalledWith('id', 'u1')
    expect(sb._s.maybeSingle.mock.invocationCallOrder[0]).toBeLessThan(sb._s.rpc.mock.invocationCallOrder[0])
    expect(sb._s.rpc).toHaveBeenCalledExactlyOnceWith('claim_pending_invitation')
  })

  it.each([undefined, 'weak_password', 'session_not_found', 'request_timeout'])(
    'does not treat the same message with code %s as password confirmation', async (code) => {
      const sb = makeSupabase({ updateError: { code, message: 'New password should be different from the old password.' } })
      clientMock.mockReturnValue(sb)
      await expect(setInvitePasswordAction(form(good))).rejects.toThrow(/REDIRECT:\/invite\/set-password/)
      expect(sb._s.updateUser).toHaveBeenCalledTimes(1)
      expect(sb._s.from).not.toHaveBeenCalled()
      expect(sb._s.rpc).not.toHaveBeenCalled()
    },
  )

  it('does not save the profile or claim if the metadata retry fails', async () => {
    const sb = makeSupabase({
      updateError: { code: 'same_password', message: 'Already set' },
      nameError: { message: 'session expired' },
    })
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow(/REDIRECT:\/invite\/set-password/)
    expect(sb._s.from).not.toHaveBeenCalled()
    expect(sb._s.rpc).not.toHaveBeenCalled()
  })

  it.each([null, { id: 'somebody-else' }])('does not claim an absent or mismatched profile: %j', async (profile) => {
    const sb = makeSupabase({ profile })
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow(/REDIRECT:\/invite\/set-password/)
    expect(sb._s.rpc).not.toHaveBeenCalled()
  })

  it.each(['expired', 'revoked', 'conflict', 'no_invitation', 'unexpected'])('a same-password retry still refuses claim outcome %s', async (claim) => {
    const sb = makeSupabase({ updateError: { code: 'same_password', message: 'Already set' }, claim })
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow(/REDIRECT:\/invite\/set-password/)
    expect(sb._s.rpc).toHaveBeenCalledExactlyOnceWith('claim_pending_invitation')
  })

  it('requires an authenticated user even on a retry', async () => {
    const sb = makeSupabase({ user: null })
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow('REDIRECT:/login')
    expect(sb._s.updateUser).not.toHaveBeenCalled()
    expect(sb._s.from).not.toHaveBeenCalled()
    expect(sb._s.rpc).not.toHaveBeenCalled()
  })

  it('recovers after a password was saved but the profile write failed', async () => {
    const sb = makeSupabase({})
    let passwordSaved = false
    let passwordWrites = 0
    sb._s.updateUser.mockReset().mockImplementation(async (input) => {
      if (input.password) {
        if (passwordSaved) return { error: { code: 'same_password', message: 'Already set' } }
        passwordSaved = true
        passwordWrites++
      }
      return { error: null }
    })
    sb._s.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'temporary failure' } })
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow(/REDIRECT:\/invite\/set-password/)
    expect(passwordSaved).toBe(true)
    expect(sb._s.rpc).not.toHaveBeenCalled()

    await expect(setInvitePasswordAction(form(good))).rejects.toThrow('REDIRECT:/dashboard')
    expect(passwordWrites).toBe(1)
    expect(sb._s.rpc).toHaveBeenCalledExactlyOnceWith('claim_pending_invitation')
  })

  it('recovers from a failed claim without requiring another password', async () => {
    const sb = makeSupabase({})
    sb._s.updateUser.mockReset()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: 'same_password', message: 'Already set' } })
      .mockResolvedValueOnce({ error: null })
    sb._s.rpc.mockResolvedValueOnce({ data: null, error: { message: 'temporary failure' } })
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow(/REDIRECT:\/invite\/set-password/)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow('REDIRECT:/dashboard')
    expect(sb._s.rpc).toHaveBeenCalledTimes(2)
  })

  it('converges after a successful claim whose response was lost', async () => {
    const sb = makeSupabase({})
    sb._s.updateUser.mockReset()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: 'same_password', message: 'Already set' } })
      .mockResolvedValueOnce({ error: null })
    let active = false
    let activations = 0
    sb._s.rpc.mockImplementation(async () => {
      if (active) return { data: 'already_member', error: null }
      active = true
      activations++
      throw new Error('Response lost after commit')
    })
    clientMock.mockReturnValue(sb)
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow('Response lost after commit')
    await expect(setInvitePasswordAction(form(good))).rejects.toThrow('REDIRECT:/dashboard')
    expect(activations).toBe(1)
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
