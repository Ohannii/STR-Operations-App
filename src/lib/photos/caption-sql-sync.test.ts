import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * TEST INTEGRITY (blocker 10, rev 3). The SQL acceptance suite applies the
 * migration INSIDE its own transaction (the linked runner cannot `\i` a
 * file), so it carries a copy. A hand-maintained copy can silently drift and
 * then prove properties of SQL that will never be applied. This test makes
 * that impossible: the block between the markers must equal the migration
 * file EXACTLY (only line endings are normalised).
 */

const read = (p: string) =>
  readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = 'supabase/migrations/20261022090000_caption_durability.sql'
const SUITE = 'supabase/tests/caption_durability_test.sql'
const BEGIN = '-- >>> BEGIN INLINE MIGRATION 20261022090000 (verbatim — do not edit)\n'
const END = '\n-- <<< END INLINE MIGRATION 20261022090000'

describe('caption SQL suite tests the EXACT migration SQL', () => {
  it('has exactly one inline block, between unambiguous markers', () => {
    const suite = read(SUITE)
    expect(suite.split(BEGIN).length - 1).toBe(1)
    expect(suite.split(END).length - 1).toBe(1)
    expect(suite.indexOf(BEGIN)).toBeLessThan(suite.indexOf(END))
  })

  it('the inline block is byte-identical to the migration file', () => {
    const suite = read(SUITE)
    const inline = suite.slice(suite.indexOf(BEGIN) + BEGIN.length, suite.indexOf(END))
    const migration = read(MIGRATION).replace(/^\n+|\n+$/g, '')
    expect(inline.replace(/^\n+|\n+$/g, '')).toBe(migration)
  })

  it('the inline block is applied inside the rolled-back transaction', () => {
    const suite = read(SUITE)
    const begin = suite.indexOf('\nbegin;\n')
    const rollback = suite.lastIndexOf('\nrollback;')
    expect(begin).toBeGreaterThan(-1)
    expect(begin).toBeLessThan(suite.indexOf(BEGIN))
    expect(rollback).toBeGreaterThan(suite.indexOf(END))
  })

  it('both NEW SECURITY DEFINER functions pin search_path to empty', () => {
    const migration = read(MIGRATION)
    for (const fn of ['set_prearrival_photo_caption', 'submit_prearrival_pack_with_captions']) {
      const start = migration.indexOf(`create or replace function public.${fn}(`)
      const header = migration.slice(start, migration.indexOf('as $$', start))
      expect(header).toMatch(/security definer\s*\n\s*set search_path = ''/)
    }
  })

  it('rev 5: attach_prearrival_photo is the original body with ONLY the caption change', () => {
    const body = (path: string) => {
      const sql = read(path)
      const start = sql.indexOf('create or replace function public.attach_prearrival_photo(')
      return sql.slice(start, sql.indexOf('$$;', start) + 3).split('\n')
    }
    const original = body('supabase/migrations/20260718120000_prearrival_photo_intents.sql')
    const redefined = body(MIGRATION)
    const removed = original.filter((l) => !redefined.includes(l))
    const added = redefined.filter((l) => !original.includes(l))
    expect(removed).toEqual(["  v_note := left(nullif(btrim(coalesce(p_note, '')), ''), 2000);"])
    expect(added).toEqual([
      '  -- CAPTION LIMIT (rev 5): refuse, never truncate — checked on the RAW value',
      '  -- before any lock or write.',
      '  if p_note is not null and length(p_note) > 2000 then',
      "    raise exception 'caption is too long (max 2000)' using errcode = '22023';",
      '  v_note := public.caption_canonical(p_note);',
    ])
  })
})
