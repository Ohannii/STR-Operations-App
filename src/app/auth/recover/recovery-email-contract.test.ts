import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Recovery email URL contract - mirrors the invite contract. The reset link
 * must route through the prefetch-safe /auth/recover interstitial via
 * {{ .RedirectTo }}, never {{ .SiteURL }} / {{ .ConfirmationURL }}.
 */
const root = process.cwd()
const template = readFileSync(resolve(root, 'supabase/templates/recovery.html'), 'utf8')
const action = readFileSync(resolve(root, 'src/app/forgot-password/actions.ts'), 'utf8')

describe('recovery email URL contract', () => {
  it('the template links via RedirectTo with type=recovery', () => {
    expect(template).toContain('{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery')
  })

  it('the template uses neither SiteURL nor ConfirmationURL variables', () => {
    expect(template).not.toContain('{{ .SiteURL }}')
    expect(template).not.toContain('{{ .ConfirmationURL }}')
  })

  it('the request action derives the redirect from the trusted app URL', () => {
    expect(action).toContain("trustedAppUrl('/auth/recover')")
    expect(action).toContain('resetPasswordForEmail')
  })
})
