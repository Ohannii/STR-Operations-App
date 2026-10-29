/**
 * Durable caption drafts for the pack-report editor (P0, 22 Oct 2026;
 * rev 3, 23 Oct).
 *
 * INCIDENT: typed captions lived only in the DOM; submitting the pack lost
 * them irrecoverably. This module makes every keystroke durable on the
 * DEVICE first (localStorage, synchronous, survives refresh / app kill /
 * navigation), independently of the server autosave that follows.
 *
 * PURE CORE + thin storage adapter, so every rule is unit-testable:
 *   - an entry is DIRTY until the server confirmed exactly its text;
 *   - `savedText` is the entry's BASELINE: the server text this draft was
 *     written against. It is persisted and is NEVER silently rebased onto a
 *     different server value (rev 3);
 *   - CONFLICT: when the server moved away from a draft's baseline (another
 *     tab/device), the entry carries `conflictServer` (the current server
 *     text, or null when unknown). Conflicts are persisted, survive refresh,
 *     are never autosaved, block submission, and resolve only by an explicit
 *     user choice (keep mine / use server);
 *   - LATEST EDIT WINS: a save acknowledgement carries the editedAt it sent;
 *     an older ack can never mark a newer edit clean (or overwrite it);
 *   - BLANK BY CHOICE is a valid value: '' is saved as a deliberate blank
 *     (server stores NULL) and is then CLEAN — distinct from "typed but not
 *     saved", which stays dirty and blocks submission;
 *   - drafts are only dropped when they match the confirmed server value —
 *     never on error, and never for text newer than an acknowledgement;
 *   - TWO EDITORS (rev 6): device storage is a per-edit-identity journal, so
 *     two tabs/controllers can never overwrite or clear each other's text.
 */

import { canonicalCaption, sameCaption } from './caption-canonical'

export type CaptionEntry = {
  /** Latest text the user typed ('' = deliberately blank). */
  text: string
  /** Monotonic per-entry edit stamp (ms). */
  editedAt: number
  /** BASELINE: last server text confirmed for this entry. */
  savedText: string | null
  savedEditedAt: number
  /** Present => unresolved conflict. string = current server text; null =
   *  server text unknown (reload to see it). Absent => no conflict. */
  conflictServer?: string | null
  /**
   * DEVICE EDIT IDENTITY (rev 6). The device-journal record this draft lives
   * in. Minted by the controller that owns the draft for EACH new edit (an
   * edit drops it; the controller assigns a fresh one before persisting) and
   * used for exactly two things: the storage key, and matching a server
   * acknowledgement to the EXACT edit it saved.
   */
  editId?: string
}

export type CaptionDrafts = Record<string, CaptionEntry>

/** Server notes normalised to the editor's text domain (null -> ''), using
 *  THE canonical caption rule shared with the database (caption-canonical). */
export function serverText(notes: string | null | undefined): string {
  return canonicalCaption(notes)
}

export function isConflict(entry: CaptionEntry): boolean {
  return entry.conflictServer !== undefined
}

/**
 * Seed the store against the server-rendered captions (rev 3: NEVER rebases
 * a restored draft onto a different server value).
 *   - no draft, or draft already equals server  -> clean;
 *   - persisted conflict                       -> stays a conflict (with the
 *                                                  fresh server text);
 *   - draft baseline == current server         -> restored dirty (safe to
 *                                                  autosave: CAS expects it);
 *   - server moved since the draft's baseline  -> CONFLICT, fail closed.
 */
export function seedDrafts(
  persisted: CaptionDrafts,
  serverNotes: Record<string, string | null>,
): CaptionDrafts {
  const next: CaptionDrafts = {}
  for (const [photoId, notes] of Object.entries(serverNotes)) {
    const server = serverText(notes)
    const draft = persisted[photoId]
    if (!draft || canonicalCaption(draft.text) === server) {
      next[photoId] = { text: server, editedAt: 0, savedText: server, savedEditedAt: 0 }
    } else if (isConflict(draft)) {
      next[photoId] = { ...draft, conflictServer: server }
    } else if (canonicalCaption(draft.savedText) === server) {
      next[photoId] = { ...draft, savedText: server }
    } else {
      // The server changed underneath this draft (another tab/device).
      // Autosaving now would silently overwrite it — refuse.
      next[photoId] = { ...draft, conflictServer: server }
    }
  }
  return next
}

