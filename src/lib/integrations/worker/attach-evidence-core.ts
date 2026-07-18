import { AsanaApiError } from '@/lib/integrations/asana/client'
import {
  planEvidenceUploads,
  pdfAttachmentName,
  photoAttachmentName,
} from '@/lib/integrations/asana/attachment-names'

/**
 * PURE orchestration for "attach flag evidence" (Slice 11C2). No I/O, no
 * server-only imports — every side effect is injected via `AttachIO`, so
 * the race, dependency-wait, and 429 paths are unit-testable with fakes.
 *
 * Guarantees:
 *   - PDF is attached FIRST, then photos in ascending ordinal.
 *   - Idempotent by attachment-name key (list → plan → upload remainder).
 *   - Sequential uploads; the caller's IO holds one buffer at a time.
 *   - Missing task link → dependency-wait reschedule (no attempt consumed),
 *     capped at DEP_WAIT_MAX_MS from the first wait (reset on re-arm).
 *   - 429 → reschedule by Retry-After (no attempt consumed).
 *   - Re-armed mid-processing → completion's generation compare-and-set
 *     fails → reschedule so the newer content re-runs (never lost).
 */

export const DEP_WAIT_MAX_MS = 6 * 60 * 60 * 1000 // 6 hours
export const DEP_WAIT_BACKOFF_SECONDS = 60
export const RATE_LIMIT_FALLBACK_SECONDS = 30

export type GuardedAttachRow = {
  outboxId: string
  companyId: string
  flagId: string
  attemptCount: number
}

export type EvidencePhoto = { photoId: string; ordinal: number; masterPath: string }

export type EvidenceBundle = {
  unit: string
  flagTitle: string
  raisedDMY: string
  contentHash: string
  pdfBytes: Uint8Array
  photos: EvidencePhoto[]
}

export type AttachIO = {
  newRunId: () => string
  /** pending→processing with a run token; returns the captured generation. */
  claim: (outboxId: string, runId: string) => Promise<{ generation: number } | null>
  /** Renew the processing lease so the stale-reset can't reclaim mid-upload. */
  heartbeat: (outboxId: string, runId: string) => Promise<void>
  /** done ONLY if we still own the lease AND the generation is unchanged. */
  completeIfGen: (outboxId: string, runId: string, generation: number) => Promise<boolean>
  /** Back to pending WITHOUT consuming an attempt (dependency-wait / 429 / rerun). */
  reschedule: (
    outboxId: string,
    runId: string,
    opts: { availableInSeconds: number; setDepWaitStartedAt?: boolean },
  ) => Promise<void>
  /** Real failure: attempt++, backoff, dead at cap. */
  failRetry: (outboxId: string, attemptCount: number, message: string) => Promise<void>
  deadLetter: (outboxId: string, reason: string) => Promise<void>
  getDepWaitStartedAt: (outboxId: string) => Promise<string | null>
  resolveTaskGid: (companyId: string, flagId: string) => Promise<string | null>
  loadEvidence: (companyId: string, flagId: string) => Promise<EvidenceBundle | null>
  downloadMaster: (path: string) => Promise<Uint8Array | null>
  listAttachmentNames: (taskGid: string) => Promise<string[]>
  uploadAttachment: (
    taskGid: string,
    filename: string,
    contentType: string,
    bytes: Uint8Array,
  ) => Promise<void>
}

export type AttachResult =
  | { status: 'skipped'; outboxId: string }
  | { status: 'dependency_wait'; outboxId: string; flagId: string }
  | { status: 'rate_limited'; outboxId: string; retryAfterSeconds: number }
  | { status: 'attached'; outboxId: string; flagId: string; uploaded: number }
  | { status: 'rerun'; outboxId: string; flagId: string }
  | { status: 'refused'; outboxId: string; reason: string }
  | { status: 'error'; outboxId: string; error: string }

