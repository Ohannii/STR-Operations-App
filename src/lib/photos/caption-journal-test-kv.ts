/**
 * TEST SUPPORT ONLY (imported by *.test.ts files, never by app code).
 *
 * An in-memory implementation of the exact Storage surface the caption
 * journal uses (getItem / setItem / removeItem / key / length), so tests can
 * run two controllers against ONE shared "device" — the two-tab case — and
 * inspect what the REAL journal code left on it.
 */

import {
  captionEditKey,
  entryToStored,
  orphanToStored,
  type CaptionDrafts,
  type CaptionOrphans,
  type KV,
} from './caption-drafts'

export type MemoryKV = KV & {
  map: Map<string, string>
  /** When true, every setItem throws (storage full / blocked); removeItem
   *  keeps working — the dangerous combination for replacement writes. */
  failWrites: boolean
  /** Every SUCCESSFUL mutation, in order (for ordering proofs). */
  ops: Array<{ op: 'set' | 'remove'; key: string }>
}

export function memoryKV(): MemoryKV {
  const map = new Map<string, string>()
  const kv: MemoryKV = {
    map,
    failWrites: false,
    ops: [],
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (kv.failWrites) throw new Error('QuotaExceededError')
      map.set(k, v)
      kv.ops.push({ op: 'set', key: k })
    },
    removeItem: (k: string) => {
      map.delete(k)
      kv.ops.push({ op: 'remove', key: k })
    },
  }
  return kv
}

/** Put records on the device as an EARLIER editor would have left them. */
export function writeJournal(
  kv: KV,
  packId: string,
  drafts: CaptionDrafts,
  orphans: CaptionOrphans = {},
  editIdPrefix = 'earlier',
): void {
  for (const [photoId, e] of Object.entries(drafts)) {
    const editId = e.editId ?? `${editIdPrefix}-${photoId}`
    kv.setItem(captionEditKey(packId, photoId, editId), JSON.stringify(entryToStored(photoId, editId, e)))
  }
  for (const [editId, o] of Object.entries(orphans)) {
    kv.setItem(captionEditKey(packId, o.photoId, editId), JSON.stringify(orphanToStored(editId, o)))
  }
}

/** Keys of this pack's journal currently on the device. */
export function journalKeys(kv: MemoryKV, packId: string): string[] {
  return [...kv.map.keys()].filter((k) => k.startsWith(`pack-captions:v2:${packId}:`)).sort()
}