/** Apply a keystroke. Never loses newer text to an older event. A conflict
 *  stays a conflict until explicitly resolved. */
export function applyEdit(
  drafts: CaptionDrafts,
  photoId: string,
  text: string,
  nowMs: number,
): CaptionDrafts {
  const cur = drafts[photoId]
  const editedAt = Math.max(nowMs, (cur?.editedAt ?? 0) + 1)
  return {
    ...drafts,
    [photoId]: {
      text,
      editedAt,
      savedText: cur?.savedText ?? null,
      savedEditedAt: cur?.savedEditedAt ?? 0,
      ...(cur && isConflict(cur) ? { conflictServer: cur.conflictServer } : {}),
    },
  }
}

/**
 * Server acknowledged a save of (sentText, sentEditedAt).
 * LATEST EDIT WINS: if the user typed again after this save left, the entry
 * stays dirty with the NEWER text — the stale ack only updates savedText.
 * EDIT IDENTITY (rev 6): an ack that names an edit identity CLEARS only the
 * entry carrying exactly that identity. An ack for an OLDER edit of the SAME
 * live editor (sentEditedAt < the entry's editedAt — the user kept typing
 * while it was in flight) never clears or overwrites the newer edit, but it
 * DOES advance the newer entry's server baseline to the text the server just
 * confirmed, so the chained request compare-and-sets against the truth
 * instead of producing a false conflict (rev 6.1). Callers guarantee "same
 * live editor": the controller drops every result of a superseded or
 * disposed generation before it gets here.
 */
export function markSaved(
  drafts: CaptionDrafts,
  photoId: string,
  sentText: string,
  sentEditedAt: number,
  sentEditId?: string,
): CaptionDrafts {
  const cur = drafts[photoId]
  if (!cur) return drafts
  if (sentEditedAt < cur.editedAt) {
    // OLDER ack (any identity): baseline only — text and identity untouched.
    return { ...drafts, [photoId]: { ...cur, savedText: sentText, savedEditedAt: sentEditedAt } }
  }
  // Same-or-newer stamp but a DIFFERENT identity: not this edit — no change.
  if (sentEditId !== undefined && cur.editId !== sentEditId) return drafts
  return {
    ...drafts,
    [photoId]: { ...cur, text: cur.text, savedText: sentText, savedEditedAt: sentEditedAt },
  }
}

/** Mark an entry conflicted (server refused a stale write, or a submit
 *  manifest no longer matched the server). The local text is kept. */
export function markConflict(
  drafts: CaptionDrafts,
  photoId: string,
  serverNow: string | null,
): CaptionDrafts {
  const cur = drafts[photoId]
  if (!cur) return drafts
  return { ...drafts, [photoId]: { ...cur, conflictServer: serverNow } }
}

/** Explicit user choice: keep MY text. The new baseline is the server text
 *  the user saw, so the next autosave compare-and-sets against it. */
export function resolveKeepMine(drafts: CaptionDrafts, photoId: string): CaptionDrafts {
  const cur = drafts[photoId]
  if (!cur || typeof cur.conflictServer !== 'string') return drafts // unknown server text: cannot resolve here
  const server: string = cur.conflictServer
  const resolved: CaptionEntry = {
    text: cur.text,
    editedAt: cur.editedAt,
    savedText: server,
    savedEditedAt: 0,
    ...(cur.editId !== undefined ? { editId: cur.editId } : {}),
  }
  return { ...drafts, [photoId]: resolved }
}

/** Explicit user choice: use the SERVER text (mine is discarded by choice). */
export function resolveUseServer(
  drafts: CaptionDrafts,
  photoId: string,
  nowMs: number,
): CaptionDrafts {
  const cur = drafts[photoId]
  if (!cur || typeof cur.conflictServer !== 'string') return drafts
  const server: string = cur.conflictServer
  return {
    ...drafts,
    [photoId]: {
      text: server,
      editedAt: Math.max(nowMs, cur.editedAt + 1),
      savedText: server,
      savedEditedAt: 0,
      ...(cur.editId !== undefined ? { editId: cur.editId } : {}),
    },
  }
}

