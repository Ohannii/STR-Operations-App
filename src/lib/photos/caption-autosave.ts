/**
 * Caption autosave controller (P0, 22 Oct 2026; rev 3, 23 Oct). Headless and
 * dependency-injected so the debounce / coalescing / bounded-retry /
 * flush-before-submit / conflict guarantees are provable with fake timers —
 * no DOM required.
 *
 * TRUTHFULNESS CONTRACT:
 *   - every edit is persisted to DEVICE storage synchronously (caption-drafts)
 *     BEFORE any debounce wait;
 *   - 'saved' is shown ONLY after the server acknowledged exactly the text on
 *     screen (latest-edit-wins lives in caption-drafts.markSaved);
 *   - errors never clear a draft; retry is bounded, then the state is an
 *     honest 'error';
 *   - CONFLICTS (rev 3): a server refusal of a stale write — or a draft whose
 *     baseline no longer matches the server after a refresh — becomes a
 *     persisted 'conflict' that is never autosaved and blocks submission
 *     until the user explicitly keeps theirs or takes the server's;
 *   - FREEZE (rev 3): while a submission is in flight, edits are refused, so
 *     nothing typed after the submitted snapshot can be silently dropped;
 *   - Strict Mode (rev 3): seed() re-activates a controller a prior effect
 *     cleanup disposed;
 *   - GENERATIONS (rev 6): every seed() and dispose() starts a new
 *     generation. A save that completes for a disposed or superseded
 *     generation changes NOTHING — no drafts, conflicts, retry state or
 *     storage. Its only effect is to release the per-photo single-flight slot
 *     and resume the CURRENT generation's dirty caption;
 *   - DEVICE JOURNAL (rev 6): each draft is stored under its own edit
 *     identity (caption-drafts). This controller writes/removes only the
 *     identities it minted in its current generation; foreign records are
 *     ADOPTED (copied under a fresh identity, then compare-and-removed), so
 *     two live editors can never overwrite or clear each other's text.
 */

import {
  acknowledgeSubmitted,
  applyEdit,
  conflictIds,
  dirtyIds,
  isConflict,
  isDirty,
  markConflict,
  markSaved,
  captionEditKey,
  defaultKV,
  entryToStored,
  mergeJournal,
  orphanToStored,
  readJournal,
  reconcileManifest,
  removeIfUnchanged,
  removedUnsynced,
  type CaptionOrphans,
  type JournalRecord,
  type KV,
  resolveKeepMine,
  resolveUseServer,
  seedDrafts,
  serverText,
  type CaptionDrafts,
} from './caption-drafts'
import { canonicalCaption } from './caption-canonical'

export type CaptionSaveResult =
  | { ok: true }
  /** The server holds DIFFERENT text than this client believed (another
   *  tab/device wrote it). The database refused the write (compare-and-set);
   *  the local draft is preserved as a conflict. `serverNotes` is the
   *  server's current caption when it could be read (undefined = unknown). */
  | { ok: false; code: 'stale'; error: string; serverNotes?: string | null }
  | { ok: false; code?: undefined; error: string; retryable: boolean }

export type CaptionPhotoStatus = 'clean' | 'dirty' | 'saving' | 'offline' | 'error' | 'conflict'

export type CaptionPageStatus = {
  /** True while anything is not confirmed server-side. Blocks submission. */
  blocking: boolean
  saving: number
  dirty: number
  failed: number
  conflicts: number
  offline: boolean
  /** False when device storage is unusable — the UI must not say "saved on device". */
  deviceDurable: boolean
}

/** One manifest entry for save-and-submit: the caption to save and the
 *  server BASELINE it was written against (compare-and-set in the RPC). */
export type SubmitManifestEntry = { photoId: string; note: string; expected: string }

export const CAPTION_DEBOUNCE_MS = 800
export const CAPTION_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000]
export const CAPTION_MAX_ATTEMPTS = CAPTION_RETRY_DELAYS_MS.length + 1

