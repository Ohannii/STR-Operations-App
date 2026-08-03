import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { trustedAppUrl } from './app-url'

/**
 * Invite-email URL contract (PR #59 correction). Proves the SSR acceptance
 * link is trusted, uses the per-call {{ .RedirectTo }}, and never duplicates
 * /auth/confirm. See docs/TEAM_INVITE_EMAIL_CONTRACT.md.
 */
const root = process.cwd()
const template = readFileSync(resolve(root, 'supabase/templates/invite.html'), 'utf8')
const actionSrc = readFileSync(
  resolve(root, 'src/app/dashboard/team/actions.ts'),
  'utf8',
)

describe('invite email URL contract', () => {
  const origin = 'https://app.drop-inn.co.za'
  const redirectTo = trustedAppUrl('/auth/confirm', origin)

  it('1. the action sends the trusted configured callback ending in /auth/confirm', () => {
    expect(redirectTo).toBe(`${origin}/auth/confirm`)
    expect(redirectTo?.endsWith('/auth/confirm')).toBe(true)
    // The action derives redirectTo from trustedAppUrl('/auth/confirm') and
    // passes it as the invite redirect.
    expect(actionSrc).toContain("trustedAppUrl('/auth/confirm')")
    expect(actionSrc).toMatch(/inviteUserByEmail\(email,\s*\{\s*redirectTo:\s*inviteRedirectTo/)
  })

  it('2. the template uses {{ .RedirectTo }}', () => {
    expect(template).toContain('{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite')
  })

  it('3. the template uses neither {{ .SiteURL }} nor {{ .ConfirmationURL }}', () => {
    expect(template).not.toContain('{{ .SiteURL }}')
    expect(template).not.toContain('{{ .ConfirmationURL }}')
  })

  it('4. /auth/confirm is not duplicated in the resulting href', () => {
    // The template must not carry its own /auth/confirm (redirectTo already has it).
    const href = template.match(/href="([^"]+)"/)?.[1] ?? ''
    expect(href).toBe('{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite')
    const resolved = href.replace('{{ .RedirectTo }}', redirectTo ?? '')
    expect(resolved.match(/\/auth\/confirm/g)?.length).toBe(1)
    expect(resolved).not.toContain('/auth/confirm/auth/confirm')
  })

  it('5. a missing/invalid trusted app URL fails closed before any email is sent', () => {
    expect(trustedAppUrl('/auth/confirm', undefined)).toBeNull()
    expect(trustedAppUrl('/auth/confirm', 'not-a-url')).toBeNull()
    // The guard returns site_url_missing BEFORE the inviteUserByEmail call.
    const guardAt = actionSrc.indexOf("code: 'site_url_missing'")
    const inviteAt = actionSrc.indexOf('inviteUserByEmail(email, {')
    expect(guardAt).toBeGreaterThan(-1)
    expect(inviteAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(inviteAt)
  })
})
