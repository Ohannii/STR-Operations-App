import { describe, it, expect } from 'vitest'
import { AsanaApiError } from '@/lib/integrations/asana/client'
import {
  runAttachEvidence,
  type AttachIO,
  type EvidenceBundle,
} from '@/lib/integrations/worker/attach-evidence-core'

const HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
const ROW = { outboxId: 'ob-1', companyId: 'co-1', flagId: 'flag-1', attemptCount: 0 }

function evidence(photoCount: number): EvidenceBundle {
  return {
    unit: 'Test 1',
    flagTitle: 'Photo test',
    raisedDMY: '16-07-2026',
    contentHash: HASH,
    pdfBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
    photos: Array.from({ length: photoCount }, (_, i) => ({
      photoId: `${i + 1}0000000-0000-4000-8000-000000000000`,
      ordinal: i + 1,
      masterPath: `companies/co-1/flags/flag-1/${i + 1}0000000.jpg`,
    })),
  }
}

type FakeConfig = {
  taskGid?: string | null
  evidence?: EvidenceBundle | null
  existingNames?: string[]
  depWaitStartedAt?: string | null
  generation?: number
  listThrows?: unknown
  onUpload?: (state: { generation: number }, uploadNumber: number) => void
}

function makeFake(config: FakeConfig) {
  const state = {
    status: 'pending' as string,
    lockedBy: null as string | null,
    generation: config.generation ?? 1,
    depWaitStartedAt: config.depWaitStartedAt ?? null,
  }
  const uploads: string[] = []
  const calls = { failRetry: 0, deadLetter: 0, reschedule: [] as { availableInSeconds: number; setDepWaitStartedAt?: boolean }[], completed: false }

  const io: AttachIO = {
    newRunId: () => 'run-1',
    async claim(_id, runId) {
      if (state.status !== 'pending') return null
      state.status = 'processing'
      state.lockedBy = runId
      return { generation: state.generation }
    },
    async heartbeat() {},
    async completeIfGen(_id, runId, gen) {
      if (state.lockedBy !== runId) return false
      if (String(state.generation) !== String(gen)) return false
      state.status = 'done'
      calls.completed = true
      return true
    },
    async reschedule(_id, runId, opts) {
      if (state.lockedBy !== runId) return
      state.status = 'pending'
      calls.reschedule.push(opts)
      if (opts.setDepWaitStartedAt) state.depWaitStartedAt = new Date().toISOString()
    },
    async failRetry() {
      calls.failRetry++
      state.status = 'pending'
    },
    async deadLetter() {
      calls.deadLetter++
      state.status = 'dead'
    },
    async getDepWaitStartedAt() {
      return state.depWaitStartedAt
    },
    async resolveTaskGid() {
      return config.taskGid === undefined ? 'task-9' : config.taskGid
    },
    async loadEvidence() {
      return config.evidence === undefined ? evidence(1) : config.evidence
    },
    async downloadMaster() {
      return new Uint8Array([1, 2, 3])
    },
    async listAttachmentNames() {
      if (config.listThrows) throw config.listThrows
      return config.existingNames ?? []
    },
    async uploadAttachment(_taskGid, filename) {
      uploads.push(filename)
      config.onUpload?.(state, uploads.length)
    },
  }
  return { io, state, uploads, calls }
}

