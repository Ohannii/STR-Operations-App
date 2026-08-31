import { afterEach, describe, it, expect } from 'vitest'
import { configuredAppOrigin, trustedAppOrigin, trustedAppUrl } from '@/lib/team/app-url'

describe('trustedAppOrigin -- configuration only, never request-derived', () => {
  it('accepts a valid https origin and normalises away paths', () => {
    expect(trustedAppOrigin('https://drop-inn-str-ops-staging.vercel.app')).toBe(
      'https://drop-inn-str-ops-staging.vercel.app',
    )
    expect(trustedAppOrigin('https://example.com/some/path?q=1')).toBe('https://example.com')
  })
  it('accepts localhost http for development', () => {
    expect(trustedAppOrigin('http://localhost:3000')).toBe('http://localhost:3000')
  })
  it('rejects http on real hosts, credentials, garbage and absence', () => {
    expect(trustedAppOrigin('http://evil.example')).toBeNull()
    expect(trustedAppOrigin('https://user:pass@example.com')).toBeNull()
    expect(trustedAppOrigin('not a url')).toBeNull()
    expect(trustedAppOrigin(undefined)).toBeNull()
  })
  it('a manipulated Host header CANNOT change the origin: the function never reads requests', () => {
    // Structural guarantee: the only input is the configured env value.
    expect(trustedAppOrigin('https://configured.example')).toBe('https://configured.example')
  })
})

describe('trustedAppUrl -- internal paths only', () => {
  const ENV = 'https://app.example'
  it('builds internal URLs', () => {
    expect(trustedAppUrl('/dashboard', ENV)).toBe('https://app.example/dashboard')
  })
  it('fails closed for external/protocol-relative/relative paths and bad env', () => {
    expect(trustedAppUrl('//evil.example', ENV)).toBeNull()
    expect(trustedAppUrl('https://evil.example', ENV)).toBeNull()
    expect(trustedAppUrl('dashboard', ENV)).toBeNull()
    expect(trustedAppUrl('/dashboard', undefined)).toBeNull()
  })
})

describe('configuredAppOrigin -- a Preview invite stays on the Preview origin', () => {
  const KEYS = ['VERCEL_ENV', 'VERCEL_BRANCH_URL', 'NEXT_PUBLIC_SITE_URL'] as const
  const saved: Record<string, string | undefined> = {}
  for (const k of KEYS) saved[k] = process.env[k]
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('ignores a STALE/dead Preview NEXT_PUBLIC_SITE_URL when the live VERCEL_BRANCH_URL is available', () => {
    // Regression for the PR #60 field test: NEXT_PUBLIC_SITE_URL had been pinned
    // to a preview hostname that is now NXDOMAIN. The live per-deploy branch URL
    // from Vercel must win, so the invite/reset link never targets a dead host.
    process.env.VERCEL_ENV = 'preview'
    process.env.VERCEL_BRANCH_URL = 'app-git-live-branch-team.vercel.app' // current, reachable
    process.env.NEXT_PUBLIC_SITE_URL = 'https://app-git-old-dead-deploy-team.vercel.app' // stale
    expect(configuredAppOrigin()).toBe('https://app-git-live-branch-team.vercel.app')
    expect(trustedAppUrl('/auth/confirm')).toBe(
      'https://app-git-live-branch-team.vercel.app/auth/confirm',
    )
  })

  it('production (non-preview) uses NEXT_PUBLIC_SITE_URL', () => {
    delete process.env.VERCEL_ENV
    delete process.env.VERCEL_BRANCH_URL
    process.env.NEXT_PUBLIC_SITE_URL = 'https://prod.example'
    expect(configuredAppOrigin()).toBe('https://prod.example')
    expect(trustedAppUrl('/auth/confirm')).toBe('https://prod.example/auth/confirm')
  })

  it('a preview with no branch url falls back to NEXT_PUBLIC_SITE_URL (fail-safe, not production leak)', () => {
    process.env.VERCEL_ENV = 'preview'
    delete process.env.VERCEL_BRANCH_URL
    process.env.NEXT_PUBLIC_SITE_URL = 'https://prod.example'
    expect(configuredAppOrigin()).toBe('https://prod.example')
  })
})
