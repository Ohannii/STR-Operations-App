// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ connectHostaway: vi.fn(), disconnectHostaway: vi.fn(), loadHostawayListings: vi.fn(), loadHostawayUnits: vi.fn(), saveHostawayMapping: vi.fn() }))
vi.mock('./actions', () => api)
import { PmsSetupForm } from './setup-form'
import type { PmsResult, PmsSetup } from '@/lib/pms/setup-types'
let root: Root, host: HTMLDivElement
const setup: PmsSetup = {
  connection: { id: 'connection', account_id: '123', provider: 'hostaway', status: 'connected', credential_expires_at: '2099-01-01T00:00:00Z', revision: 2 }, mappings: [],
  properties: [{ id: 'bl-91', name: 'Unit 91', address: 'Ballito Life', unit_reference: null }, { id: 'bv-91', name: 'Unit 91', address: 'Ballito Village', unit_reference: null }],
}
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!
async function click(label: string) { await act(async () => { button(label).click() }) }
async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
async function render(initial: PmsResult<PmsSetup> = { ok: true, data: setup }) { await act(async () => { root.render(<PmsSetupForm initial={initial} />) }) }
async function chooseListing() {
  await click('Load Hostaway listings')
  await change(host.querySelector('select')!, '91')
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  api.connectHostaway.mockResolvedValue({ ok: true, data: setup })
  api.disconnectHostaway.mockResolvedValue({ ok: true, data: { ...setup, connection: { ...setup.connection, status: 'disconnected', credential_expires_at: null, revision: 3 } } })
  api.loadHostawayListings.mockResolvedValue({ ok: true, data: [{ id: '91', name: 'Hostaway listing 91', timeZone: 'Africa/Johannesburg' }] })
  api.loadHostawayUnits.mockResolvedValue({ ok: true, data: [] })
  api.saveHostawayMapping.mockResolvedValue({ ok: true, data: setup })
})
afterEach(async () => { await act(async () => { root.unmount() }); host.remove(); vi.unstubAllGlobals() })
describe('Admin connection setup interactions', () => {
  it('blocks credential entry when the database is not deployed', async () => {
    await render({ ok: false, code: 'database_pending', error: 'Database update pending.' })
    expect(host.querySelectorAll('fieldset')[0].disabled).toBe(true)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('pending')
    expect(api.connectHostaway).not.toHaveBeenCalled()
  })
  it('freezes the form, prevents double submissions and clears the key only after confirmed success', async () => {
    await render()
    const key = host.querySelector<HTMLInputElement>('[name="apiKey"]')!
    await change(key, 'ephemeral-fixture-key')
    let finish!: (result: PmsResult<PmsSetup>) => void
    api.connectHostaway.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(api.connectHostaway).toHaveBeenCalledExactlyOnceWith({ accountId: '123', apiKey: 'ephemeral-fixture-key', revision: 2 })
    expect(host.querySelector('fieldset')!.disabled).toBe(true); expect(key.value).toBe('ephemeral-fixture-key')
    await act(async () => { finish({ ok: true, data: setup }) })
    expect(key.value).toBe(''); expect(host.querySelector('fieldset')!.disabled).toBe(false)
    expect(host.textContent).toContain('Checkout syncing is not enabled yet')
  })
  it('keeps entries after a refused save and offers an honest message after a lost response', async () => {
    await render(); const key = host.querySelector<HTMLInputElement>('[name="apiKey"]')!
    await change(key, 'keep-my-entry')
    api.connectHostaway.mockResolvedValueOnce({ ok: false, error: 'Check your API details.' })
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(key.value).toBe('keep-my-entry'); expect(host.textContent).toContain('Check your API details')
    api.connectHostaway.mockRejectedValueOnce(Error('private-provider-body'))
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Reload this page before retrying')
    expect(host.textContent).not.toContain('private-provider-body'); expect(key.value).toBe('keep-my-entry')
  })
  it('requires a physical-listing check and keeps duplicate unit numbers visually distinct', async () => {
    await render(); await chooseListing()
    expect(button('Save apartment match')).toBeUndefined()
    await act(async () => { host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click() })
    const target = host.querySelectorAll('select')[1]
    expect(target.textContent).toContain('Ballito Life · Unit 91'); expect(target.textContent).toContain('Ballito Village · Unit 91')
    await change(target, 'bv-91'); await click('Save apartment match')
    expect(api.saveHostawayMapping).toHaveBeenCalledExactlyOnceWith({ listingId: '91', unitId: '0', propertyId: 'bv-91', connectionRevision: 2, mappingRevision: 0, physicalListingConfirmed: true })
  })
  it('requires a specific subunit and does not offer the parent as an apartment', async () => {
    api.loadHostawayUnits.mockResolvedValueOnce({ ok: true, data: [{ id: '7', name: 'Physical unit 91' }] })
    await render(); await chooseListing()
    expect(host.querySelector('[type="checkbox"]')).toBeNull(); expect(button('Save apartment match')).toBeUndefined()
    await change(host.querySelectorAll('select')[1], '7')
    await change(host.querySelectorAll('select')[2], 'bl-91')
    await click('Save apartment match')
    expect(api.saveHostawayMapping).toHaveBeenCalledWith(expect.objectContaining({ unitId: '7', propertyId: 'bl-91', physicalListingConfirmed: false }))
  })
  it('failed subunit discovery cannot be mistaken for a listing with no subunits', async () => {
    api.loadHostawayUnits.mockResolvedValueOnce({ ok: false, error: 'Hostaway unavailable.' })
    await render(); await chooseListing()
    expect(host.querySelector('[type="checkbox"]')).toBeNull(); expect(button('Save apartment match')).toBeUndefined()
    expect(button('Retry loading physical units')).toBeDefined()
    await click('Retry loading physical units')
    expect(host.querySelector('[type="checkbox"]')).not.toBeNull()
  })
  it('requires an explicit disconnect confirmation and supports keeping the connection', async () => {
    await render(); await click('Disconnect this account…')
    expect(api.disconnectHostaway).not.toHaveBeenCalled()
    await click('Keep connection'); expect(api.disconnectHostaway).not.toHaveBeenCalled()
    await click('Disconnect this account…'); await click('Confirm disconnect')
    expect(api.disconnectHostaway).toHaveBeenCalledExactlyOnceWith(2)
    expect(host.textContent).toContain('Disconnected')
  })
})
