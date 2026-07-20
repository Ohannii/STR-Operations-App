'use client'

import { useSyncExternalStore } from 'react'

/**
 * LIVE, IN-MEMORY capture state for a pre-arrival pack.
 *
 * AUTHORITY (important): this store is NOT durable and NOT authoritative. It
 * exists only to block submission while THIS browser still has work in flight
 * or failed in the CURRENT session. All durable truth comes from the server:
 *   * linked photo rows            (public.photos)
 *   * unresolved upload intents    (public.photo_upload_intents, state='pending')
 * and the final decision is made by finalize_prearrival_pack().
 *
 * Nothing is persisted. An earlier version kept a monotonic "high-water" total
 * in localStorage; that was removed because it could PERMANENTLY DEADLOCK a
 * pack: after an inspector legitimately discarded a pending intent (audited,
 * server-side) or recovered one, the stale local total still exceeded the
 * linked count and blocked submission forever. After a reload the map is empty
 * by design, so the gate falls back to server truth — which is exactly right,
 * and also covers other tabs and other devices.
 *
 * Model: per-LOGICAL-PHOTO-ID state (not fragile counters). Totals are derived.
 */

export type PhotoState = 'pending' | 'uploading' | 'attaching' | 'saved' | 'failed'

export type PackCaptureState = {
  /** Photos this session has committed, on top of the server baseline. */
  intendedTotal: number
  /** True while any committed photo in THIS session is not yet saved. */
  blocking: boolean
  pending: number
  failed: number
  saved: number
}

type Internal = {
  baseline: number
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

function recompute(packId: string): void {
  const it = packs.get(packId)
  if (!it) return
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
  it.snap = {
    intendedTotal: it.baseline + it.photos.size,
    blocking: pending > 0,
    pending,
    failed,
    saved,
  }
}

function get(packId: string): Internal {
  let it = packs.get(packId)
  if (!it) {
    it = { baseline: 0, photos: new Map(), snap: EMPTY }
    packs.set(packId, it)
    recompute(packId)
  }
  return it
}

export const packCapture = {
  /** Track the server-linked count as the baseline WHILE nothing is committed
   *  yet, so already-linked photos are included (10 linked + 5 committed = 15). */
  syncBaseline(packId: string, linked: number): void {
    const it = get(packId)
    if (it.photos.size === 0 && it.baseline !== linked) {
      it.baseline = linked
      recompute(packId)
      emit()
    }
  },
  commit(packId: string, logicalId: string): void {
    const it = get(packId)
    if (!it.photos.has(logicalId)) {
      it.photos.set(logicalId, 'pending')
      recompute(packId)
      emit()
    }
  },
  mark(packId: string, logicalId: string, state: PhotoState): void {
    const it = get(packId)
    if (it.photos.has(logicalId)) {
      it.photos.set(logicalId, state)
      recompute(packId)
      emit()
    }
  },
  /** Drop a logical photo from this session's map (destructive discard of an
   *  unattached/failed capture). Durable consequences are the server's job. */
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
