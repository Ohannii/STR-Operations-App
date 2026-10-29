import { describe, it, expect } from 'vitest'
import {
  applySubmittedRecovery,
  captionEditKey,
  captionManifestKey,
  discardDeviceCaptions,
  loadPersistedStore,
  mergeJournal,
  parseStoredEdit,
  readJournal,
  removeIfUnchanged,
  removedUnsynced,
  acknowledgeSubmitted,
  applyEdit,
  conflictIds,
  dirtyIds,
  isConflict,
  isDirty,
  markConflict,
  markSaved,
  reconcileManifest,
  resolveKeepMine,
  resolveUseServer,
  seedDrafts,
  serverText,
  type CaptionDrafts,
} from './caption-drafts'
import { journalKeys, memoryKV, writeJournal } from './caption-journal-test-kv'

/**
 * P0 caption durability (Unit 377, 21 Oct 2026): the draft store is the
 * device-side half of the guarantee. These tests prove the rules the UI
 * relies on — dirty detection, refresh survival, latest-edit-wins, and
 * blank-by-choice — in isolation.
 */

const seedOne = (server: string | null): CaptionDrafts =>
  seedDrafts({}, { p1: server })

describe('seeding against server captions', () => {
  it('no persisted draft => clean entries mirroring the server', () => {
    const drafts = seedDrafts({}, { p1: 'Geyser valve', p2: null })
    expect(isDirty(drafts.p1)).toBe(false)
    expect(isDirty(drafts.p2)).toBe(false)
    expect(drafts.p1.text).toBe('Geyser valve')
    expect(drafts.p2.text).toBe('')
  })

  it('an unspent persisted draft is RESTORED dirty over the server value', () => {
    const persisted: CaptionDrafts = {
      p1: { text: 'Bedroom aircon remote present', editedAt: 100, savedText: null, savedEditedAt: 0 },
    }
    const drafts = seedDrafts(persisted, { p1: null })
    expect(drafts.p1.text).toBe('Bedroom aircon remote present')
    expect(isDirty(drafts.p1)).toBe(true)
  })

  it('a draft the server already shows is spent — dropped, clean', () => {
    const persisted: CaptionDrafts = {
      p1: { text: 'Maintenance audit', editedAt: 100, savedText: null, savedEditedAt: 0 },
    }
    const drafts = seedDrafts(persisted, { p1: 'Maintenance audit' })
    expect(isDirty(drafts.p1)).toBe(false)
  })
})

describe('dirty detection + blank-by-choice', () => {
  it('typing makes the entry dirty until the server confirms that exact text', () => {
    let drafts = seedOne('old caption')
    drafts = applyEdit(drafts, 'p1', 'new caption', 200)
    expect(isDirty(drafts.p1)).toBe(true)
    drafts = markSaved(drafts, 'p1', 'new caption', drafts.p1.editedAt)
    expect(isDirty(drafts.p1)).toBe(false)
  })

  it('clearing a caption is a VALID value: dirty until saved, then clean blank', () => {
    let drafts = seedOne('wrong caption')
    drafts = applyEdit(drafts, 'p1', '', 200)
    expect(isDirty(drafts.p1)).toBe(true) // typed-but-not-saved blank blocks
    drafts = markSaved(drafts, 'p1', '', drafts.p1.editedAt)
    expect(isDirty(drafts.p1)).toBe(false) // blank by choice, confirmed
  })

  it('typing the server value back is unchanged — clean, nothing to save', () => {
    let drafts = seedOne('same')
    drafts = applyEdit(drafts, 'p1', 'different', 200)
    drafts = applyEdit(drafts, 'p1', 'same', 300)
    expect(isDirty(drafts.p1)).toBe(false)
  })
})

describe('LATEST EDIT WINS over a delayed save acknowledgement', () => {
  it('an ack for an older edit never cleans (or overwrites) newer text', () => {
    let drafts = seedOne(null)
    drafts = applyEdit(drafts, 'p1', 'first version', 100)
    const sentEditedAt = drafts.p1.editedAt
    // The user keeps typing while the save is in flight.
    drafts = applyEdit(drafts, 'p1', 'second version', 200)
    // The FIRST save's ack lands late.
    drafts = markSaved(drafts, 'p1', 'first version', sentEditedAt)
    expect(drafts.p1.text).toBe('second version') // newer text intact
    expect(isDirty(drafts.p1)).toBe(true) // still needs saving
    expect(dirtyIds(drafts)).toEqual(['p1'])
  })

  it('applyEdit stamps are monotonic even against a stale clock', () => {
    let drafts = seedOne(null)
    drafts = applyEdit(drafts, 'p1', 'a', 500)
    drafts = applyEdit(drafts, 'p1', 'b', 400) // clock went backwards
    expect(drafts.p1.text).toBe('b')
    expect(drafts.p1.editedAt).toBeGreaterThan(500)
  })
})

