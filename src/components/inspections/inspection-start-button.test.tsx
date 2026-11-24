// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ start: vi.fn(), push: vi.fn(), refresh: vi.fn() }))
vi.mock('@/app/dashboard/work/actions', () => ({ startTurnover: mocks.start }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }))
import { InspectionStartButton } from './inspection-start-button'
let root: Root, host: HTMLDivElement
const button = () => host.querySelector('button')!
const click = async () => { await act(async () => { button().click() }) }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks()
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  mocks.start.mockResolvedValue({ ok: true, packId: 'same-pack' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root.render(<InspectionStartButton jobId="same-job" propertyId="same-apartment" label="Start inspection" />) })
})
afterEach(async () => { await act(async () => { root.unmount() }); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('Start inspection interactions', () => {
  it('known offline makes no request and keeps a useful inline message', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await click()
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('No connection')
    expect(button().disabled).toBe(false)
  })
  it('double taps send one request for the same visit and navigate only after confirmation', async () => {
    let finish!: (result: { ok: true; packId: string }) => void
    mocks.start.mockReturnValue(new Promise(resolve => { finish = resolve }))
    await act(async () => { button().click(); button().click() })
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith('same-job')
    expect(button().disabled).toBe(true); expect(mocks.push).not.toHaveBeenCalled()
    await act(async () => { finish({ ok: true, packId: 'same-pack' }) })
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/properties/same-apartment')
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
  it('a refused start preserves the screen and error without navigating', async () => {
    mocks.start.mockResolvedValueOnce({ ok: false, error: 'This inspection changed. Reload.' })
    await click()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('changed')
    expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled()
  })
  it('a lost response never claims nothing started; retry uses the exact same visit', async () => {
    mocks.start.mockRejectedValueOnce(Error('private transport detail'))
    await click()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not confirm')
    expect(host.textContent).toContain('Retrying opens the same inspection')
    expect(host.textContent).not.toMatch(/Nothing was started|private transport/i)
    expect(button().disabled).toBe(false); expect(mocks.push).not.toHaveBeenCalled()
    await click()
    expect(mocks.start.mock.calls).toEqual([['same-job'], ['same-job']])
    expect(mocks.push).toHaveBeenCalledOnce(); expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})
