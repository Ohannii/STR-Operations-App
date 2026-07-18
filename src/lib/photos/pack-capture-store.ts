'use client'

import { useSyncExternalStore } from 'react'

/**
 * Shared capture state for a pre-arrival pack (Outcome 1 emergency guard).
 *
 * IMPORTANT SCOPE: this is a CURRENT-BROWSER-SESSION safeguard and a UX
 * aid. It is NOT server authority. Cross-device, cross-browser and
 * post-crash correctness are explicitly out of scope here and belong to
 * Outcome 2 (server-side upload intents). The authoritative guard is the
 * server: `submitEvidencePackAction` recounts active linked photos and
 * requires `linked >= expected_count >= 1`.
 *
 * Model: per-LOGICAL-PHOTO-ID state (not fragile counters). Each photo the
 * inspector commits to a pack is tracked by its client-generated logical id
 * through: pending → uploading → attaching → saved | failed. Totals are
 * DERIVED from this map, so retries and removals are precise.
 *
 * Intended total = max(persistedTarget, sessionBaseline + committedCount),
 * where sessionBaseline is the server-linked count captured while no photo
 * is committed yet (so already-linked photos are included: 10 linked + 5
 * committed = intended 15). `persistedTarget` is a monotonic localStorage
 * hint so a reload can't instantly drop to a false success — it never
 * lowers, so abandoning a failed photo can't shrink the requirement; the
 * inspector must retry or recapture (there is no "accept what saved"
 * escape in this emergency release).
 */

export type PhotoState = 'pending' | 'uploading' | 'attaching' | 'saved' | 'failed'

export type PackCaptureState = {
  intendedTotal: number
  /** True while any committed photo is not yet saved (pending/…/failed). */
  blocking: boolean
  /** Committed but not saved (pending + uploading + attaching + failed). */
  pending: number
  failed: number
  saved: number
}

type Internal = {
  baseline: number
  target: number
  photos: Map<string, PhotoState>
  snap: PackCaptureState
}

const EMPTY: PackCaptureState = {
  intendedTotal: 0,
  blocking: false,
  pending: 0,
  failed: 0,
  saved: 0,
}

const packs = new Map<string, Internal>()
const listeners = new Set<() => void>()
const emit = () => {
  for (const l of listeners) l()
}

function lsKey(packId: string): string {
  return `dropinn:pack-target:${packId}`
}
function loadTarget(packId: string): number {
  if (typeof window === 'undefined') return 0
  try {
    const n = Number.parseInt(window.localStorage.getItem(lsKey(packId)) ?? '0', 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}
function saveTarget(packId: string, n: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(lsKey(packId), String(Math.max(0, Math.trunc(n))))
  } catch {
    /* private mode — degrade to in-memory session only */
  }
}

function recompute(packId: string): void {
  const it = packs.get(packId)
  if (!it) return
  const intended = Math.max(it.target, it.baseline + it.photos.size)
  if (intended > it.target) {
    it.target = intended
    saveTarget(packId, intended)
  }
  let failed = 0
  let saved = 0
  let pending = 0
  for (const s of it.photos.values()) {
    if (s === 'saved') saved += 1
    else {
      pending += 1
      if (s === 'failed') failed += 1
    }
  }
  it.snap = { intendedTotal: intended, blocking: pending > 0, pending, failed, saved }
}

function get(packId: string): Internal {
  let it = packs.get(packId)
  if (!it) {
    it = { baseline: 0, target: loadTarget(packId), photos: new Map(), snap: EMPTY }
    packs.set(packId, it)
    recompute(packId)
  }
  return it
}

export const packCapture = {
  /** Track the server-linked count as the baseline WHILE nothing is committed
   *  yet, so already-linked photos are included in the intended total. */
  syncBaseline(packId: string, linked: number): void {
    const it = get(packId)
    if (it.photos.size === 0 && it.baseline !== linked) {
      it.baseline = linked
      recompute(packId)
      emit()
    }
  },
  /** The inspector committed a logical photo to the pack. */
  commit(packId: string, logicalId: string): void {
    const it = get(packId)
    if (!it.photos.has(logicalId)) {
      it.photos.set(logicalId, 'pending')
      recompute(packId)
      emit()
    }
  },
  /** Advance a committed photo's lifecycle state. */
  mark(packId: string, logicalId: string, state: PhotoState): void {
    const it = get(packId)
    if (it.photos.has(logicalId)) {
      it.photos.set(logicalId, state)
      recompute(packId)
      emit()
    }
  },
  /** Remove a logical photo from the session map (e.g. a destructive discard
   *  of a failed/unattached capture). Does NOT lower the persisted target —
   *  the inspector must retry or recapture to reach it. */
  remove(packId: string, logicalId: string): void {
    const it = get(packId)
    if (it.photos.delete(logicalId)) {
      recompute(packId)
      emit()
    }
  },
  snapshot(packId: string): PackCaptureState {
    return get(packId).snap
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
}

export function usePackCapture(packId: string): PackCaptureState {
  return useSyncExternalStore(
    packCapture.subscribe,
    () => packCapture.snapshot(packId),
    () => EMPTY,
  )
}
