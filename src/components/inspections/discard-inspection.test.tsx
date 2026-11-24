// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/app/properties/[id]/packs/actions', () => ({ discardEvidencePackAction: vi.fn() }))
vi.mock('@/lib/photos/photo-queue', () => ({ usePackQueue: vi.fn() }))
import { DiscardDraftButton } from '@/components/photos/pack-submit-button'
let root: Root | undefined, host: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host) })
afterEach(async () => { if (root) await act(async () => { root!.unmount() }); root = undefined; host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('inspection draft discard safety', () => {
  it('server markup keeps discard disclosed and disabled until its confirmation handler is installed', () => {
    host.innerHTML = renderToStaticMarkup(<DiscardDraftButton propertyId="property" packId="pack" scheduled />)
    expect(host.querySelector('details')?.open).toBe(false)
    expect(host.querySelector('summary')?.textContent).toBe('More inspection options')
    expect(host.querySelector('button')?.disabled).toBe(true)
  })
  it('rejecting confirmation prevents submission and explains scheduled recovery for the exact apartment', async () => {
    const confirm = vi.fn<(message?: string) => boolean>().mockReturnValue(false)
    vi.stubGlobal('confirm', confirm)
    root = createRoot(host)
    await act(async () => { root!.render(<DiscardDraftButton propertyId="property" packId="pack" scheduled propertyName="Ballito Life · Unit 91" />) })
    expect(host.querySelector('button')?.disabled).toBe(false)
    const event = new Event('submit', { bubbles: true, cancelable: true })
    await act(async () => { host.querySelector('form')!.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0]).toContain('Ballito Life · Unit 91')
    expect(confirm.mock.calls[0][0]).toContain('scheduled inspection will stay open')
    expect(confirm.mock.calls[0][0]).toContain('A manager must cancel')
  })
})