/**
 * A submit was acknowledged for `snapshot`. Entries whose CURRENT text still
 * equals what was submitted become clean; any entry the user changed after
 * the snapshot keeps its newer text and stays dirty — it is never cleared.
 */
export function acknowledgeSubmitted(
  drafts: CaptionDrafts,
  snapshot: ReadonlyArray<{ photoId: string; note: string }>,
): CaptionDrafts {
  let next = drafts
  for (const s of snapshot) {
    const cur = next[s.photoId]
    if (!cur || isConflict(cur)) continue
    if (canonicalCaption(cur.text) === canonicalCaption(s.note)) {
      next = { ...next, [s.photoId]: { ...cur, savedText: cur.text } }
    }
  }
  return next
}

/**
 * MANIFEST RECONCILIATION (rev 4). The server's photo set for this pack
 * changed under a live editor (a photo was removed or added and the page's
 * server data refreshed without remounting the editor).
 *   - ids no longer on the server are DROPPED (they cannot be submitted);
 *   - new ids are seeded from the server (or a matching persisted draft);
 *   - surviving ids keep their local state: dirty and conflicted captions
 *     are preserved untouched; a CLEAN entry adopts a changed server value
 *     (it has no local edits, so its baseline simply moves with the server).
 */
export function reconcileManifest(
  drafts: CaptionDrafts,
  serverNotes: Record<string, string | null>,
  persisted: CaptionDrafts = {},
): CaptionDrafts {
  const next: CaptionDrafts = {}
  const fresh = seedDrafts(persisted, serverNotes)
  for (const id of Object.keys(serverNotes)) {
    const cur = drafts[id]
    if (!cur) {
      next[id] = fresh[id]
    } else if (isDirty(cur) || isConflict(cur)) {
      next[id] = cur
    } else {
      const server = serverText(serverNotes[id])
      next[id] =
        canonicalCaption(cur.savedText) === server
          ? cur
          : { ...cur, text: server, savedText: server }
    }
  }
  return next
}

/** Dirty = the server has not confirmed exactly this text. */
export function isDirty(entry: CaptionEntry): boolean {
  return canonicalCaption(entry.text) !== canonicalCaption(entry.savedText)
}

/** Ids eligible for AUTOSAVE: dirty and NOT conflicted. */
export function dirtyIds(drafts: CaptionDrafts): string[] {
  return Object.keys(drafts).filter((id) => isDirty(drafts[id]) && !isConflict(drafts[id]))
}

export function conflictIds(drafts: CaptionDrafts): string[] {
  return Object.keys(drafts).filter((id) => isConflict(drafts[id]))
}

// ----------------------------------------------------------------
// Device persistence — IDENTITY-PRESERVING EDIT JOURNAL (rev 6).
//
// rev 5 stored ONE record per pack and every controller rewrote (or
// removed) the whole record from its own in-memory view. Two live editors
// (two tabs, or a stale controller whose save resolved after a remount)
// therefore overwrote each other: last writer wins, the other's text gone.
//
// rev 6: ONE localStorage key PER EDIT IDENTITY:
//     pack-captions:v2:<packId>:<photoId>:<editId>
// A controller only ever (a) writes/removes keys whose editId it minted
// itself in its CURRENT generation, or (b) removes a foreign record it has
// ADOPTED — and only after its own copy is durably written, and only if the
// stored bytes are still exactly what it read (compare-and-remove). No code
// path replaces or clears another editor's record wholesale. localStorage
// writes are synchronous, so a keystroke is on the device before the
// debounce starts, exactly as before.
// ----------------------------------------------------------------

const JOURNAL_PREFIX = 'pack-captions:v2:'

export function captionJournalPrefix(packId: string): string {
  return `${JOURNAL_PREFIX}${packId}:`
}

export function captionEditKey(packId: string, photoId: string, editId: string): string {
  return `${captionJournalPrefix(packId)}${photoId}:${editId}`
}

/**
 * ORPHAN BACKUP (rev 5; rev 6 keyed by EDIT IDENTITY). Unsynced text that is
 * EXCLUDED from every submit manifest but kept on the device — never
 * silently dropped — until the inspector explicitly discards it:
 *   - 'removed':   its photo is no longer in the pack;
 *   - 'competing': another editor (tab/controller) on this device left a
 *                  DIFFERENT unsynced caption for the same photo; the newest
 *                  one is the live draft, this one is kept for recovery.
 */
