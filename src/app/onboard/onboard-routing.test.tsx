import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const mocks = vi.hoisted(() => ({ context: vi.fn(), rpc: vi.fn(), createCompany: vi.fn() }))
vi.mock('@/lib/auth/get-user-context', () => ({ getUserContext: mocks.context }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ rpc: mocks.rpc }) }))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))
vi.mock('./actions', () => ({ createCompanyAction: mocks.createCompany }))
import OnboardPage from './page'
const page = () => OnboardPage({ searchParams: Promise.resolve({}) })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.context.mockResolvedValue({ company: null, profile: { full_name: 'Test Person' }, user: { email: 'test@example.com' } })
  mocks.rpc.mockResolvedValue({ data: 'none', error: null })
})

describe('invited staff onboarding', () => {
  it('sends a signed-in pending invitee to setup without activating membership', async () => {
    mocks.rpc.mockResolvedValue({ data: 'pending', error: null })
    await expect(page()).rejects.toThrow('redirect:/invite/set-password')
    expect(mocks.rpc.mock.calls).toEqual([['get_my_invitation_setup_status']])
    expect(mocks.createCompany).not.toHaveBeenCalled()
  })
  it('sends an active member straight to their dashboard without invitation reads', async () => {
    mocks.context.mockResolvedValue({ company: { id: 'co' } })
    await expect(page()).rejects.toThrow('redirect:/dashboard')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('requires authentication', async () => {
    mocks.context.mockResolvedValue(null)
    await expect(page()).rejects.toThrow('redirect:/login')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it.each(['expired', 'revoked', 'accepted', 'unknown', null])('does not show company creation for invitation state %s', async data => {
    mocks.rpc.mockResolvedValue({ data, error: null })
    const html = renderToStaticMarkup(await page())
    expect(html).toContain('Join your team')
    expect(html).not.toContain('Create company')
    expect(mocks.createCompany).not.toHaveBeenCalled()
  })
  it('fails closed when invitation lookup fails and exposes no raw error', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'private database details' } })
    const html = renderToStaticMarkup(await page())
    expect(html).toContain('We could not check your team invitation')
    expect(html).not.toContain('Create company')
    expect(html).not.toContain('private database details')
  })
  it('keeps legitimate company setup available without the approval-policy blurb', async () => {
    const html = renderToStaticMarkup(await page())
    expect(html).toContain('Create company')
    for (const removed of ['R1,000', 'R2,000', 'R60,000', 'approval policy', 'South African default']) expect(html).not.toContain(removed)
  })
})