describe('device persistence round-trip (refresh survival)', () => {
  it('dirty drafts survive journal write -> read -> seed exactly', () => {
    let drafts = seedDrafts({}, { p1: null, p2: 'kept' })
    drafts = applyEdit(drafts, 'p1', 'typed before the refresh', 100)
    const kv = memoryKV()
    writeJournal(kv, 'p', { p1: drafts.p1 })
    const restored = seedDrafts(loadPersistedStore('p', kv).entries, { p1: null, p2: 'kept' })
    expect(restored.p1.text).toBe('typed before the refresh')
    expect(isDirty(restored.p1)).toBe(true)
    expect(isDirty(restored.p2)).toBe(false)
  })

  it('garbage/corrupt records never crash and never fabricate drafts', () => {
    expect(parseStoredEdit(null)).toBeNull()
    expect(parseStoredEdit('not json {{{')).toBeNull()
    expect(parseStoredEdit(JSON.stringify({ v: 1, entries: { p1: {} } }))).toBeNull()
    expect(
      parseStoredEdit(JSON.stringify({ v: 2, photoId: 'p1', editId: 'e', text: 7, editedAt: 1, savedText: null, savedEditedAt: 0 })),
    ).toBeNull()
    const kv = memoryKV()
    kv.setItem(captionEditKey('p', 'p1', 'e1'), 'garbage')
    expect(readJournal('p', kv)).toEqual([])
    expect(loadPersistedStore('p', kv)).toEqual({ entries: {}, orphans: {} })
  })

  it('a record whose key disagrees with its own identity is ignored (never trusted)', () => {
    const kv = memoryKV()
    writeJournal(kv, 'p', { p1: { text: 'x', editedAt: 1, savedText: '', savedEditedAt: 0, editId: 'e1' } })
    const raw = kv.getItem(captionEditKey('p', 'p1', 'e1')) as string
    kv.setItem(captionEditKey('p', 'p2', 'e1'), raw) // copied under the wrong photo
    expect(readJournal('p', kv).map((r) => r.edit.photoId)).toEqual(['p1'])
  })

  it('records of OTHER packs are never read', () => {
    const kv = memoryKV()
    writeJournal(kv, 'other-pack', { p1: { text: 'not mine', editedAt: 1, savedText: '', savedEditedAt: 0 } })
    expect(readJournal('p', kv)).toEqual([])
  })
})

describe('serverText normalisation', () => {
  it('null and whitespace mean blank', () => {
    expect(serverText(null)).toBe('')
    expect(serverText('  ')).toBe('')
    expect(serverText(' x ')).toBe('x')
  })
})