export type OrphanReason = 'removed' | 'competing'
export type OrphanCaption = {
  photoId: string
  text: string
  removedAt: number
  reason: OrphanReason
}
/** Keyed by edit identity (several orphans may belong to one photo). */
export type CaptionOrphans = Record<string, OrphanCaption>

export type CaptionStore = { entries: CaptionDrafts; orphans: CaptionOrphans }

/** One persisted edit (the value stored under its own key). */
export type StoredEdit = {
  v: 2
  photoId: string
  editId: string
  text: string
  editedAt: number
  savedText: string | null
  savedEditedAt: number
  conflictServer?: string | null
  orphan?: { removedAt: number; reason: OrphanReason }
}

/** A record as read from storage: its key and EXACT stored bytes (for
 *  compare-and-remove) plus the parsed edit. */
export type JournalRecord = { key: string; raw: string; edit: StoredEdit }

export type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key'> & {
  readonly length: number
}

export function defaultKV(): KV | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}

function isUnsynced(e: CaptionEntry): boolean {
  return isDirty(e) || isConflict(e)
}

export function entryToStored(photoId: string, editId: string, e: CaptionEntry): StoredEdit {
  return {
    v: 2,
    photoId,
    editId,
    text: e.text,
    editedAt: e.editedAt,
    savedText: e.savedText,
    savedEditedAt: e.savedEditedAt,
    ...(e.conflictServer !== undefined ? { conflictServer: e.conflictServer } : {}),
  }
}

export function orphanToStored(editId: string, o: OrphanCaption): StoredEdit {
  return {
    v: 2,
    photoId: o.photoId,
    editId,
    text: o.text,
    editedAt: o.removedAt,
    savedText: null,
    savedEditedAt: 0,
    orphan: { removedAt: o.removedAt, reason: o.reason },
  }
}

/** Strict parse; anything malformed is ignored (never crashes, never
 *  fabricates a draft). */
export function parseStoredEdit(raw: string | null): StoredEdit | null {
  if (!raw) return null
  try {
    const e = JSON.parse(raw) as StoredEdit
    if (
      !e ||
      e.v !== 2 ||
      typeof e.photoId !== 'string' ||
      typeof e.editId !== 'string' ||
      typeof e.text !== 'string' ||
      typeof e.editedAt !== 'number' ||
      typeof e.savedEditedAt !== 'number' ||
      !(e.savedText === null || typeof e.savedText === 'string') ||
      !(e.conflictServer === undefined || e.conflictServer === null || typeof e.conflictServer === 'string')
    ) {
      return null
    }
    let orphan: StoredEdit['orphan']
    if (e.orphan !== undefined) {
      if (
        !e.orphan ||
        typeof e.orphan.removedAt !== 'number' ||
        (e.orphan.reason !== 'removed' && e.orphan.reason !== 'competing')
      ) {
        return null
      }
      orphan = { removedAt: e.orphan.removedAt, reason: e.orphan.reason }
    }
    return {
      v: 2,
      photoId: e.photoId,
      editId: e.editId,
      text: e.text,
      editedAt: e.editedAt,
      savedText: e.savedText,
      savedEditedAt: e.savedEditedAt,
      ...(e.conflictServer !== undefined ? { conflictServer: e.conflictServer } : {}),
      ...(orphan ? { orphan } : {}),
    }
  } catch {
    return null
  }
}

