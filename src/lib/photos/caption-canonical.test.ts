import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_CAPTION_LENGTH,
  canonicalCaption,
  canonicalCaptionOrNull,
  captionTooLong,
  sameCaption,
} from './caption-canonical'

describe('captionTooLong — refuse, never truncate (rev 5)', () => {
  it('2,000 is allowed, 2,001 is not — measured on the RAW string', () => {
    expect(MAX_CAPTION_LENGTH).toBe(2000)
    expect(captionTooLong('x'.repeat(2000))).toBe(false)
    expect(captionTooLong('x'.repeat(2001))).toBe(true)
    expect(captionTooLong(' '.repeat(2001))).toBe(true) // no canonical bypass
    expect(captionTooLong(null)).toBe(false)
  })
})

/**
 * BLOCKER 5 (rev 4): ONE caption normalization rule, identical in JS and SQL.
 */

describe('canonicalCaption', () => {
  it('strips leading/trailing ASCII whitespace only', () => {
    expect(canonicalCaption('  Legacy caption \n')).toBe('Legacy caption')
    expect(canonicalCaption('\t\r\f\v x \v')).toBe('x')
    expect(canonicalCaption('inner  spaces kept')).toBe('inner  spaces kept')
  })

  it('NEVER strips a letter v (the E-string \\v trap) or non-ASCII spaces', () => {
    expect(canonicalCaption('vase v')).toBe('vase v')
    expect(canonicalCaption('v')).toBe('v')
    // U+00A0 is kept, exactly as Postgres btrim with an ASCII set would.
    expect(canonicalCaption(' x ')).toBe(' x ')
  })

  it('blank means no caption', () => {
    expect(canonicalCaption(null)).toBe('')
    expect(canonicalCaption(undefined)).toBe('')
    expect(canonicalCaptionOrNull('   \n')).toBeNull()
    expect(canonicalCaptionOrNull(' a ')).toBe('a')
  })

  it('sameCaption compares canonically', () => {
    expect(sameCaption('  Legacy caption \n', 'Legacy caption')).toBe(true)
    expect(sameCaption(null, '  ')).toBe(true)
    expect(sameCaption('a', 'b')).toBe(false)
  })
})

describe('the SQL rule mirrors the JS rule exactly', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20261022090000_caption_durability.sql'),
    'utf8',
  ).replace(/\r\n/g, '\n')

  it('caption_canonical trims the SAME six ASCII whitespace characters', () => {
    // space, \t, \n, \r, \f via the E-string, and \v as chr(11).
    expect(sql).toContain("pg_catalog.btrim(coalesce(p_text, ''), E' \\t\\n\\r\\f' || pg_catalog.chr(11))")
  })

  it('no comparison in the migration uses an ad-hoc btrim', () => {
    const executable = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')
    const btrims = executable.match(/btrim\(/g) ?? []
    expect(btrims.length).toBe(1) // only inside caption_canonical itself
  })
})