describe('BLOCKER 6 — baselines are never silently rebased', () => {
  it('server moved since the draft baseline => CONFLICT, excluded from autosave', () => {
    const persisted: CaptionDrafts = {
      p1: { text: 'mine', editedAt: 10, savedText: 'baseline', savedEditedAt: 0 },
    }
    const drafts = seedDrafts(persisted, { p1: 'someone else' })
    expect(isConflict(drafts.p1)).toBe(true)
    expect(drafts.p1.conflictServer).toBe('someone else')
    expect(drafts.p1.savedText).toBe('baseline') // NOT rebased
    expect(dirtyIds(drafts)).toEqual([]) // never autosaved
    expect(conflictIds(drafts)).toEqual(['p1'])
  })

  it('a conflict survives journal -> refresh -> seed', () => {
    let drafts = seedDrafts({}, { p1: 'baseline' })
    drafts = applyEdit(drafts, 'p1', 'mine', 10)
    drafts = markConflict(drafts, 'p1', null) // stale CAS in-session, server text unknown
    const kv = memoryKV()
    writeJournal(kv, 'p', { p1: drafts.p1 })
    const restored = seedDrafts(loadPersistedStore('p', kv).entries, {
      p1: 'other device',
    })
    expect(isConflict(restored.p1)).toBe(true)
    expect(restored.p1.text).toBe('mine')
    expect(restored.p1.conflictServer).toBe('other device')
  })

  it('a conflict whose server text now equals mine resolves itself as clean', () => {
    const drafts = seedDrafts(
      { p1: { text: 'same', editedAt: 1, savedText: 'x', savedEditedAt: 0, conflictServer: null } },
      { p1: 'same' },
    )
    expect(isConflict(drafts.p1)).toBe(false)
    expect(isDirty(drafts.p1)).toBe(false)
  })

  it('keep mine rebases ONLY by explicit choice; use server takes theirs', () => {
    const base = seedDrafts(
      { p1: { text: 'mine', editedAt: 1, savedText: 'old', savedEditedAt: 0 } },
      { p1: 'theirs' },
    )
    const kept = resolveKeepMine(base, 'p1')
    expect(isConflict(kept.p1)).toBe(false)
    expect(kept.p1.savedText).toBe('theirs')
    expect(dirtyIds(kept)).toEqual(['p1'])
    const taken = resolveUseServer(base, 'p1', 50)
    expect(taken.p1.text).toBe('theirs')
    expect(isDirty(taken.p1)).toBe(false)
  })

  it('an unknown server text (null) cannot be resolved blindly', () => {
    const drafts = markConflict(seedDrafts({}, { p1: 'x' }), 'p1', null)
    expect(resolveKeepMine(drafts, 'p1')).toBe(drafts)
    expect(resolveUseServer(drafts, 'p1', 1)).toBe(drafts)
  })
})

describe('BLOCKER 5 — acknowledgeSubmitted never clears newer text', () => {
  it('only entries still equal to the submitted snapshot become clean', () => {
    let drafts = seedDrafts({}, { p1: null, p2: null })
    drafts = applyEdit(drafts, 'p1', 'a', 1)
    drafts = applyEdit(drafts, 'p2', 'b', 2)
    const snapshot = [
      { photoId: 'p1', note: 'a' },
      { photoId: 'p2', note: 'b' },
    ]
    drafts = applyEdit(drafts, 'p2', 'b — typed later', 3)
    const acked = acknowledgeSubmitted(drafts, snapshot)
    expect(isDirty(acked.p1)).toBe(false)
    expect(isDirty(acked.p2)).toBe(true)
    expect(acked.p2.text).toBe('b — typed later')
  })
})

describe('BLOCKER 5 (rev 4) — legacy whitespace uses THE canonical rule', () => {
  it('a legacy stored value with edge whitespace seeds as the same clean caption', () => {
    const drafts = seedDrafts({}, { p1: '  Legacy caption \n' })
    expect(drafts.p1.text).toBe('Legacy caption')
    expect(isDirty(drafts.p1)).toBe(false)
  })

  it('a restored draft whose baseline differs only by legacy whitespace is NOT a conflict', () => {
    const drafts = seedDrafts(
      { p1: { text: 'my edit', editedAt: 1, savedText: 'Legacy caption', savedEditedAt: 0 } },
      { p1: '\tLegacy caption  ' },
    )
    expect(isConflict(drafts.p1)).toBe(false)
    expect(dirtyIds(drafts)).toEqual(['p1'])
  })
})

describe('BLOCKER 3 (rev 4) — reconcileManifest', () => {
  it('drops absent ids, seeds new ids, preserves dirty and conflicted survivors', () => {
    let drafts = seedDrafts(
      { p2: { text: 'mine', editedAt: 1, savedText: 'old', savedEditedAt: 0 } },
      { p1: null, p2: 'theirs', p3: 'gone soon' },
    )
    drafts = applyEdit(drafts, 'p1', 'dirty local', 5)
    const next = reconcileManifest(drafts, { p1: null, p2: 'theirs', p4: 'new photo' })
    expect(Object.keys(next).sort()).toEqual(['p1', 'p2', 'p4'])
    expect(next.p1.text).toBe('dirty local')
    expect(isConflict(next.p2)).toBe(true)
    expect(next.p4).toMatchObject({ text: 'new photo', savedText: 'new photo' })
  })

  it('a CLEAN survivor adopts a changed server value (its baseline moves with the server)', () => {
    const drafts = seedDrafts({}, { p1: 'old server' })
    const next = reconcileManifest(drafts, { p1: 'new server' })
    expect(next.p1).toMatchObject({ text: 'new server', savedText: 'new server' })
    expect(isDirty(next.p1)).toBe(false)
  })

  it('a new id restores a matching persisted device draft', () => {
    const next = reconcileManifest(
      {},
      { p9: null },
      { p9: { text: 'typed before refresh', editedAt: 3, savedText: '', savedEditedAt: 0 } },
    )
    expect(next.p9.text).toBe('typed before refresh')
    expect(dirtyIds(next)).toEqual(['p9'])
  })
})

