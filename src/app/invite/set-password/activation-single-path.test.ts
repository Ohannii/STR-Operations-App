import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Regression for the PR #60 field failure: membership went active from a mere
 * authenticated session (via /onboard's claim) before password/profile setup.
 * Contract: claim_pending_invitation (the only thing that activates a
 * membership from an invite) may be called ONLY from the invite set-password
 * action, and ONLY after the password + profile writes.
 */
const root = process.cwd()
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

const setPw = read('src/app/invite/set-password/actions.ts')
const onboardPage = read('src/app/onboard/page.tsx')
const onboardAction = read('src/app/onboard/actions.ts')
const confirmRoute = read('src/app/auth/confirm/route.ts')

describe('invite membership activation is a single gated path', () => {
  it('the set-password action is the ONLY caller of claim_pending_invitation', () => {
    expect(setPw).toContain('claim_pending_invitation')
    expect(onboardPage).not.toContain('claim_pending_invitation')
    expect(onboardAction).not.toContain('claim_pending_invitation')
    expect(confirmRoute).not.toContain('claim_pending_invitation')
  })

  it('claims ONLY after the password update and the profile write', () => {
    const claimAt = setPw.indexOf('claim_pending_invitation')
    expect(claimAt).toBeGreaterThan(-1)
    expect(setPw.indexOf('updateUser')).toBeLessThan(claimAt)
    expect(setPw.indexOf(".from('profiles')")).toBeLessThan(claimAt)
  })

  it('does not leak a raw DB error into the redirect URL (safe message + server log)', () => {
    expect(setPw).not.toContain('fail(profileError.message)')
    expect(setPw).toContain('console.error')
  })
})
