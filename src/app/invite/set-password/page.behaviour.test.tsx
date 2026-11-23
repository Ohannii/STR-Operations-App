import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { context } = vi.hoisted(() => ({ context: vi.fn() }))
vi.stubGlobal('React', React)
vi.mock('@/lib/auth/get-user-context', () => ({ getUserContext: context }))
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`) } }))
vi.mock('./actions', () => ({ setInvitePasswordAction: vi.fn() }))

import SetPasswordPage from './page'

beforeEach(() => context.mockReset())

describe('invitation setup page recovery', () => {
  it('sends an active member with a stale setup URL straight to the dashboard', async () => {
    context.mockResolvedValue({ company: { id: 'company' }, membership: { role_key: 'company_admin' } })
    await expect(SetPasswordPage({ searchParams: Promise.resolve({ error: 'same password' }) }))
      .rejects.toThrow('REDIRECT:/dashboard')
  })

  it('requires sign-in if the invite session is missing', async () => {
    context.mockResolvedValue(null)
    await expect(SetPasswordPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT:/login')
  })

  it('keeps pending users in setup and prefills their saved name', async () => {
    context.mockResolvedValue({ company: null, membership: null, profile: { full_name: 'Test Inspector' } })
    const html = renderToStaticMarkup(await SetPasswordPage({ searchParams: Promise.resolve({}) }))
    expect(html).toContain('Set your password')
    expect(html).toContain('value="Test Inspector"')
    expect(html).toContain('name="password"')
    expect(html).toContain('Save password and continue')
  })

  it('does not bypass setup from a membership without a visible company', async () => {
    context.mockResolvedValue({ company: null, membership: { role_key: 'company_admin' }, profile: null })
    const html = renderToStaticMarkup(await SetPasswordPage({ searchParams: Promise.resolve({}) }))
    expect(html).toContain('Set your password')
  })
})