// ----------------------------------------------------------------
// rev 5
// ----------------------------------------------------------------

const dirty = (text: string, savedText = ''): CaptionDrafts[string] => ({
  text,
  editedAt: 5,
  savedText,
  savedEditedAt: 0,
})

describe('REV 6 — identity-preserving journal merge (no record silently lost)', () => {
  const rec = (photoId: string, editId: string, text: string, editedAt: number) => {
    const kv = memoryKV()
    writeJournal(kv, 'p', { [photoId]: { text, editedAt, savedText: '', savedEditedAt: 0, editId } })
    return readJournal('p', kv)[0]
  }

  it('newest record per photo is the draft; a different older text is a COMPETING orphan', () => {
    const view = mergeJournal([rec('p1', 'a', 'older words', 1), rec('p1', 'b', 'newer words', 2)])
    expect(view.entries.p1).toMatchObject({ text: 'newer words', editId: 'b' })
    expect(view.orphans).toEqual({
      a: { photoId: 'p1', text: 'older words', removedAt: 1, reason: 'competing' },
    })
  })

  it('identical canonical text collapses; text the server already holds is not "at risk"', () => {
    const view = mergeJournal(
      [rec('p1', 'a', ' same ', 1), rec('p1', 'b', 'same', 2), rec('p1', 'c', 'server text', 0)],
      { p1: 'server text' },
    )
    expect(view.entries.p1.text).toBe('same')
    expect(view.orphans).toEqual({})
  })

  it('with a manifest, records for photos no longer in the pack become REMOVED orphans', () => {
    const view = mergeJournal([rec('gone', 'g', 'typed for a removed photo', 1)], { p1: null }, 99)
    expect(view.entries).toEqual({})
    expect(view.orphans.g).toEqual({ photoId: 'gone', text: 'typed for a removed photo', removedAt: 99, reason: 'removed' })
  })

  it('markSaved with an edit identity applies ONLY to that exact edit', () => {
    let drafts = seedDrafts({}, { p1: null })
    drafts = applyEdit(drafts, 'p1', 'typed', 10)
    drafts = { p1: { ...drafts.p1, editId: 'current' } }
    const other = markSaved(drafts, 'p1', 'typed', drafts.p1.editedAt, 'someone-else')
    expect(other).toBe(drafts) // unchanged: never clears a different edit
    expect(isDirty(markSaved(drafts, 'p1', 'typed', drafts.p1.editedAt, 'current').p1)).toBe(false)
  })

  it('rev 6.1: an OLDER ack of a different edit advances the BASELINE only — never the newer text/identity', () => {
    let drafts = seedDrafts({}, { p1: null })
    drafts = applyEdit(drafts, 'p1', 'old text', 10)
    const sentAt = drafts.p1.editedAt
    drafts = applyEdit(drafts, 'p1', 'newer text', 20)
    drafts = { p1: { ...drafts.p1, editId: 'newer-edit' } }
    const next = markSaved(drafts, 'p1', 'old text', sentAt, 'old-edit')
    expect(next.p1).toMatchObject({ text: 'newer text', editId: 'newer-edit', savedText: 'old text' })
    expect(isDirty(next.p1)).toBe(true) // the newer edit is NOT cleared
  })

  it('compare-and-remove deletes only the exact bytes that were read', () => {
    const kv = memoryKV()
    kv.setItem('k', 'v1')
    expect(removeIfUnchanged(kv, 'k', 'v0')).toBe(false) // rewritten since read
    expect(kv.getItem('k')).toBe('v1')
    expect(removeIfUnchanged(kv, 'k', 'v1')).toBe(true)
    expect(kv.getItem('k')).toBeNull()
  })
})

