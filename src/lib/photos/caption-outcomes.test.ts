import { describe, it, expect } from 'vitest'
import {
  copyTextWithFallback,
  deriveConflictDetails,
  describeUnexpected,
  interpretCaptionSaveRpc,
  interpretSubmitRpc,
} from './caption-outcomes'

describe('deriveConflictDetails — proven or nothing (rev 4, blocker 2)', () => {
  const manifest = [
    { photoId: 'a', expected: 'base a' },
    { photoId: 'b', expected: '' },
  ]
  const draft = { data: { status: 'draft' }, error: null }

  it('proves the exact differing photos', () => {
    expect(
      deriveConflictDetails(
        manifest,
        { data: [{ id: 'a', notes: 'changed' }, { id: 'b', notes: null }], error: null },
        draft,
      ),
    ).toEqual({ kind: 'proven', packSubmitted: false, conflicts: [{ photoId: 'a', serverNotes: 'changed' }] })
  })

  it.each([
    ['photo read error', { data: null, error: { m: 1 } }, draft],
    ['photos unreadable', { data: null, error: null }, draft],
    ['pack read error', { data: [], error: null }, { data: null, error: { m: 1 } }],
    ['pack unreadable', { data: [], error: null }, { data: null, error: null }],
    ['unexpected pack state', { data: [], error: null }, { data: { status: 'archived' }, error: null }],
    ['missing row', { data: [{ id: 'a', notes: 'x' }], error: null }, draft],
    ['duplicate row', { data: [{ id: 'a', notes: 'x' }, { id: 'a', notes: 'y' }, { id: 'b', notes: null }], error: null }, draft],
    ['unexpected row', { data: [{ id: 'a', notes: 'x' }, { id: 'z', notes: null }], error: null }, draft],
    ['no locatable difference', { data: [{ id: 'a', notes: ' base a\n' }, { id: 'b', notes: '  ' }], error: null }, draft],
  ])('%s => unproven', (_label, photos, pack) => {
    expect(
      deriveConflictDetails(
        manifest,
        photos as Parameters<typeof deriveConflictDetails>[1],
        pack as Parameters<typeof deriveConflictDetails>[2],
      ).kind,
    ).toBe('unproven')
  })

  it('a missing row is NEVER turned into a blank server caption', () => {
    const res = deriveConflictDetails(
      [{ photoId: 'a', expected: 'something' }],
      { data: [], error: null },
      draft,
    )
    expect(res).toEqual({ kind: 'unproven', reason: 'missing photo row' })
  })

  it('submitted elsewhere is proven from the pack state', () => {
    expect(
      deriveConflictDetails(manifest, { data: null, error: { m: 1 } }, { data: { status: 'submitted' }, error: null }),
    ).toEqual({ kind: 'proven', packSubmitted: true, conflicts: [] })
  })
})

/** BLOCKERS 8 + 9 (rev 3): explicit allow-lists, truthful clipboard. */

describe('caption save RPC allow-list', () => {
  it('accepts only saved / unchanged as success and stale as a typed conflict', () => {
    expect(interpretCaptionSaveRpc('saved')).toEqual({ kind: 'saved' })
    expect(interpretCaptionSaveRpc('unchanged')).toEqual({ kind: 'unchanged' })
    expect(interpretCaptionSaveRpc('stale')).toEqual({ kind: 'stale' })
  })
  it.each([null, undefined, '', 'SAVED', 'ok', 'submitted', 1, true, {}, ['saved']])(
    'unknown value %j is never success',
    (v) => {
      expect(interpretCaptionSaveRpc(v)).toEqual({ kind: 'unknown' })
    },
  )
})

describe('submit RPC allow-list', () => {
  it('accepts only submitted / already_submitted as success; caption_conflict is typed', () => {
    expect(interpretSubmitRpc('submitted')).toEqual({ kind: 'submitted' })
    expect(interpretSubmitRpc('already_submitted')).toEqual({ kind: 'already_submitted' })
    expect(interpretSubmitRpc('caption_conflict')).toEqual({ kind: 'caption_conflict' })
  })
  it.each([null, undefined, '', 'saved', 'Submitted', 'draft', 0, {}, ['submitted']])(
    'unknown value %j is never success',
    (v) => {
      expect(interpretSubmitRpc(v)).toEqual({ kind: 'unknown' })
    },
  )
  it('describeUnexpected never echoes long values', () => {
    expect(describeUnexpected(null)).toBe('null')
    expect(describeUnexpected(undefined)).toBe('undefined')
    expect(describeUnexpected('x'.repeat(500)).length).toBeLessThanOrEqual(47)
  })
})

describe('truthful clipboard backup', () => {
  it("reports 'copied' ONLY when the write resolves", async () => {
    let written = ''
    const clip = { writeText: async (t: string) => void (written = t) }
    expect(await copyTextWithFallback('captions', clip)).toBe('copied')
    expect(written).toBe('captions')
  })
  it("reports 'failed' when the write rejects (permission denied)", async () => {
    const clip = {
      writeText: async () => {
        throw new Error('NotAllowedError')
      },
    }
    expect(await copyTextWithFallback('captions', clip)).toBe('failed')
  })
  it("reports 'unavailable' when there is no clipboard API", async () => {
    expect(await copyTextWithFallback('captions', undefined)).toBe('unavailable')
    expect(await copyTextWithFallback('captions', null)).toBe('unavailable')
  })
})
