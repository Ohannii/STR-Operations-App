import { describe, it, expect, vi } from 'vitest'
import {
  ensureAndSignArtifact,
  isReportConflict,
  type ArtifactStore,
} from '@/lib/reports/ensure-report-artifact-core'

const PATH = 'companies/c1/flags/f1/flag-report-t1-abc.pdf'
const bytes = () => Promise.resolve(Buffer.from('%PDF-1.7 test'))

describe('isReportConflict', () => {
  it('detects 409 / already-exists / duplicate', () => {
    expect(isReportConflict({ statusCode: '409' })).toBe(true)
    expect(isReportConflict({ message: 'The resource already exists' })).toBe(true)
    expect(isReportConflict({ message: 'Duplicate' })).toBe(true)
    expect(isReportConflict({ message: 'network down' })).toBe(false)
    expect(isReportConflict(null)).toBe(false)
  })
})

describe('ensureAndSignArtifact', () => {
  it('reuses an existing artifact WITHOUT rendering', async () => {
    const render = vi.fn(bytes)
    const store: ArtifactStore = {
      signExisting: vi.fn(async () => 'https://signed/existing'),
      createOnly: vi.fn(async () => ({ ok: true, conflict: false })),
    }
    const url = await ensureAndSignArtifact(store, PATH, render)
    expect(url).toBe('https://signed/existing')
    expect(render).not.toHaveBeenCalled()
    expect(store.createOnly).not.toHaveBeenCalled()
  })

  it('renders + create-only uploads when absent, then signs', async () => {
    const render = vi.fn(bytes)
    let created = false
    const store: ArtifactStore = {
      signExisting: vi.fn(async () => (created ? 'https://signed/new' : null)),
      createOnly: vi.fn(async () => {
        created = true
        return { ok: true, conflict: false }
      }),
    }
    const url = await ensureAndSignArtifact(store, PATH, render)
    expect(render).toHaveBeenCalledTimes(1)
    expect(store.createOnly).toHaveBeenCalledTimes(1)
    expect(url).toBe('https://signed/new')
  })

  it('handles a concurrent-create collision by loading the winner', async () => {
    const render = vi.fn(bytes)
    let winnerPresent = false
    const store: ArtifactStore = {
      // first sign: not present; after the (conflicting) upload: winner present
      signExisting: vi.fn(async () => (winnerPresent ? 'https://signed/winner' : null)),
      createOnly: vi.fn(async () => {
        winnerPresent = true
        return { ok: false, conflict: true } // we lost the race
      }),
    }
    const url = await ensureAndSignArtifact(store, PATH, render)
    expect(url).toBe('https://signed/winner')
  })

  it('throws on a non-conflict upload error', async () => {
    const store: ArtifactStore = {
      signExisting: vi.fn(async () => null),
      createOnly: vi.fn(async () => ({ ok: false, conflict: false, error: 'disk full' })),
    }
    await expect(ensureAndSignArtifact(store, PATH, bytes)).rejects.toThrow(/disk full/)
  })
})