describe('ITEM 6 — the manifest key includes canonical server captions', () => {
  it('same ids + changed caption => different key; identical => same; order-free', () => {
    const k1 = captionManifestKey({ a: 'one', b: null })
    expect(captionManifestKey({ b: null, a: 'one' })).toBe(k1)
    expect(captionManifestKey({ a: ' one\n', b: '' })).toBe(k1) // canonical
    expect(captionManifestKey({ a: 'ONE', b: null })).not.toBe(k1)
    expect(captionManifestKey({ a: 'one' })).not.toBe(k1)
  })
})

describe('ITEM 7 — removed photos never silently lose unsynced text', () => {
  it('dirty/conflicted text of absent photos becomes an orphan; clean text does not', () => {
    const drafts: CaptionDrafts = {
      kept: dirty('still here'),
      gone: dirty('typed for a removed photo'),
      conflicted: { ...dirty('mine', 'old'), conflictServer: 'theirs' },
      clean: { text: 'x', editedAt: 0, savedText: 'x', savedEditedAt: 0 },
    }
    const orphans = removedUnsynced(
      { ...drafts, gone: { ...drafts.gone, editId: 'edit-gone' } },
      { kept: null },
      42,
    )
    expect(Object.values(orphans).map((o) => o.photoId).sort()).toEqual(['conflicted', 'gone'])
    // Keyed by the entry's OWN edit identity (rev 6).
    expect(orphans['edit-gone']).toEqual({
      photoId: 'gone',
      text: 'typed for a removed photo',
      removedAt: 42,
      reason: 'removed',
    })
  })
})

describe('ITEM 5 — submitted-pack recovery', () => {
  it('LOST RESPONSE + refresh: drafts identical to the submitted captions are cleared', () => {
    const kv = memoryKV()
    writeJournal(kv, 'p', { a: dirty('Lounge clean'), b: dirty(' Balcony locked ') })
    const items = applySubmittedRecovery('p', { a: 'Lounge clean', b: 'Balcony locked' }, kv)
    expect(items).toEqual([])
    expect(journalKeys(kv, 'p')).toEqual([]) // proven delivered -> gone
  })

  it('SUBMITTED ELSEWHERE + refresh: differing text is KEPT and exposed', () => {
    const kv = memoryKV()
    writeJournal(kv, 'p', { a: dirty('my wording'), b: dirty('same') })
    const items = applySubmittedRecovery('p', { a: 'their wording', b: 'same' }, kv)
    expect(items.map(({ photoId, local, server, kind }) => ({ photoId, local, server, kind }))).toEqual([
      { photoId: 'a', local: 'my wording', server: 'their wording', kind: 'differs' },
    ])
    const left = loadPersistedStore('p', kv)
    expect(Object.keys(left.entries)).toEqual(['a']) // only the proven one cleared
  })

  it('a draft for a photo NOT in the submitted pack, and orphans, are kept and exposed', () => {
    const kv = memoryKV()
    writeJournal(
      kv,
      'p',
      { x: dirty('for a removed photo') },
      { 'orphan-y': { photoId: 'y', text: 'orphan', removedAt: 1, reason: 'removed' } },
    )
    const items = applySubmittedRecovery('p', { a: 'final' }, kv)
    expect(items.map((i) => [i.photoId, i.kind]).sort()).toEqual([
      ['x', 'not_in_pack'],
      ['y', 'not_in_pack'],
    ])
    expect(journalKeys(kv, 'p')).toHaveLength(2)
  })

  it('only an explicit discard removes the recovery copies — exactly those shown', () => {
    const kv = memoryKV()
    writeJournal(kv, 'p', { a: dirty('mine') })
    applySubmittedRecovery('p', { a: 'theirs' }, kv)
    const items = applySubmittedRecovery('p', { a: 'theirs' }, kv) // refresh again: still kept
    expect(journalKeys(kv, 'p')).toHaveLength(1)
    discardDeviceCaptions(items, kv)
    expect(journalKeys(kv, 'p')).toEqual([])
  })

  it('a record CHANGED after it was shown survives the discard (another editor)', () => {
    const kv = memoryKV()
    writeJournal(kv, 'p', { a: { ...dirty('shown text'), editId: 'e1' } })
    const items = applySubmittedRecovery('p', { a: 'theirs' }, kv)
    writeJournal(kv, 'p', { a: { ...dirty('typed afterwards'), editedAt: 9, editId: 'e1' } })
    discardDeviceCaptions(items, kv)
    expect(loadPersistedStore('p', kv).entries.a.text).toBe('typed afterwards')
  })
})