/** Every well-formed edit record of this pack on this device. */
export function readJournal(packId: string, kv: KV | null = defaultKV()): JournalRecord[] {
  if (!kv) return []
  try {
    const prefix = captionJournalPrefix(packId)
    const keys: string[] = []
    for (let i = 0; i < kv.length; i += 1) {
      const k = kv.key(i)
      if (k !== null && k.startsWith(prefix)) keys.push(k)
    }
    const out: JournalRecord[] = []
    for (const key of keys.sort()) {
      const raw = kv.getItem(key)
      const edit = parseStoredEdit(raw)
      // The key must agree with the record's own identity; a mismatched
      // record is ignored (left untouched), never trusted.
      if (raw !== null && edit && key === captionEditKey(packId, edit.photoId, edit.editId)) {
        out.push({ key, raw, edit })
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * COMPARE-AND-REMOVE: delete `key` only if it still holds EXACTLY `raw` (the
 * bytes this caller read). A record another editor rewrote since then is a
 * newer/different edit and is left alone.
 */
export function removeIfUnchanged(kv: KV | null, key: string, raw: string): boolean {
  try {
    if (!kv || kv.getItem(key) !== raw) return false
    kv.removeItem(key)
    return true
  } catch {
    return false
  }
}

export type JournalView = {
  /** The live draft per photo: the NEWEST non-orphan record (its source
   *  editId kept on the entry). */
  entries: CaptionDrafts
  /** Everything else that holds information, keyed by source editId. */
  orphans: CaptionOrphans
}

/**
 * Merge every edit record of a pack into one view WITHOUT losing anything:
 *   - per photo, the newest non-orphan record is the live draft;
 *   - an older record with DIFFERENT text is a 'competing' orphan (kept for
 *     recovery); one with identical canonical text is redundant (no
 *     information lost by dropping it);
 *   - with a server manifest, records for photos not in it are 'removed'
 *     orphans;
 *   - existing orphan records stay orphans (identical duplicates collapse).
 */
export function mergeJournal(
  records: ReadonlyArray<JournalRecord>,
  serverNotes?: Record<string, string | null>,
  nowMs = 0,
): JournalView {
  const entries: CaptionDrafts = {}
  const orphans: CaptionOrphans = {}
  const seen = new Set<string>() // photoId \0 canonical text already represented
  const mark = (photoId: string, text: string) => {
    const k = `${photoId}\u0000${canonicalCaption(text)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }
  const live = records
    .filter((r) => !r.edit.orphan)
    .sort(
      (a, b) =>
        b.edit.editedAt - a.edit.editedAt || (a.edit.editId < b.edit.editId ? 1 : -1),
    )
  for (const { edit } of live) {
    const removed = serverNotes !== undefined && !(edit.photoId in serverNotes)
    if (!removed && !entries[edit.photoId]) {
      entries[edit.photoId] = {
        text: edit.text,
        editedAt: edit.editedAt,
        savedText: edit.savedText,
        savedEditedAt: edit.savedEditedAt,
        editId: edit.editId,
        ...(edit.conflictServer !== undefined ? { conflictServer: edit.conflictServer } : {}),
      }
      mark(edit.photoId, edit.text)
      continue
    }
    if (!mark(edit.photoId, edit.text)) continue // identical text already kept
    // Text the server already holds for a photo still in the pack is not
    // at risk: nothing to recover.
    if (!removed && serverNotes !== undefined && sameCaption(edit.text, serverNotes[edit.photoId])) {
      continue
    }
    orphans[edit.editId] = {
      photoId: edit.photoId,
      text: edit.text,
      removedAt: nowMs || edit.editedAt,
      reason: removed ? 'removed' : 'competing',
    }
  }
  for (const { edit } of records) {
    if (!edit.orphan) continue
    if (!mark(edit.photoId, edit.text)) continue
    orphans[edit.editId] = {
      photoId: edit.photoId,
      text: edit.text,
      removedAt: edit.orphan.removedAt,
      reason: edit.orphan.reason,
    }
  }
  return { entries, orphans }
}

/** Read-only merged view of this device's caption journal for a pack. */
export function loadPersistedStore(packId: string, kv: KV | null = defaultKV()): CaptionStore {
  return mergeJournal(readJournal(packId, kv))
}

/**
 * True when THIS DEVICE still holds caption drafts, conflicts or orphans for
 * the pack that the server has not confirmed. Unknown storage => false (an
 * EXTRA guard; the authoritative protection is the server-side transaction).
 */
export function hasUnsyncedCaptionDrafts(packId: string, kv: KV | null = defaultKV()): boolean {
  return readJournal(packId, kv).length > 0
}

// ----------------------------------------------------------------
// Manifest identity + removed-photo orphans (rev 5).
// ----------------------------------------------------------------

/**
 * The server manifest's identity: sorted photo ids AND each one's canonical
 * caption. Same ids with a changed server caption is a different manifest;
 * an identical re-render produces the identical key (a no-op).
 */
export function captionManifestKey(serverNotes: Record<string, string | null>): string {
  return Object.keys(serverNotes)
    .sort()
    .map((id) => `${id}\u0000${canonicalCaption(serverNotes[id])}`)
    .join('\u0001')
}

/** Unsynced (dirty or conflicted) text of photos absent from the manifest,
 *  keyed by the entry's OWN edit identity (rev 6). */
export function removedUnsynced(
  drafts: CaptionDrafts,
  serverNotes: Record<string, string | null>,
  nowMs: number,
): CaptionOrphans {
  const out: CaptionOrphans = {}
  for (const [id, e] of Object.entries(drafts)) {
    if (id in serverNotes) continue
    if (isUnsynced(e)) {
      out[e.editId ?? `local-${id}`] = { photoId: id, text: e.text, removedAt: nowMs, reason: 'removed' }
    }
  }
  return out
}

// ----------------------------------------------------------------
// Submitted-pack recovery (rev 5; rev 6 per edit record).
// ----------------------------------------------------------------

export type SubmittedRecoveryItem = {
  /** Stable React key. */
  id: string
  photoId: string
  /** The text on this device. */
  local: string
  /** The submitted server caption (null = photo not in the submitted pack). */
  server: string | null
  kind: 'differs' | 'not_in_pack'
  /** The exact records shown (compare-and-remove on explicit discard). */
  sources: ReadonlyArray<{ key: string; raw: string }>
}

/**
 * The pack is SUBMITTED (immutable). Compare every device record with the
 * FINAL server captions:
 *   - a live draft canonically identical to the submitted caption is PROVEN
 *     delivered (e.g. the submit committed but the response was lost) and is
 *     the ONLY thing that may be cleared;
 *   - a draft that differs (e.g. another device submitted) or whose photo is
 *     not in the submitted pack, and every orphan, is KEPT and exposed for
 *     copy/manual-copy recovery until the inspector explicitly discards it.
 * Identical texts for the same photo are shown once (all sources tracked).
 */
export function classifySubmittedRecords(
  records: ReadonlyArray<JournalRecord>,
  serverNotes: Record<string, string | null>,
): { proven: JournalRecord[]; items: SubmittedRecoveryItem[] } {
  const proven: JournalRecord[] = []
  const byText = new Map<string, SubmittedRecoveryItem & { sources: Array<{ key: string; raw: string }> }>()
  for (const r of records) {
    const { edit } = r
    const inPack = edit.photoId in serverNotes
    if (!edit.orphan && inPack && sameCaption(edit.text, serverNotes[edit.photoId])) {
      proven.push(r)
      continue
    }
    const k = `${edit.photoId}\u0000${canonicalCaption(edit.text)}`
    const existing = byText.get(k)
    if (existing) {
      existing.sources.push({ key: r.key, raw: r.raw })
      continue
    }
    byText.set(k, {
      id: edit.editId,
      photoId: edit.photoId,
      local: edit.text,
      server: inPack ? serverText(serverNotes[edit.photoId]) : null,
      kind: inPack ? 'differs' : 'not_in_pack',
      sources: [{ key: r.key, raw: r.raw }],
    })
  }
  return { proven, items: [...byText.values()] }
}

/**
 * Run the submitted-pack recovery against the device journal: clears ONLY
 * the proven-identical records (compare-and-remove) and returns what must
 * still be shown. Never touches the server.
 */
export function applySubmittedRecovery(
  packId: string,
  serverNotes: Record<string, string | null>,
  kv: KV | null = defaultKV(),
): SubmittedRecoveryItem[] {
  const { proven, items } = classifySubmittedRecords(readJournal(packId, kv), serverNotes)
  for (const r of proven) removeIfUnchanged(kv, r.key, r.raw)
  return items
}

/**
 * EXPLICIT inspector action only: forget exactly the recovery copies that
 * were SHOWN. A record changed since (another editor) is kept.
 */
export function discardDeviceCaptions(
  items: ReadonlyArray<SubmittedRecoveryItem>,
  kv: KV | null = defaultKV(),
): void {
  for (const it of items) for (const s of it.sources) removeIfUnchanged(kv, s.key, s.raw)
}
