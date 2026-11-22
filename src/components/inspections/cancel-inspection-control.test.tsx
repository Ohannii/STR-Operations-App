// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ update: vi.fn(), refresh: vi.fn() }))
vi.mock('@/app/dashboard/work/actions', () => ({ updateTurnover: mocks.update }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
import { CancelInspectionControl } from './cancel-inspection-control'
import type { TurnoverJob } from '@/lib/inspections/workboard'
const job = { id: 'job', revision: 1, due_on: '2026-11-22' } as TurnoverJob
let root: Root, host: HTMLDivElement
const button = (text: string) => {
  const found = [...host.querySelectorAll('button')].find(b => b.textContent === text)
  expect(found, `button ${text}`).toBeTruthy()
  return found!
}
const click = async (element: HTMLElement) => { await act(async () => { element.click() }) }
const actions = () => host.querySelector<HTMLButtonElement>('[aria-label="Inspection options"]')!
async function openConfirmation() {
  await click(actions())
  await click(button('Cancel inspection…'))
  return host.querySelector('dialog')!
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks(); mocks.update.mockResolvedValue({ ok: true })
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => { root.render(<CancelInspectionControl job={job} propertyName="Ballito Life · Unit 91" />) })
})
afterEach(async () => {
  await act(async () => { root.unmount() }); host.remove(); vi.unstubAllGlobals()
})
describe('actual cancellation interactions', () => {
  it('opening the menu and confirmation never cancels; Keep is focused and preserves the inspection', async () => {
    expect(actions().textContent).toBe('Options')
    expect(host.querySelector('dialog')).toBeNull()
    await click(actions())
    expect(actions().getAttribute('aria-expanded')).toBe('true')
    expect(mocks.update).not.toHaveBeenCalled()
    await click(button('Cancel inspection…'))
    expect(host.querySelector('dialog')?.open).toBe(true)
    expect(host.textContent).toContain('Ballito Life · Unit 91')
    expect(host.textContent).toContain('22 Nov 2026')
    expect(document.activeElement).toBe(button('Keep inspection'))
    expect(mocks.update).not.toHaveBeenCalled()
    await click(button('Keep inspection'))
    expect(host.querySelector('dialog')).toBeNull()
    expect(document.activeElement).toBe(actions())
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled()
  })
  it('only the explicit confirmation calls the existing action with the selected visit and revision', async () => {
    await openConfirmation()
    await click(button('Cancel inspection'))
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith('job', 1, '2026-11-22', true)
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(host.querySelector('dialog')).toBeNull()
  })
  it('Escape dismisses the confirmation without making any save', async () => {
    const dialog = await openConfirmation()
    await act(async () => { dialog.dispatchEvent(new Event('cancel', { cancelable: true })) })
    expect(host.querySelector('dialog')).toBeNull(); expect(mocks.update).not.toHaveBeenCalled()
  })
  it('outside taps and Escape close only the actions menu', async () => {
    await click(actions())
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(host.querySelector('[role="menu"]')).toBeNull()
    await click(actions())
    await act(async () => { button('Cancel inspection…').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(host.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(actions())
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('double taps issue one request and cannot dismiss the dialog while saving', async () => {
    let finish!: (value: { ok: true }) => void
    mocks.update.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const dialog = await openConfirmation()
    const confirm = button('Cancel inspection')
    await act(async () => { confirm.click(); confirm.click() })
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(button('Keep inspection').disabled).toBe(true)
    await act(async () => { dialog.dispatchEvent(new Event('cancel', { cancelable: true })) })
    expect(dialog.open).toBe(true)
    await act(async () => { finish({ ok: true }) })
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
  it('keeps the confirmation and a truthful error after failure, without reporting success', async () => {
    mocks.update.mockResolvedValueOnce({ ok: false, error: 'This changed on another device. Reload.' })
    await openConfirmation(); await click(button('Cancel inspection'))
    expect(host.querySelector('dialog')?.open).toBe(true)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('another device')
    expect(button('Keep inspection').disabled).toBe(false); expect(mocks.refresh).not.toHaveBeenCalled()
  })
  it('handles a lost response without claiming nothing changed', async () => {
    mocks.update.mockRejectedValueOnce(Error('private transport detail'))
    await openConfirmation(); await click(button('Cancel inspection'))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Reload to check')
    expect(host.textContent).not.toContain('private transport detail'); expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
