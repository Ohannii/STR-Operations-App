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

  it('PACK MODE hands to the durable queue: fail-closed handoff + drainQueue, ids and captions preserved', () => {
    // rev 5: the release goes through handOffPackRelease (capture-handoff.ts,
    // behaviour-tested), which secures every release caption FIRST and
    // reports any photo the queue could not take.
    expect(packBranch).toContain('handOffPackRelease({')
    expect(packBranch).toContain('release: releaseQueued')
    expect(packBranch).toContain('secureRelease: noteKeeper ? (n) => noteKeeper.secureRelease(n) : undefined')
    expect(packBranch).toContain('drainQueue(evidencePackId)')
    // Captions: THE canonical rule (rev 5), never String.prototype.trim().
    expect(packBranch).toContain(
      'canonicalCaptionOrNull(it.note) ?? canonicalCaptionOrNull(attachAllNote)',
    )
    // rev 8: ONLY photos not already proven handed off are handed off and
    // committed — never a resend of an earlier round's photos.
    // rev 9: the proven set is read from the shared gate AT CALL TIME.
    expect(packBranch).toMatch(/const intended = idsToHandOff\(\s*readyItems\.map\(\(it\) => it\.id\),\s*exitGate\.handedOff\(\),\s*\)/)
    expect(packBranch).toContain('for (const id of intended) packCapture.commit(evidencePackId, id)')
    expect(packBranch).toContain('if (!intendedSet.has(it.id)) continue')
    // Only PROVEN photos join the session batch.
    expect(packBranch).toContain('const outcome = exitGate.record(intended, handoff)')
    expect(packBranch).toContain('setBatchIds(outcome.handedOff)')
  })

  it('ITEM 3: Report issue NEVER navigates after a failed handoff', () => {
    // rev 8: navigation requires BOTH ok and an outcome of 'done'.
    const guard = packBranch.indexOf("if (!handoff.ok || outcome.next !== 'done') {")
    const guardReturn = packBranch.indexOf('return', guard)
    const stayOnReview = packBranch.indexOf("setStage('reviewing')", guard)
    expect(guard).toBeGreaterThan(-1)
    expect(stayOnReview).toBeGreaterThan(guard)
    expect(guardReturn).toBeGreaterThan(stayOnReview)
    // The navigation tail is AFTER the whole pack branch (and so after the guard).
    const navIdx = body.indexOf('window.location.href = target')
    expect(navIdx).toBeGreaterThan(packBranchStart + guardReturn)
    // No swallowed release failure remains in the pack branch.
    expect(packBranch).not.toMatch(/catch\s*\{\s*\/\/ Records stay durable/)
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
    // Anchor = handleAttach's dependency array. It must include noteKeeper
    // (caption rev 3), or the handler would release with a stale keeper.
    const attachEnd = source.indexOf(
      'runUploads, evidencePackId, attachAllNote, noteKeeper, exitGate])',
      attachStart,
    )
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

  it('BOTH call sites (Attach + pack-mode Report Issue) run the SAME fail-closed handoff', () => {
    const attachStart = source.indexOf('const handleAttach = useCallback')
    const attachEnd = source.indexOf('runUploads, evidencePackId, attachAllNote, noteKeeper, exitGate])', attachStart)
    const attachBody = source.slice(attachStart, attachEnd)
    const seq = /handOffPackRelease\(\{\s*packId: evidencePackId,\s*notes,\s*secureRelease: noteKeeper \? \(n\) => noteKeeper\.secureRelease\(n\) : undefined,\s*release: releaseQueued,\s*\}\)/
    expect(attachBody).toMatch(seq)
    expect(packBranch).toMatch(seq)
    // rev 8: EVERY non-proven outcome (too long, unsafe, thrown, missing,
    // unreadable, partial) keeps Attach on the review screen — 'done' only
    // after the outcome says every intended photo was proven handed off.
    const reviewIdx = attachBody.indexOf("if (outcome.next === 'review') {")
    const stayIdx = attachBody.indexOf("setStage('reviewing')", reviewIdx)
    const returnIdx = attachBody.indexOf('return', stayIdx)
    const doneIdx = attachBody.indexOf("setStage('done')", reviewIdx)
    expect(reviewIdx).toBeGreaterThan(-1)
    expect(stayIdx).toBeGreaterThan(reviewIdx)
    expect(returnIdx).toBeGreaterThan(stayIdx)
    expect(doneIdx).toBeGreaterThan(returnIdx)
    // ...and nothing in Attach adds UNPROVEN ids to the batch any more.
    expect(attachBody).not.toMatch(/for \(const it of readyItems\) next\.add\(it\.id\)/)
    // Nowhere is a pack released by calling releaseQueued directly any more.
    expect(source.match(/releaseQueued\(/g) ?? []).toEqual([])
  })

  it('rev 8: BOTH call sites use the SAME exact-coverage bookkeeping (no resend, proven-only batch)', () => {
    expect(source.match(/handOffPackRelease\(\{/g)?.length).toBe(2)
    expect(source.match(/idsToHandOff\(\s*readyItems\.map\(\(it\) => it\.id\),\s*exitGate\.handedOff\(\),\s*\)/g)?.length).toBe(2)
    expect(source.match(/exitGate\.record\(intended, handoff\)/g)?.length).toBe(2)
    expect(source.match(/setBatchIds\(outcome\.handedOff\)/g)?.length).toBe(2)
  })

  it('rev 8: the progress list never shows "Attached" without proven handoff', () => {
    // Both the label and the icon go through packRowStatus(batchIds.has(p.id), ...).
    expect(source.match(/packRowStatus\(\s*batchIds\.has\(p\.id\),/g)?.length).toBe(2)
    expect(source).not.toContain("if (!rec) return 'Attached'")
    expect(source).not.toMatch(/if \(!rec\) return <span className="text-emerald-400 text-xs">✓<\/span>/)
  })

  it('ITEMS 1 + 11: caption fields are length-limited and use the canonical rule', () => {
    expect(source.match(/maxLength=\{MAX_CAPTION_LENGTH\}/g)?.length).toBe(2) // own + batch note
    expect(source).not.toMatch(/\.note\?\.trim\(\)|attachAllNote\.trim\(\)/)
    expect(source).toContain('noteKeeper?.setBatchNote(text)')
    expect(source).toContain('noteKeeper?.registerPhoto(id)')
  })

  it('navigation still happens after the pack release (worker continues in background)', () => {
    // The navigation tail (stopCamera + flags/new target) survives after
    // both branches — the durable worker finishes while the user reports.
    expect(body).toContain('stopCamera()')
    expect(body).toContain('/flags/new')
  })

  it('rev 9: BOTH handlers follow the single-flight exit protocol', () => {
    const handler = (name: string, depsAnchor: string) => {
      const start = source.indexOf(`const ${name} = useCallback(async () => {`)
      const end = source.indexOf(depsAnchor, start)
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      return source.slice(start, end)
    }
    const attach = handler('handleAttach', 'runUploads, evidencePackId, attachAllNote, noteKeeper, exitGate])')
    const report = handler('handleRaiseFlag', ', [pending, runUploads, propertyId, stopCamera')
    for (const h of [attach, report]) {
      // 1. the gate is claimed SYNCHRONOUSLY as the very first statement.
      expect(h).toMatch(/useCallback\(async \(\) => \{\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*if \(!exitGate\.tryEnter\(\)\) return/)
      const firstAwait = h.indexOf('await ')
      expect(h.indexOf('exitGate.tryEnter()')).toBeLessThan(firstAwait)
      // 2. the exit plan runs BEFORE any await and refuses partial subsets.
      const planIdx = h.indexOf('planCaptureExit(')
      const refuseIdx = h.indexOf('if (!plan.allowed) {')
      expect(planIdx).toBeGreaterThan(-1)
      expect(planIdx).toBeLessThan(firstAwait)
      expect(refuseIdx).toBeGreaterThan(planIdx)
      expect(h.slice(refuseIdx, firstAwait)).toContain('setBatchError(plan.blockedMessage)')
      // 3. only plan-eligible photos are handled — never the old ready-only filter.
      expect(h).toContain('const readyItems = pending.filter((p) => eligible.has(p.id))')
      expect(h).not.toContain("pending.filter((p) => p.state === 'ready' && p.master && p.thumb)")
      // 4. the proven set comes from the gate and is merged into it.
      expect(h).not.toMatch(/idsToHandOff\([^)]*batchIds/)
      // 5. released in finally.
      expect(h).toMatch(/\} finally \{[\s\S]*exitGate\.leave\(\)/)
    }
    // Report issue keeps the gate claimed once navigation has started.
    expect(report.indexOf('navigating = true')).toBeLessThan(report.indexOf('window.location.href = target'))
    expect(report).toMatch(/\} finally \{[\s\S]*if \(!navigating\) \{\s*exitGate\.leave\(\)/)
  })

  it('rev 9: every action that could change the in-flight snapshot is disabled while exiting', () => {
    const flagButton = source.slice(source.indexOf('onClick={handleRaiseFlag}'), source.indexOf('Report issue\n', source.indexOf('onClick={handleRaiseFlag}')))
    // rev 10: `preparing` also covers captures not yet in pending[].
    expect(flagButton).toContain('disabled={exiting || exitPlan.preparing}')
    expect(source).toContain('disabled={!canAttach}')
    expect(source).toContain('disabled={isMidUpload || exiting || captureWork > 0}') // close
    expect(source).toContain('disabled={!cameraReady || exiting}') // shutter
    expect(source).toContain('disabled={pending.length === 0 || exiting}') // Next
    expect(
      source.match(/onClick=\{\(\) => removePending\(p\.id\)\}\s*disabled=\{exiting \|\| p\.state === 'compressing'\}/g)?.length,
    ).toBe(2)
    expect(source.match(/readOnly=\{exiting\}/g)?.length).toBe(2) // batch note + per-photo caption
    expect(source).toMatch(/onClick=\{\(\) => setStage\('shooting'\)\}\s*disabled=\{exiting\}/) // More photos
    expect(source).toMatch(/const canAttach =\s*!exiting &&\s*exitPlan\.allowed/)
  })

  it('rev 9: the close confirm uses photosToWarnOnClose and never closes mid-handoff', () => {
    const start = source.indexOf('const dismiss = useCallback(() => {')
    const body = source.slice(start, source.indexOf('closeModal()', start))
    // rev 10: never mid-handoff AND never while a capture is being prepared.
    expect(body).toContain('if (exitGate.inFlight || exitGate.captureWork > 0) return')
    expect(body).toContain('photosToWarnOnClose(')
    expect(body).toContain('batch.complete')
  })

  it('rev 10: shutter and gallery claim capture work BEFORE their first await and release it in finally', () => {
    // Executable code only: a comment mentioning "await" must not count.
    const code = (src: string) => src.replace(/\/\/[^\n]*/g, '')
    const fn = (name: string) => {
      const start = source.indexOf(`const ${name} = useCallback(`)
      expect(start).toBeGreaterThan(-1)
      const end = source.indexOf('}, [', start)
      return code(source.slice(start, source.indexOf('\n  const ', end)))
    }
    for (const body of [fn('handleShutter'), fn('handleGallery')]) {
      const claim = body.indexOf('const token = claimCapture()')
      const firstAwait = body.indexOf('await ')
      expect(claim).toBeGreaterThan(-1)
      expect(claim).toBeLessThan(firstAwait)
      expect(body.slice(claim, firstAwait)).toContain('if (!token) return')
      expect(body).toMatch(/\} finally \{\s*releaseCapture\(token\)/)
      expect(body).toMatch(/await ingestBlob\([^\n]*, token\)\n/)
      expect(body).not.toContain('void ingestBlob(') // ingest is INSIDE the claim
    }
    const shutter = fn('handleShutter')
    expect(shutter.indexOf('const token = claimCapture()')).toBeLessThan(shutter.indexOf('canvas.toBlob('))
  })

  it('rev 10: a capture from a closed session never touches the current one', () => {
    const start = source.indexOf('const ingestBlob = useCallback(')
    const body = source.slice(start, source.indexOf('const handleShutter', start))
    // Checked before appending, before the ready update, and before errors.
    expect(body.match(/exitGate\.isCurrent\(token\)/g)?.length).toBeGreaterThanOrEqual(3)
    expect(body.indexOf('if (!exitGate.isCurrent(token)) return')).toBeLessThan(body.indexOf('setPending((prev) => [...prev, item])'))
    const closeStart = source.indexOf('const closeModal = useCallback(')
    const close = source.slice(closeStart, source.indexOf('}, [', closeStart))
    expect(close).toContain('exitGate.reset()')
    expect(close).toContain('setCaptureWork(0)')
  })

  it('rev 10: close, exit plan and beforeunload all see pre-pending capture work', () => {
    const dStart = source.indexOf('const dismiss = useCallback(() => {')
    expect(source.slice(dStart, source.indexOf('closeModal()', dStart))).toContain(
      'if (exitGate.inFlight || exitGate.captureWork > 0) return',
    )
    expect(source).toMatch(/planCaptureExit\(capturePhotos, batchIds, evidencePackId \? 'pack' : 'flag', captureWork\)/)
    expect(source).toContain('const hasUnsavedWork = hasUnsavedCaptureWork(capturePhotos, captureWork)')
  })

  it('hotfix: the visible badge says "Ready" (to attach), never "Uploaded"', () => {
    const code = source.replace(/\/\/[^\n]*/g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    expect(code).not.toMatch(/>\s*Uploaded\s*</)
    expect(code).not.toMatch(/aria-hidden \/> Uploaded/)
    expect(code).not.toContain('aria-label="Uploaded"')
    expect(code).toContain('<Check size={9} aria-hidden /> Ready')
    expect(code).toContain('aria-label="Ready to attach"')
  })
})