type Deps = {
  packId: string
  /**
   * Server autosave for ONE caption. Must resolve (never throw).
   * `expected` is MANDATORY (rev 4): what this client believes the server
   * currently holds. The database ALWAYS compare-and-sets against it — there
   * is no way to request a blind overwrite.
   */
  save: (photoId: string, note: string, expected: string) => Promise<CaptionSaveResult>
  onChange: () => void
  now?: () => number
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (t: ReturnType<typeof setTimeout>) => void
  isOnline?: () => boolean
  /** Device storage; defaults to window.localStorage (resolved lazily, so a
   *  server render never captures a null store). null = no device storage. */
  kv?: KV | null
  /** Mints a fresh edit identity. Injectable for deterministic tests. */
  newEditId?: () => string
}

function defaultEditId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export class CaptionAutosave {
  private drafts: CaptionDrafts = {}
  /** Unsynced text of photos no longer in the pack — never silently dropped. */
  private orphans: CaptionOrphans = {}
  private readonly deps: Required<Omit<Deps, 'packId' | 'kv'>> & {
    packId: string
    kv: KV | null | undefined
  }
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Outstanding server saves, ONE per photo ACROSS generations (a request
   * from a superseded generation is still a real request on the wire, so the
   * next save for that photo waits for it to settle — single-flight holds).
   */
  private inFlight = new Map<string, { gen: number; promise: Promise<void> }>()
  /** Lifecycle identity: bumped by every seed() and dispose(). */
  private generation = 0
  /** Journal keys this generation wrote -> the exact bytes written. */
  private written = new Map<string, string>()
  private attempts = new Map<string, number>()
  private exhausted = new Set<string>()
  private deviceDurable = true
  private disposed = false
  private frozen = false

  constructor(deps: Deps) {
    this.deps = {
      packId: deps.packId,
      save: deps.save,
      onChange: deps.onChange,
      now: deps.now ?? (() => Date.now()),
      setTimeoutFn: deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeoutFn: deps.clearTimeoutFn ?? ((t) => clearTimeout(t)),
      isOnline: deps.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine)),
      kv: deps.kv,
      newEditId: deps.newEditId ?? defaultEditId,
    }
  }

  /**
   * Seed against the server captions and THIS DEVICE's caption journal.
   * Starts a NEW GENERATION: everything the previous generation had pending
   * (timers, retry budgets, its journal keys) is no longer this controller's
   * concern, and any of its saves that complete later are ignored.
   * Also RE-ACTIVATES a controller an earlier effect cleanup disposed (React
   * Strict Mode runs setup -> cleanup -> setup on the same memo).
   */
  seed(serverNotes: Record<string, string | null>): void {
    this.startGeneration()
    this.disposed = false
    this.drafts = {}
    this.orphans = {}
    this.adopt(readJournal(this.deps.packId, this.kv()), serverNotes)
    if (dirtyIds(this.drafts).length > 0) this.scheduleFlush()
    this.deps.onChange()
  }

  /** The current lifecycle identity (exposed for tests/diagnostics). */
  currentGeneration(): number {
    return this.generation
  }

  /** A keystroke: device-durable FIRST, then debounce the server write.
   *  Returns false (and changes nothing) while a submission is in flight. */
  edit(photoId: string, text: string): boolean {
    if (this.frozen) return false
    this.drafts = applyEdit(this.drafts, photoId, text, this.deps.now())
    this.exhausted.delete(photoId) // a human edit earns a fresh retry budget
    this.attempts.delete(photoId)
    this.persistNow()
    this.scheduleFlush()
    this.deps.onChange()
    return true
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen
    this.deps.onChange()
  }

  isFrozen(): boolean {
    return this.frozen
  }

  textFor(photoId: string): string {
    return this.drafts[photoId]?.text ?? ''
  }

  /** Current server text for a conflicted photo (null = unknown; undefined =
   *  no conflict). */
  conflictServerFor(photoId: string): string | null | undefined {
    return this.drafts[photoId]?.conflictServer
  }

  statusFor(photoId: string): CaptionPhotoStatus {
    const entry = this.drafts[photoId]
    if (!entry) return 'clean'
    if (isConflict(entry)) return 'conflict'
    if (!isDirty(entry)) return 'clean'
    if (this.inFlight.has(photoId)) return 'saving'
    if (this.exhausted.has(photoId)) return 'error'
    if (!this.deps.isOnline()) return 'offline'
    return 'dirty'
  }

  pageStatus(): CaptionPageStatus {
    let saving = 0
    let dirty = 0
    let failed = 0
    let conflicts = 0
    for (const id of Object.keys(this.drafts)) {
      const s = this.statusFor(id)
      if (s === 'saving') saving += 1
      else if (s === 'dirty' || s === 'offline') dirty += 1
      else if (s === 'error') failed += 1
      else if (s === 'conflict') conflicts += 1
    }
    return {
      blocking: saving + dirty + failed + conflicts > 0,
      saving,
      dirty,
      failed,
      conflicts,
      offline: !this.deps.isOnline() && dirty > 0,
      deviceDurable: this.deviceDurable,
    }
  }

  /** Explicit choice: keep my caption. It becomes dirty against the
   *  server's current text and is autosaved with that as the CAS baseline. */
  keepMine(photoId: string): void {
    if (this.frozen) return
    this.drafts = resolveKeepMine(this.drafts, photoId)
    this.exhausted.delete(photoId)
    this.persistNow()
    this.scheduleFlush(0)
    this.deps.onChange()
  }

  /** Explicit choice: take the server's caption (mine discarded by choice). */
  takeServerVersion(photoId: string): void {
    if (this.frozen) return
    this.drafts = resolveUseServer(this.drafts, photoId, this.deps.now())
    this.exhausted.delete(photoId)
    this.persistNow()
    this.deps.onChange()
  }

  /** Mark photos conflicted after a submit-time manifest mismatch. */
  markConflicts(conflicts: ReadonlyArray<{ photoId: string; serverNotes: string | null }>): void {
    for (const c of conflicts) {
      this.drafts = markConflict(this.drafts, c.photoId, serverText(c.serverNotes))
    }
    this.persistNow()
    this.deps.onChange()
  }

  /**
   * MANIFEST CHANGE (rev 4/5): the server's manifest for this pack changed
   * while the editor stayed mounted — photos removed/added, or the SAME
   * photos with a changed server caption. Absent ids leave the submit
   * manifest, but their unsynced text moves to the ORPHAN backup (kept until
   * an explicit discard); new ids are seeded; clean survivors adopt a changed
   * server caption; dirty/conflicted survivors are preserved. Any in-flight
   * save for a removed photo resolves harmlessly against a missing entry.
   * Returns true when the editor's state actually changed.
   */
  reconcileManifest(serverNotes: Record<string, string | null>): boolean {
    const fingerprint = () =>
      Object.keys(this.drafts)
        .sort()
        .map((id) => `${id}\u0000${this.drafts[id].text}\u0000${this.drafts[id].savedText ?? ''}`)
        .join('\u0001')
    const before = fingerprint()
    this.orphans = { ...this.orphans, ...removedUnsynced(this.drafts, serverNotes, this.deps.now()) }
    // Photos NEW to this editor may have a device draft from another editor
    // (foreign journal records): adopt those, never anything this
    // generation itself wrote.
    const newIds = Object.keys(serverNotes).filter((id) => !(id in this.drafts))
    const foreign = readJournal(this.deps.packId, this.kv()).filter(
      (r) => !this.written.has(r.key) && newIds.includes(r.edit.photoId),
    )
    const newNotes: Record<string, string | null> = {}
    for (const id of newIds) newNotes[id] = serverNotes[id]
    const adopted = this.adoptable(foreign, newNotes)
    this.drafts = reconcileManifest(this.drafts, serverNotes, adopted.entries)
    this.orphans = { ...this.orphans, ...adopted.orphans }
    for (const id of [...this.exhausted]) if (!(id in this.drafts)) this.exhausted.delete(id)
    for (const id of [...this.attempts.keys()]) if (!(id in this.drafts)) this.attempts.delete(id)
    this.persistNow()
    if (this.deviceDurable) for (const r of foreign) removeIfUnchanged(this.kv(), r.key, r.raw)
    if (dirtyIds(this.drafts).length > 0) this.scheduleFlush()
    this.deps.onChange()
    return before !== fingerprint()
  }

  /** Orphaned (removed-photo) captions awaiting the inspector's decision. */
  getOrphans(): CaptionOrphans {
    return { ...this.orphans }
  }

  /** EXPLICIT inspector action: discard the orphan backups (after copying). */
  discardOrphans(): void {
    this.orphans = {}
    this.persistNow()
    this.deps.onChange()
  }

  /** Connectivity returned: resume syncing immediately. */
  notifyOnline(): void {
    if (this.disposed) return
    this.scheduleFlush(0)
    this.deps.onChange()
  }

  /**
   * Flush EVERYTHING now and wait for the outcome. Resolves true ONLY when
   * every caption is server-confirmed and nothing is conflicted — callers
   * must not submit otherwise.
   */
  async flushAll(): Promise<boolean> {
    this.cancelDebounce()
    this.exhausted.clear() // submit/retry is an explicit retry
    // A save still outstanding from a superseded generation blocks its photo
    // (single-flight); once it settles, this generation's text is sent.
    for (let pass = 0; pass < 3; pass += 1) {
      await this.runFlush()
      const pending = [...this.inFlight.values()].map((f) => f.promise)
      if (pending.length === 0) break
      await Promise.all(pending)
    }
    this.cancelDebounce() // the passes above already did that work
    return dirtyIds(this.drafts).length === 0 && conflictIds(this.drafts).length === 0
  }

  /** The COMPLETE manifest for save-and-submit, with each caption's server
   *  baseline so the database can compare-and-set the whole set atomically. */
  snapshotForSubmit(): SubmitManifestEntry[] {
    return Object.entries(this.drafts).map(([photoId, e]) => ({
      photoId,
      note: canonicalCaption(e.text),
      expected: canonicalCaption(e.savedText),
    }))
  }

  /** Plain caption list for the user's own backup copy. */
  snapshotAll(): Array<{ photoId: string; note: string }> {
    return Object.entries(this.drafts).map(([photoId, e]) => ({
      photoId,
      note: canonicalCaption(e.text),
    }))
  }

  /**
   * The server confirmed `snapshot`. Entries still equal to it become clean;
   * anything newer stays dirty and on the device. Returns the ids still
   * holding unsubmitted local text (empty in the normal, frozen case).
   */
  acknowledgeSubmitted(snapshot: ReadonlyArray<{ photoId: string; note: string }>): string[] {
    this.drafts = acknowledgeSubmitted(this.drafts, snapshot)
    this.persistNow()
    this.deps.onChange()
    return Object.keys(this.drafts).filter(
      (id) => isDirty(this.drafts[id]) || isConflict(this.drafts[id]),
    )
  }

  dispose(): void {
    this.disposed = true
    this.startGeneration() // anything still pending belongs to a dead generation
  }

  // ----------------------------------------------------------------

  private kv(): KV | null {
    return this.deps.kv !== undefined ? this.deps.kv : defaultKV()
  }

  private startGeneration(): void {
    this.generation += 1
    this.cancelDebounce()
    if (this.retryTimer) {
      this.deps.clearTimeoutFn(this.retryTimer)
      this.retryTimer = null
    }
    this.attempts = new Map()
    this.exhausted = new Set()
    // The new generation owns NO keys yet. The previous generation's records
    // stay on the device until a seed adopts them (compare-and-remove).
    this.written = new Map()
  }

  /**
   * Turn journal records into this generation's state under FRESH edit
   * identities (the source identities belong to whoever wrote them).
   */
  private adoptable(
    records: ReadonlyArray<JournalRecord>,
    serverNotes: Record<string, string | null>,
  ): { entries: CaptionDrafts; orphans: CaptionOrphans } {
    const view = mergeJournal(records, serverNotes, this.deps.now())
    const entries: CaptionDrafts = {}
    for (const [photoId, e] of Object.entries(view.entries)) {
      entries[photoId] = { ...e, editId: this.deps.newEditId() }
    }
    const orphans: CaptionOrphans = {}
    for (const o of Object.values(view.orphans)) orphans[this.deps.newEditId()] = o
    return { entries, orphans }
  }

  /** Seed-time adoption: own copies are written FIRST; only then are the
   *  exact source records compare-and-removed. */
  private adopt(records: ReadonlyArray<JournalRecord>, serverNotes: Record<string, string | null>): void {
    const adopted = this.adoptable(records, serverNotes)
    this.drafts = seedDrafts(adopted.entries, serverNotes)
    this.orphans = adopted.orphans
    this.persistNow()
    if (!this.deviceDurable) return // copies not durable: keep every source
    for (const r of records) removeIfUnchanged(this.kv(), r.key, r.raw)
  }

  /**
   * Sync THIS generation's journal records: write each unsynced entry and
   * orphan under its own edit identity; remove only keys this generation
   * wrote that are no longer needed. Never touches any other key.
   */
  private persistNow(): void {
    const kv = this.kv()
    const want = new Map<string, string>()
    const next: CaptionDrafts = {}
    for (const [photoId, e0] of Object.entries(this.drafts)) {
      let e = e0
      if (isDirty(e) || isConflict(e)) {
        if (e.editId === undefined) e = { ...e, editId: this.deps.newEditId() }
        want.set(
          captionEditKey(this.deps.packId, photoId, e.editId as string),
          JSON.stringify(entryToStored(photoId, e.editId as string, e)),
        )
      }
      next[photoId] = e
    }
    this.drafts = next
    for (const [editId, o] of Object.entries(this.orphans)) {
      want.set(
        captionEditKey(this.deps.packId, o.photoId, editId),
        JSON.stringify(orphanToStored(editId, o)),
      )
    }
    if (!kv) {
      this.deviceDurable = false
      return
    }
    // STRICT TWO-PHASE REPLACEMENT (rev 6.1).
    // Phase 1: durably write EVERY desired record first.
    let ok = true
    const written = new Map<string, string>()
    for (const [key, raw] of want) {
      if (this.written.get(key) === raw) {
        written.set(key, raw)
        continue
      }
      try {
        kv.setItem(key, raw)
        written.set(key, raw)
      } catch {
        ok = false
      }
    }
    if (!ok) {
      // A required write failed: the newest text is NOT on the device. Remove
      // NOTHING — every previously owned record (possibly the last safe copy
      // of this caption) stays, and so does its ownership, so a later
      // successful persist can retire it. Keys that did get written are
      // tracked too (they are ours now).
      const retained = new Map(this.written)
      for (const [key, raw] of written) retained.set(key, raw)
      this.written = retained
      this.deviceDurable = false
      return
    }
    // Phase 2: only now retire OWN keys that are no longer needed.
    for (const key of this.written.keys()) {
      if (want.has(key)) continue
      try {
        kv.removeItem(key) // OWN key of this generation only
      } catch {
        written.set(key, this.written.get(key) as string) // keep ownership; retry later
      }
    }
    this.written = written
    this.deviceDurable = true
  }

  private cancelDebounce(): void {
    if (this.debounceTimer) {
      this.deps.clearTimeoutFn(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private scheduleFlush(delayMs: number = CAPTION_DEBOUNCE_MS): void {
    if (this.disposed) return
    this.cancelDebounce()
    this.debounceTimer = this.deps.setTimeoutFn(() => {
      this.debounceTimer = null
      void this.runFlush()
    }, delayMs)
  }

  private scheduleRetry(afterAttempts: number): void {
    if (this.disposed || this.retryTimer) return
    const delay =
      CAPTION_RETRY_DELAYS_MS[Math.min(afterAttempts - 1, CAPTION_RETRY_DELAYS_MS.length - 1)]
    this.retryTimer = this.deps.setTimeoutFn(() => {
      this.retryTimer = null
      void this.runFlush()
    }, delay)
  }

  /** Coalesced: saves every currently-dirty, non-conflicted caption (one
   *  request per photo, NOT per keystroke), max 3 in flight. */
  private async runFlush(): Promise<void> {
    if (this.disposed) return
    const gen = this.generation
    if (!this.deps.isOnline()) {
      this.deps.onChange()
      return
    }
    const ids = dirtyIds(this.drafts).filter(
      (id) => !this.inFlight.has(id) && !this.exhausted.has(id),
    )
    if (ids.length === 0) return
    const queue = [...ids]
    const worker = async (): Promise<void> => {
      for (;;) {
        if (gen !== this.generation) return // superseded: stop this flush
        const id = queue.shift()
        if (!id) return
        await this.saveOne(id, gen)
      }
    }
    const workers = Array.from({ length: Math.min(3, queue.length) }, () => worker())
    await Promise.all(workers)
    if (gen === this.generation) this.deps.onChange()
  }

  private async saveOne(photoId: string, gen: number): Promise<void> {
    if (gen !== this.generation) return
    const entry = this.drafts[photoId]
    if (!entry || !isDirty(entry) || isConflict(entry)) return
    const sentText = entry.text
    const sentEditedAt = entry.editedAt
    const sentEditId = entry.editId
    // SINGLE-FLIGHT ORDERING PROOF: runFlush filters out ids in `inFlight`,
    // and `inFlight` is only cleared in the finally below — so at most ONE
    // save per photo is ever outstanding, and the next one can only START
    // after this one has fully settled. Combined with the database CAS
    // (expected -> 'stale'), an out-of-order overwrite is impossible on both
    // layers.
    const expected = canonicalCaption(entry.savedText)
    const run = (async () => {
      const attempt = (this.attempts.get(photoId) ?? 0) + 1
      this.attempts.set(photoId, attempt)
      this.deps.onChange()
      const res = await this.deps.save(photoId, canonicalCaption(sentText), expected)
      // GENERATION GUARD (rev 6): a completion for a disposed or superseded
      // generation must not touch drafts, conflicts, retry state, UI state
      // or device storage — the current generation owns all of those.
      if (gen !== this.generation) return
      if (res.ok) {
        this.attempts.delete(photoId)
        // Clears ONLY the exact edit identity this request saved.
        this.drafts = markSaved(this.drafts, photoId, sentText, sentEditedAt, sentEditId)
        this.persistNow()
      } else if (res.code === 'stale' && this.drafts[photoId]?.editId !== sentEditId) {
        // The refusal concerns a different edit than the one now on screen;
        // that edit will compare-and-set on its own save.
        this.attempts.delete(photoId)
      } else if (res.code === 'stale') {
        // Another tab/device changed the server text. NEVER overwrite, never
        // drop the local draft: a PERSISTED conflict that survives refresh.
        this.attempts.delete(photoId)
        this.drafts = markConflict(
          this.drafts,
          photoId,
          res.serverNotes === undefined ? null : serverText(res.serverNotes),
        )
        this.persistNow()
      } else if (attempt >= CAPTION_MAX_ATTEMPTS || !res.retryable) {
        this.exhausted.add(photoId) // honest 'Could not save'; draft kept
      } else {
        this.scheduleRetry(attempt)
      }
      this.deps.onChange()
    })()
    this.inFlight.set(photoId, { gen, promise: run })
    try {
      await run
    } finally {
      if (this.inFlight.get(photoId)?.promise === run) this.inFlight.delete(photoId)
      const cur = this.drafts[photoId]
      const resumable =
        cur !== undefined && isDirty(cur) && !isConflict(cur) && !this.exhausted.has(photoId)
      if (gen !== this.generation) {
        // A SUPERSEDED generation's request settled. It changed nothing, but
        // it was holding this photo's single-flight slot: RESUME the CURRENT
        // generation's dirty caption now (unless this controller is disposed).
        if (!this.disposed) {
          if (resumable) this.scheduleFlush(0)
          this.deps.onChange()
        }
      } else if (resumable && cur.editedAt > sentEditedAt && !this.disposed) {
        // SETTLE-RECHAIN: newer text typed while this save was in flight is
        // sent now — strictly after the previous request settled.
        this.scheduleFlush(0)
      }
    }
  }
}