describe('runAttachEvidence', () => {
  it('attaches the PDF FIRST, then the single photo', async () => {
    const f = makeFake({ evidence: evidence(1), existingNames: [] })
    const res = await runAttachEvidence(f.io, ROW)
    expect(res.status).toBe('attached')
    expect(f.uploads).toHaveLength(2)
    expect(f.uploads[0]).toMatch(/\.pdf$/)
    expect(f.uploads[1]).toMatch(/\.jpg$/)
    expect(f.state.status).toBe('done')
  })

  it('uploads 5 photos in ascending ordinal after the PDF', async () => {
    const f = makeFake({ evidence: evidence(5), existingNames: [] })
    await runAttachEvidence(f.io, ROW)
    expect(f.uploads[0]).toMatch(/\.pdf$/)
    const photoNames = f.uploads.slice(1)
    expect(photoNames).toHaveLength(5)
    const ordinals = photoNames.map((n) => Number(/Photo (\d)/.exec(n)?.[1]))
    expect(ordinals).toEqual([1, 2, 3, 4, 5])
  })

  it('missing task link → dependency-wait, NO attempt consumed', async () => {
    const f = makeFake({ taskGid: null, evidence: evidence(1) })
    const res = await runAttachEvidence(f.io, ROW)
    expect(res.status).toBe('dependency_wait')
    expect(f.calls.failRetry).toBe(0) // never consumes a failure attempt
    expect(f.calls.reschedule[0]?.setDepWaitStartedAt).toBe(true)
    expect(f.uploads).toHaveLength(0)
  })

  it('dependency-wait past the 6h cap → dead-letter', async () => {
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()
    const f = makeFake({ taskGid: null, depWaitStartedAt: old })
    const res = await runAttachEvidence(f.io, ROW)
    expect(res.status).toBe('refused')
    expect(f.calls.deadLetter).toBe(1)
  })

  it('429 → reschedule by Retry-After, NO attempt consumed', async () => {
    const err = new AsanaApiError('add attachment', 429, 'rate limited', 7)
    const f = makeFake({ evidence: evidence(1), existingNames: [], onUpload: () => { throw err } })
    const res = await runAttachEvidence(f.io, ROW)
    expect(res).toMatchObject({ status: 'rate_limited', retryAfterSeconds: 7 })
    expect(f.calls.failRetry).toBe(0)
  })

  it('a genuine (non-429) upload error consumes an attempt', async () => {
    const f = makeFake({ evidence: evidence(1), existingNames: [], onUpload: () => { throw new Error('boom') } })
    const res = await runAttachEvidence(f.io, ROW)
    expect(res.status).toBe('error')
    expect(f.calls.failRetry).toBe(1)
  })

  it('partial success / crash-retry → uploads only the remainder', async () => {
    const ev = evidence(2)
    // Existing list already has the PDF + photo 1 (by their keys).
    const existingNames = [
      `Test 1 - Photo test - 16-07-2026 - ${HASH.slice(0, 8)}.pdf`,
      `Test 1 - Photo test - Photo 1 - 10000000.jpg`,
    ]
    const f = makeFake({ evidence: ev, existingNames })
    const res = await runAttachEvidence(f.io, ROW)
    expect(res.status).toBe('attached')
    expect(f.uploads).toEqual([`Test 1 - Photo test - Photo 2 - 20000000.jpg`])
  })

  it('re-armed DURING processing → completion fails, event re-runs (not lost)', async () => {
    // Bump the generation on the final upload, simulating a concurrent re-arm.
    const ev = evidence(1)
    const f = makeFake({
      evidence: ev,
      existingNames: [],
      onUpload: (state, n) => {
        if (n === 2) state.generation = 2 // PDF (1) then photo (2) → bump on the last
      },
    })
    const res = await runAttachEvidence(f.io, ROW)
    expect(res.status).toBe('rerun')
    expect(f.calls.completed).toBe(false) // never marked done for the stale generation
    expect(f.state.status).toBe('pending') // left pending → re-runs for the newer content
  })

  it('lost the claim race → skipped', async () => {
    const f = makeFake({})
    f.state.status = 'processing' // already claimed by someone else
    const res = await runAttachEvidence(f.io, ROW)
    expect(res.status).toBe('skipped')
  })

  it('list attachments 429 → rate_limited without consuming an attempt', async () => {
    const err = new AsanaApiError('list attachments', 429, 'rate', 5)
    const f = makeFake({ evidence: evidence(1), listThrows: err })
    const res = await runAttachEvidence(f.io, ROW)
    expect(res).toMatchObject({ status: 'rate_limited', retryAfterSeconds: 5 })
    expect(f.calls.failRetry).toBe(0)
  })
})
