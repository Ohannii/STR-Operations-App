import { describe, it, expect } from 'vitest'
import { trustedAppOrigin, trustedAppUrl } from '@/lib/team/app-url'

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