async function handleUploadError(
  io: AttachIO,
  row: GuardedAttachRow,
  runId: string,
  err: unknown,
): Promise<AttachResult> {
  if (err instanceof AsanaApiError && err.status === 429) {
    const secs = err.retryAfterSeconds ?? RATE_LIMIT_FALLBACK_SECONDS
    await io.reschedule(row.outboxId, runId, { availableInSeconds: secs }) // no attempt consumed
    return { status: 'rate_limited', outboxId: row.outboxId, retryAfterSeconds: secs }
  }
  const message = err instanceof Error ? err.message : String(err)
  await io.failRetry(row.outboxId, row.attemptCount, message)
  return { status: 'error', outboxId: row.outboxId, error: 'attach failed' }
}

export async function runAttachEvidence(
  io: AttachIO,
  row: GuardedAttachRow,
): Promise<AttachResult> {
  const runId = io.newRunId()
  const claim = await io.claim(row.outboxId, runId)
  if (!claim) return { status: 'skipped', outboxId: row.outboxId } // lost the claim race
  const generation = claim.generation

  // Dependency: the Asana task link must exist.
  const taskGid = await io.resolveTaskGid(row.companyId, row.flagId)
  if (!taskGid) {
    const startedAt = await io.getDepWaitStartedAt(row.outboxId)
    if (startedAt && Date.now() - Date.parse(startedAt) > DEP_WAIT_MAX_MS) {
      await io.deadLetter(row.outboxId, 'asana task link not ready within max wait')
      return { status: 'refused', outboxId: row.outboxId, reason: 'dependency wait expired' }
    }
    await io.reschedule(row.outboxId, runId, {
      availableInSeconds: DEP_WAIT_BACKOFF_SECONDS,
      setDepWaitStartedAt: !startedAt,
    })
    return { status: 'dependency_wait', outboxId: row.outboxId, flagId: row.flagId }
  }

  // Tenant-scoped evidence. null → flag missing / cross-tenant.
  const ev = await io.loadEvidence(row.companyId, row.flagId)
  if (!ev) {
    await io.deadLetter(row.outboxId, 'flag not found for attach')
    return { status: 'refused', outboxId: row.outboxId, reason: 'flag not found' }
  }

  let existingNames: string[]
  try {
    existingNames = await io.listAttachmentNames(taskGid)
  } catch (err) {
    return handleUploadError(io, row, runId, err)
  }

  const plan = planEvidenceUploads({
    existingNames,
    contentHash: ev.contentHash,
    photos: ev.photos.map((p) => ({ photoId: p.photoId, ordinal: p.ordinal })),
  })

  let uploaded = 0

  // PDF FIRST.
  if (plan.uploadPdf) {
    await io.heartbeat(row.outboxId, runId)
    try {
      await io.uploadAttachment(
        taskGid,
        pdfAttachmentName(ev.unit, ev.flagTitle, ev.raisedDMY, ev.contentHash),
        'application/pdf',
        ev.pdfBytes,
      )
      uploaded++
    } catch (err) {
      return handleUploadError(io, row, runId, err)
    }
  }

  // Photos in ascending ordinal, one buffer at a time.
  const ordered = [...plan.photosToUpload].sort((a, b) => a.ordinal - b.ordinal)
  for (const p of ordered) {
    const full = ev.photos.find((x) => x.photoId === p.photoId)
    if (!full) continue
    await io.heartbeat(row.outboxId, runId)
    const bytes = await io.downloadMaster(full.masterPath)
    if (!bytes) continue // master unavailable (deleted/orphaned) → skip, don't fail forever
    try {
      await io.uploadAttachment(
        taskGid,
        photoAttachmentName(ev.unit, ev.flagTitle, p.ordinal, p.photoId),
        'image/jpeg',
        bytes,
      )
      uploaded++
    } catch (err) {
      return handleUploadError(io, row, runId, err)
    }
  }

  // Complete via generation compare-and-set (race-safe).
  const done = await io.completeIfGen(row.outboxId, runId, generation)
  if (done) return { status: 'attached', outboxId: row.outboxId, flagId: row.flagId, uploaded }
  // Re-armed during processing (or lease lost) → reschedule for newer content.
  await io.reschedule(row.outboxId, runId, { availableInSeconds: 0 })
  return { status: 'rerun', outboxId: row.outboxId, flagId: row.flagId }
}
