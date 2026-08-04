import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Regression: the anni@drop-inn.co.za production failure. The invite
 * /auth/confirm GET used to run verifyOtp + claim_pending_invitation, so an
 * email-scanner prefetch (a GET) consumed the token and created an active
 * membership with no human setup. These source-level checks pin the fixed
 * contract without a full Supabase integration harness.
 */
const root = process.cwd()
const confirm = readFileSync(resolve(root, 'src/app/auth/confirm/route.ts'), 'utf8')
const setPw = readFileSync(resolve(root, 'src/app/invite/set-password/actions.ts'), 'utf8')

const getSlice = confirm.slice(
  confirm.indexOf('export async function GET'),
  confirm.indexOf('export async function POST'),
)
const postSlice = confirm.slice(confirm.indexOf('export async function POST'))

describe('invite confirm is prefetch-safe', () => {
  it('exposes a GET interstitial and a POST handler', () => {
    expect(confirm).toMatch(/export async function GET\s*\(/)
    expect(confirm).toMatch(/export async function POST\s*\(/)
  })

  it('a scanner-style GET consumes nothing: no verifyOtp, no claim', () => {
    expect(getSlice).not.toContain('verifyOtp')
    expect(getSlice).not.toContain('claim_pending_invitation')
    // it renders an HTML form that a human must POST
    expect(getSlice).toContain('text/html')
    expect(getSlice).toContain('method="POST"')
  })

  it('only the POST verifies the token, and it still does not claim', () => {
    expect(postSlice).toContain('verifyOtp')
    expect(postSlice).not.toContain('claim_pending_invitation')
  })

  it('the confirm route never claims membership (claim is deferred to setup)', () => {
    expect(confirm).not.toContain('claim_pending_invitation')
  })

  it('membership is claimed only in the set-password action, after password setup', () => {
    expect(setPw).toContain('claim_pending_invitation')
    const claimAt = setPw.indexOf('claim_pending_invitation')
    const pwAt = setPw.indexOf('updateUser')
    expect(pwAt).toBeGreaterThan(-1)
    expect(claimAt).toBeGreaterThan(pwAt)
  })
})
