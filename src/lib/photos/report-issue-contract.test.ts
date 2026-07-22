import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * SOURCE CONTRACT for the yellow "Report issue" button (P0 field failure,
 * 22 Jul night). The bug was WIRING, not the worker: handleRaiseFlag still
 * ran the legacy in-modal uploader for packs, re-requesting slots for
 * already-staged photos — create-only Storage answered "The resource
 * already exists" and 25 safe photos were declared failed. This test pins
 * the corrected wiring at source level, the same technique chat accepted
 * for the batch-action contract: a future edit cannot quietly re-route the
 * button back onto the legacy pipeline.
 */
describe('handleRaiseFlag wiring contract (the yellow Report issue button)', () => {
  // Normalized: this repo's working tree is CRLF on Windows, and a source
  // contract must pin STRUCTURE, never line-ending bytes.
  const source = readFileSync(
    join(process.cwd(), 'src/components/photos/evidence-capture.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n')

  const fnStart = source.indexOf('const handleRaiseFlag = useCallback')
  const fnEnd = source.indexOf(', [pending, runUploads, propertyId, stopCamera', fnStart)
  const body = source.slice(fnStart, fnEnd)

  const packBranchStart = body.indexOf('readyItems.length > 0 && evidencePackId')
  const flagBranchStart = body.indexOf('} else if (readyItems.length > 0)')
  const packBranch = body.slice(packBranchStart, flagBranchStart)
  const flagBranch = body.slice(flagBranchStart)

  it('the handler and both branches exist in the expected shape', () => {
    expect(fnStart).toBeGreaterThan(-1)
    expect(fnEnd).toBeGreaterThan(fnStart)
    expect(packBranchStart).toBeGreaterThan(-1)
    expect(flagBranchStart).toBeGreaterThan(packBranchStart)
  })

  it('PACK MODE releases to the durable queue: releaseQueued + drainQueue, ids and captions preserved', () => {
    expect(packBranch).toContain('releaseQueued(evidencePackId, notes)')
    expect(packBranch).toContain('drainQueue(evidencePackId)')
    // Captions: the same per-photo note map the Attach button builds.
    expect(packBranch).toContain("it.note?.trim() || attachAllNote.trim() || null")
    // Ids: every ready item is committed to the shared per-id store.
    expect(packBranch).toContain('packCapture.commit(evidencePackId, it.id)')
  })

  it('PACK MODE never touches the legacy pipeline or requests legacy slots', () => {
    expect(packBranch).not.toContain('runUploads')
    expect(packBranch).not.toContain('requestPhotoUploadSlot')
    expect(packBranch).not.toContain('uploadOne')
  })

  it('the legacy uploader is reachable ONLY from genuine flag capture', () => {
    // Inside handleRaiseFlag, runUploads lives solely in the flag branch.
    expect(flagBranch).toContain('runUploads(readyItems)')
    // handleAttach's CONTROL-FLOW boundary, asserted by the ORDER of
    // structural anchors (no newline literals, no incidental UI text):
    // pack branch -> queue handoff -> unconditional return -> only THEN the
    // legacy call. If any future edit removes the return or hoists the
    // legacy call above it, one of these orderings breaks.
    const attachStart = source.indexOf('const handleAttach = useCallback')
    const attachEnd = source.indexOf('runUploads, evidencePackId, attachAllNote])', attachStart)
    expect(attachStart).toBeGreaterThan(-1)
    expect(attachEnd).toBeGreaterThan(attachStart)
    const attachBody = source.slice(attachStart, attachEnd)

    const packBranchIdx = attachBody.indexOf('if (evidencePackId) {')
    const queueHandoffIdx = attachBody.indexOf('drainQueue(evidencePackId)', packBranchIdx)
    const packExitIdx = attachBody.indexOf('return', queueHandoffIdx)
    const legacyCallIdx = attachBody.indexOf('await runUploads(')

    expect(packBranchIdx).toBeGreaterThan(-1) // pack branch exists
    expect(queueHandoffIdx).toBeGreaterThan(packBranchIdx) // hands to the queue
    expect(packExitIdx).toBeGreaterThan(queueHandoffIdx) // then exits
    expect(legacyCallIdx).toBeGreaterThan(packExitIdx) // legacy strictly after
  })

  it('navigation still happens after the pack release (worker continues in background)', () => {
    // The navigation tail (stopCamera + flags/new target) survives after
    // both branches — the durable worker finishes while the user reports.
    expect(body).toContain('stopCamera()')
    expect(body).toContain('/flags/new')
  })
})
