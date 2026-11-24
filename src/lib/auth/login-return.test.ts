import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loginReturnPath } from './login-return'
const signIn = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { signInWithPassword: signIn } }) }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw Error(`redirect:${url}`) } }))
import { loginAction } from '@/app/login/actions'
beforeEach(() => { signIn.mockResolvedValue({ error: null }) })
describe('login returns to inspection work safely', () => {
  it.each(['/dashboard/work?scope=all&property=unit', '/properties/unit?tab=inspection', '/properties/unit/packs/pack/report'])('preserves %s', path => {
    expect(loginReturnPath(path)).toBe(path)
  })
  it.each(['//evil.invalid', '/\\evil.invalid', 'https://evil.invalid', '/%2f%2fevil.invalid', '/dashboard/../../auth/signout', '/auth/signout', '/login', '/dashboard%0aLocation:evil', '/dashboard/%zz', null, ['a', 'b']])('refuses unsafe next value %s', path => {
    expect(loginReturnPath(path)).toBe('/dashboard')
  })
  it('honours the return path after password login and keeps it after a failed login', async () => {
    const data = new FormData(); data.set('email', 'fixture@example.invalid'); data.set('password', 'fixture-only'); data.set('next', '/dashboard/work?scope=all')
    await expect(loginAction(data)).rejects.toThrow('redirect:/dashboard/work?scope=all')
    signIn.mockResolvedValueOnce({ error: { message: 'Try again' } })
    await expect(loginAction(data)).rejects.toThrow('next=%2Fdashboard%2Fwork%3Fscope%3Dall')
  })
})
