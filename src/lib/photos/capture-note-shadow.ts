/**
 * CAPTURE CAPTION SHADOW (P0, 22 Oct 2026; rev 4, 26 Oct after independent
 * review).
 *
 * The IndexedDB caption write is asynchronous and (in the capture UI)
 * debounced — a phone can terminate the page inside that window. Every input
 * event therefore SYNCHRONOUSLY writes a small shadow record to localStorage
 * (durable the moment the call returns), which is later reconciled into the
 * photo's IndexedDB queue record.
 *
 * REV 4 — ORDERING AND IDENTITY THAT SURVIVE REMOUNTS, TABS AND CLOCKS:
 *   - every edit carries a version AND a unique `editId`;
 *   - versions are allocated against a PERSISTED per-photo HIGH-WATER MARK in
 *     localStorage (never cleared by reconcile), so a remounted keeper, a
 *     second tab, or a clock that went backwards still allocates a version
 *     strictly above every version this device has issued for the photo;
 *   - PROOF IS IDENTITY: a shadow is satisfied ONLY when the durable record
 *     holds exactly its editId, version and text. A larger durable version
 *     with different text is NEVER proof;
 *   - a shadow is cleared ONLY by the identity that wrote it — a stale async
 *     completion for an older edit can never clear a newer shadow;
 *   - when ordering cannot be proven (e.g. two tabs allocate the same version
 *     in the same instant, or device storage was wiped while IndexedDB kept a
 *     newer record), the decision is refused: the shadow is KEPT and the
 *     photo's attach is BLOCKED. Text is never discarded to resolve doubt;
 *   - a failed localStorage write returns false so the UI shows the caption
 *     is NOT yet safe.
 */

import { canonicalCaptionOrNull } from './caption-canonical'

export type NoteShadow = {
  photoId: string
  note: string | null
  /** Monotonic version — same domain as QueuedPhotoMeta.noteEditedAt. */
  v: number
  /** Unique identity of this exact edit. */
  editId: string
  userId: string
  companyId: string
  propertyId: string
}

export type ShadowStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
  readonly length: number
}

const PREFIX = 'pack-capture-note:v2:'
const HWM_PREFIX = 'pack-capture-note-hwm:v1:'

export function shadowKey(packId: string, photoId: string): string {
  return `${PREFIX}${packId}:${photoId}`
}

function hwmKey(packId: string, photoId: string): string {
  return `${HWM_PREFIX}${packId}:${photoId}`
}

function defaultStorage(): ShadowStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}

