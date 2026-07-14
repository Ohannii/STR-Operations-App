import { describe, it, expect } from 'vitest'
import { isAuthenticatedFromClaims, resolveProxyRedirect } from '@/lib/auth/proxy-auth'

describe('isAuthenticatedFromClaims', () => {
  it('is true when verified claims carry a sub', () => {
    expect(isAuthenticatedFromClaims({ claims: { sub: 'user-1' } })).toBe(true)
  })

  it('is false for null / missing / sub-less claims (fail closed)', () => {
    expect(isAuthenticatedFromClaims(null)).toBe(false)
    expect(isAuthenticatedFromClaims(undefined)).toBe(false)
    expect(isAuthenticatedFromClaims({ claims: null })).toBe(false)
    expect(isAuthenticatedFromClaims({ claims: {} })).toBe(false)
  })
})

describe('resolveProxyRedirect', () => {
  it('sends an unauthenticated user off protected routes to /login with next', () => {
    expect(resolveProxyRedirect(false, '/dashboard')).toEqual({
      pathname: '/login',
      setNext: true,
    })
    expect(resolveProxyRedirect(false, '/properties/abc-123')).toEqual({
      pathname: '/login',
      setNext: true,
    })
    expect(resolveProxyRedirect(false, '/onboard')).toEqual({
      pathname: '/login',
      setNext: true,
    })
  })

  it('leaves an unauthenticated user on public / auth pages', () => {
    expect(resolveProxyRedirect(false, '/login')).toBeNull()
    expect(resolveProxyRedirect(false, '/signup')).toBeNull()
    expect(resolveProxyRedirect(false, '/')).toBeNull()
  })

  it('sends an authenticated user away from login/signup to /dashboard', () => {
    expect(resolveProxyRedirect(true, '/login')).toEqual({
      pathname: '/dashboard',
      setNext: false,
    })
    expect(resolveProxyRedirect(true, '/signup')).toEqual({
      pathname: '/dashboard',
      setNext: false,
    })
  })

  it('leaves an authenticated user on protected routes', () => {
    expect(resolveProxyRedirect(true, '/dashboard')).toBeNull()
    expect(resolveProxyRedirect(true, '/properties/abc-123')).toBeNull()
  })
})