/** A fresh, unique edit identity. */
export function newEditId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    if (c?.randomUUID) return c.randomUUID()
  } catch {
    // fall through
  }
  return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`
}

/** Strictly greater than `previous`, never below the clock. */
export function nextNoteVersion(previous: number | undefined, nowMs: number): number {
  return Math.max(nowMs, (previous ?? 0) + 1)
}

/** Persisted per-photo high-water mark (0 when absent/unreadable). */
export function readHighWater(
  packId: string,
  photoId: string,
  storage: ShadowStorage | null = defaultStorage(),
): number {
  if (!storage) return 0
  try {
    const n = Number(storage.getItem(hwmKey(packId, photoId)))
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/** Raise (never lower) the persisted high-water mark. */
export function bumpHighWater(
  packId: string,
  photoId: string,
  v: number,
  storage: ShadowStorage | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    if (v > readHighWater(packId, photoId, storage)) {
      storage.setItem(hwmKey(packId, photoId), String(v))
    }
  } catch {
    // best-effort: a lost mark only makes ordering unprovable (fail closed)
  }
}

/**
 * Allocate the next version for a photo: strictly above BOTH the persisted
 * high-water mark (survives remounts, shared across tabs, immune to clock
 * rollback) and any in-memory value, and never below the clock. The new
 * mark is persisted synchronously before returning.
 */
export function allocateNoteVersion(
  packId: string,
  photoId: string,
  nowMs: number,
  inMemory: number | undefined,
  storage: ShadowStorage | null = defaultStorage(),
): number {
  const floor = Math.max(readHighWater(packId, photoId, storage), inMemory ?? 0)
  const v = nextNoteVersion(floor, nowMs)
  bumpHighWater(packId, photoId, v, storage)
  return v
}

/** SYNCHRONOUS durable write. Returns false when the device refused it —
 *  the caller must surface that the caption is not yet safe. */
export function writeNoteShadow(
  packId: string,
  shadow: NoteShadow,
  storage: ShadowStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false
  try {
    storage.setItem(shadowKey(packId, shadow.photoId), JSON.stringify(shadow))
    return true
  } catch {
    return false
  }
}

function parseShadow(raw: string | null): NoteShadow | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as NoteShadow
    if (
      parsed &&
      typeof parsed.photoId === 'string' &&
      typeof parsed.v === 'number' &&
      typeof parsed.editId === 'string' &&
      parsed.editId.length > 0 &&
      (parsed.note === null || typeof parsed.note === 'string') &&
      typeof parsed.userId === 'string' &&
      typeof parsed.companyId === 'string' &&
      typeof parsed.propertyId === 'string'
    ) {
      return parsed
    }
  } catch {
    // corrupt
  }
  return null
}

export function readNoteShadow(
  packId: string,
  photoId: string,
  storage: ShadowStorage | null = defaultStorage(),
): NoteShadow | null {
  if (!storage) return null
  try {
    return parseShadow(storage.getItem(shadowKey(packId, photoId)))
  } catch {
    return null
  }
}

export function readNoteShadows(
  packId: string,
  storage: ShadowStorage | null = defaultStorage(),
): NoteShadow[] {
  if (!storage) return []
  const out: NoteShadow[] = []
  try {
    const prefix = `${PREFIX}${packId}:`
    const keys: string[] = []
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i)
      if (k && k.startsWith(prefix)) keys.push(k)
    }
    for (const k of keys) {
      try {
        const s = parseShadow(storage.getItem(k))
        if (s) out.push(s) // one corrupt shadow never blocks the others
      } catch {
        // skip
      }
    }
  } catch {
    return out
  }
  return out
}

/**
 * Clear a photo's shadow ONLY if it is still exactly the edit `editId` —
 * the identity that was proven durable. A newer shadow (different id) is
 * never touched, so a stale async completion cannot clear the current one.
 */
export function clearNoteShadowIfIdentity(
  packId: string,
  photoId: string,
  editId: string | null | undefined,
  storage: ShadowStorage | null = defaultStorage(),
): void {
  if (!storage || !editId) return
  try {
    const key = shadowKey(packId, photoId)
    const current = parseShadow(storage.getItem(key))
    if (current && current.editId === editId) storage.removeItem(key)
  } catch {
    // best-effort
  }
}

/** Unconditional removal — ONLY for an inspector-discarded photo. */
export function removeNoteShadow(
  packId: string,
  photoId: string,
  storage: ShadowStorage | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.removeItem(shadowKey(packId, photoId))
  } catch {
    // best-effort
  }
}

/**
 * PROOF PREDICATE (rev 4): the durable record holds EXACTLY this edit —
 * same identity, same version, same text. Nothing else is proof: not a
 * larger version, not a refused claim, not a missing record.
 */
export function shadowSatisfied(
  record: { note: string | null; noteEditedAt?: number | null; noteEditId?: string | null },
  shadow: Pick<NoteShadow, 'note' | 'v' | 'editId'>,
): boolean {
  return (
    (record.noteEditId ?? null) === shadow.editId &&
    (record.noteEditedAt ?? 0) === shadow.v &&
    (record.note ?? null) === (shadow.note ?? null)
  )
}

/** Shadow scope must match the queue record exactly before it may apply. */
export function shadowScopeMatches(
  record: { packId: string; userId: string; companyId: string; propertyId: string },
  shadow: Pick<NoteShadow, 'userId' | 'companyId' | 'propertyId'>,
  packId: string,
): boolean {
  return (
    record.packId === packId &&
    record.userId === shadow.userId &&
    record.companyId === shadow.companyId &&
    record.propertyId === shadow.propertyId
  )
}

// ----------------------------------------------------------------
// High-water-mark lifecycle (rev 5).
// ----------------------------------------------------------------

/** Unconditional removal of the mark — ONLY for an inspector-discarded photo. */
export function removeHighWater(
  packId: string,
  photoId: string,
  storage: ShadowStorage | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.removeItem(hwmKey(packId, photoId))
  } catch {
    // best-effort
  }
}

/**
 * After an AUTHORITATIVE attach of `attachedVersion`, the photo's mark is
 * spent — unless anything newer may still be unresolved: any remaining
 * shadow, or a mark above the attached version (a later allocation whose
 * shadow may have failed to write). In those cases the mark is KEPT.
 * Returns true when the mark was removed.
 */
export function clearHighWaterIfSettled(
  packId: string,
  photoId: string,
  attachedVersion: number,
  storage: ShadowStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false
  if (readNoteShadow(packId, photoId, storage)) return false
  if (readHighWater(packId, photoId, storage) > attachedVersion) return false
  removeHighWater(packId, photoId, storage)
  return true
}

// ----------------------------------------------------------------
// "Note for all photos" — durable batch fallback caption (rev 5).
// ----------------------------------------------------------------

const BATCH_PREFIX = 'pack-capture-batch-note:v1:'

function batchKey(packId: string): string {
  return `${BATCH_PREFIX}${packId}`
}

/** The persisted batch note for a pack (null when none / unreadable). */
export function readBatchNote(
  packId: string,
  storage: ShadowStorage | null = defaultStorage(),
): string | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(batchKey(packId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { note?: unknown }
    return typeof parsed?.note === 'string' ? parsed.note : null
  } catch {
    return null
  }
}

/** SYNCHRONOUS durable write ('' / null removes it). False = not durable. */
export function writeBatchNote(
  packId: string,
  note: string | null,
  storage: ShadowStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false
  try {
    if (note === null || note === '') storage.removeItem(batchKey(packId))
    else storage.setItem(batchKey(packId), JSON.stringify({ note }))
    return true
  } catch {
    return false
  }
}

/** Pseudo photo id under which an unsafe batch-note write is reported. */
export const BATCH_NOTE_UNSAFE_ID = '__batch_note__'

// ----------------------------------------------------------------
// CaptureNoteKeeper — the capture screen's caption durability engine.
// Headless + dependency-injected so the timing guarantees are provable
// without a DOM.
// ----------------------------------------------------------------

type KeeperDeps = {
  packId: string
  scope: { userId: string; companyId: string; propertyId: string }
  /** Injectable device storage (tests); defaults to localStorage. */
  storage?: ShadowStorage | null
  /** Durable IndexedDB write (updateQueuedNote). Resolves true only when the
   *  record provably holds EXACTLY this edit (identity). */
  persistToQueue: (
    packId: string,
    photoId: string,
    note: string | null,
    version: number,
    editId: string,
  ) => Promise<boolean>
  onUnsafeChange: (unsafeIds: ReadonlySet<string>) => void
  now?: () => number
  makeEditId?: () => string
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (t: ReturnType<typeof setTimeout>) => void
  debounceMs?: number
}

export const CAPTURE_NOTE_DEBOUNCE_MS = 300

export class CaptureNoteKeeper {
  /** In-memory floor only — the persisted high-water mark is authoritative. */
  private readonly versions = new Map<string, number>()
  /** The latest edit identity THIS keeper issued per photo. */
  private readonly latest = new Map<string, string>()
  private readonly unsafe = new Set<string>()
  /** Each known photo's EXPLICIT caption (null = blank: inherits the batch note). */
  private readonly explicit = new Map<string, string | null>()
  /** The durable "Note for all photos" fallback (canonical; null = none). */
  private batchNote: string | null
  private readonly timers = new Map<
    string,
    { t: ReturnType<typeof setTimeout>; write: () => void }
  >()
  private readonly deps: Required<Omit<KeeperDeps, 'storage'>> & { storage: ShadowStorage | null }

  constructor(deps: KeeperDeps) {
    this.deps = {
      packId: deps.packId,
      scope: deps.scope,
      storage: deps.storage === undefined ? defaultStorage() : deps.storage,
      persistToQueue: deps.persistToQueue,
      onUnsafeChange: deps.onUnsafeChange,
      now: deps.now ?? (() => Date.now()),
      makeEditId: deps.makeEditId ?? newEditId,
      setTimeoutFn: deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeoutFn: deps.clearTimeoutFn ?? ((t) => clearTimeout(t)),
      debounceMs: deps.debounceMs ?? CAPTURE_NOTE_DEBOUNCE_MS,
    }
    // A remounted keeper (reopen after a kill) restores the batch note.
    this.batchNote = canonicalCaptionOrNull(readBatchNote(deps.packId, this.deps.storage))
  }

  /** Allocate the next version for a photo against the PERSISTED mark. */
  nextVersion(photoId: string): number {
    const v = allocateNoteVersion(
      this.deps.packId,
      photoId,
      this.deps.now(),
      this.versions.get(photoId),
      this.deps.storage,
    )
    this.versions.set(photoId, v)
    return v
  }

  isUnsafe(photoId: string): boolean {
    return this.unsafe.has(photoId)
  }

  /** A keystroke on a photo's OWN caption. The EFFECTIVE caption (own, or
   *  the batch note when own is blank) is shadowed SYNCHRONOUSLY. */
  change(photoId: string, text: string): void {
    this.explicit.set(photoId, canonicalCaptionOrNull(text))
    this.record(photoId, this.effective(photoId), false)
  }

  /** Blur: the caller passes the textarea's CURRENT DOM value. Persisted to
   *  IndexedDB immediately. */
  blur(photoId: string, currentValue: string): void {
    this.explicit.set(photoId, canonicalCaptionOrNull(currentValue))
    this.record(photoId, this.effective(photoId), true)
  }

  /**
   * A photo was just captured and its queue record exists. It has no own
   * caption yet, so it INHERITS the current batch note — durably, at once —
   * which is what makes "photos captured after the batch note was entered"
   * carry it even if the app dies before Attach.
   */
  registerPhoto(photoId: string): void {
    if (!this.explicit.has(photoId)) this.explicit.set(photoId, null)
    if (this.explicit.get(photoId) === null && this.batchNote !== null) {
      this.record(photoId, this.batchNote, true)
    }
  }

  /** The current batch note (restored after a remount). */
  getBatchNote(): string {
    return this.batchNote ?? ''
  }

  /**
   * "Note for all photos" changed. Durable FIRST (synchronous localStorage),
   * then propagated as a new caption EDIT to every known photo whose own
   * caption is blank — so the fallback survives a kill before Attach, and
   * CLEARING it is equally durable (those photos get a blank edit). Photos
   * with an explicit caption are never touched.
   */
  setBatchNote(text: string): void {
    const note = canonicalCaptionOrNull(text)
    const ok = writeBatchNote(this.deps.packId, note, this.deps.storage)
    this.batchNote = note
    this.setUnsafe(BATCH_NOTE_UNSAFE_ID, !ok)
    for (const [photoId, own] of this.explicit) {
      if (own === null) this.record(photoId, note, false)
    }
  }

  /** The capture session ended: its fallback now lives in the photos'
   *  records, so the pack-level key is removed WITHOUT touching photos. */
  forgetBatchNote(): void {
    writeBatchNote(this.deps.packId, null, this.deps.storage)
    this.batchNote = null
    this.explicit.clear()
    this.setUnsafe(BATCH_NOTE_UNSAFE_ID, false)
  }

  /**
   * The Attach/release tap. Each released caption becomes an EDIT in its own
   * right: a fresh version (above every earlier edit), a fresh identity, and
   * a synchronous shadow — so the release's caption is provable end to end
   * and a stale debounce can never win afterwards.
   */
  prepareRelease(
    notesById: Record<string, string | null>,
  ): Record<string, { v: number; editId: string }> {
    const out: Record<string, { v: number; editId: string }> = {}
    for (const [photoId, rawNote] of Object.entries(notesById)) {
      // Canonical form — exactly what releaseDecision stores for this edit.
      const note = canonicalCaptionOrNull(rawNote)
      const t = this.timers.get(photoId)
      if (t) {
        this.deps.clearTimeoutFn(t.t) // superseded by the release edit
        this.timers.delete(photoId)
      }
      const v = this.nextVersion(photoId)
      const editId = this.deps.makeEditId()
      this.latest.set(photoId, editId)
      const ok = writeNoteShadow(
        this.deps.packId,
        { photoId, note, v, editId, ...this.deps.scope },
        this.deps.storage,
      )
      this.setUnsafe(photoId, !ok)
      out[photoId] = { v, editId }
    }
    return out
  }

  /**
   * Release with an EXPLICIT durability outcome (rev 5, item 4). Each release
   * caption must be durable BEFORE the release may proceed: its synchronous
   * shadow, or — when device storage refused the shadow — a completed,
   * identity-proven IndexedDB write. `ok: false` means the caller must NOT
   * release (nothing is claimed safe merely because a release started).
   */
  async secureRelease(notesById: Record<string, string | null>): Promise<{
    ok: boolean
    edits: Record<string, { v: number; editId: string }>
    unsafeIds: string[]
  }> {
    const edits = this.prepareRelease(notesById)
    const unsafeIds: string[] = []
    for (const [photoId, edit] of Object.entries(edits)) {
      if (!this.unsafe.has(photoId)) continue // shadow-durable
      let proven = false
      try {
        proven = await this.deps.persistToQueue(
          this.deps.packId,
          photoId,
          canonicalCaptionOrNull(notesById[photoId]),
          edit.v,
          edit.editId,
        )
      } catch {
        proven = false
      }
      if (proven && this.latest.get(photoId) === edit.editId) this.setUnsafe(photoId, false)
      else unsafeIds.push(photoId)
    }
    return { ok: unsafeIds.length === 0, edits, unsafeIds }
  }

  /** Unmount: pending debounced IndexedDB writes are FLUSHED, not dropped. */
  dispose(): void {
    const pending = [...this.timers.values()]
    this.timers.clear()
    for (const p of pending) {
      this.deps.clearTimeoutFn(p.t)
      p.write()
    }
  }

  // ----------------------------------------------------------------

  /** Own caption, else the batch note (both canonical). */
  private effective(photoId: string): string | null {
    return this.explicit.get(photoId) ?? this.batchNote
  }

  private record(photoId: string, text: string | null, immediate: boolean): void {
    const v = this.nextVersion(photoId)
    const editId = this.deps.makeEditId()
    this.latest.set(photoId, editId)
    const note = canonicalCaptionOrNull(text)
    // (1) SYNCHRONOUS durable shadow — the primary guarantee.
    const ok = writeNoteShadow(
      this.deps.packId,
      { photoId, note, v, editId, ...this.deps.scope },
      this.deps.storage,
    )
    this.setUnsafe(photoId, !ok)
    // (2) IndexedDB reconcile: debounced, or immediate on blur.
    const existing = this.timers.get(photoId)
    if (existing) this.deps.clearTimeoutFn(existing.t)
    this.timers.delete(photoId)
    const write = () => {
      this.timers.delete(photoId)
      void this.deps.persistToQueue(this.deps.packId, photoId, note, v, editId).then(
        (durable) => {
          // Only a durable write of the LATEST edit identity may clear the
          // warning — an older success can never vouch for a newer edit.
          if (durable && this.latest.get(photoId) === editId) this.setUnsafe(photoId, false)
        },
        () => {
          // persist failure: the warning (if any) stays
        },
      )
    }
    if (immediate) write()
    else this.timers.set(photoId, { t: this.deps.setTimeoutFn(write, this.deps.debounceMs), write })
  }

  private setUnsafe(photoId: string, unsafe: boolean): void {
    const had = this.unsafe.has(photoId)
    if (unsafe === had) return
    if (unsafe) this.unsafe.add(photoId)
    else this.unsafe.delete(photoId)
    this.deps.onUnsafeChange(new Set(this.unsafe))
  }
}
