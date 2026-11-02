import { describe, it, expect } from 'vitest'
import { AsanaApiError } from '@/lib/integrations/asana/client'
import {
  AMBIGUOUS_QUARANTINE_MS,
  CREATE_PROTOCOL,
  RATE_LIMIT_FALLBACK_SECONDS,
  RECONCILE_SPACING_MS,
  classifyCallError,
  clearAttempt,
  exactMarkerMatches,
  flagMarkerLine,
  LEGACY_MARKER,
  legacyFlagPath,
  mergeCreateState,
  mustReconcile,
  notesContainExactLine,
  notesContainLegacyAppPath,
  readCreateState,
  recordNotFound,
  replacementPermitted,
  resolveMatcher,
  startAttempt,
  type CreateState,
} from '@/lib/integrations/worker/create-idempotency'

const FLAG = '0b7c2a3e-4d5f-4a6b-8c9d-0e1f2a3b4c5d'
const OTHER = '9f8e7d6c-5b4a-4321-8fed-cba987654321'
const P = '1216372108028101'
const T0 = Date.parse('2026-11-02T10:00:00.000Z')
const MIN = 60_000

const empty = (): CreateState => readCreateState({ create_protocol: CREATE_PROTOCOL })

describe('marker line', () => {
  it('is exact, stable and built only from the flag UUID', () => {
    expect(flagMarkerLine(FLAG)).toBe(`STR-APP-REF: flag/${FLAG}`)
    expect(flagMarkerLine(FLAG.toUpperCase())).toBe(`STR-APP-REF: flag/${FLAG}`)
  })

  it('refuses anything that is not a UUID (no newline / injection / names)', () => {
    for (const bad of ['flag-1', '', `${FLAG}\nSTR-APP-REF: flag/x`, 'Jane Guest', `${FLAG} `]) {
      expect(() => flagMarkerLine(bad)).toThrow(/not a UUID/)
    }
  })
})

describe('EXACT line matching — never substrings', () => {
  const line = flagMarkerLine(FLAG)

  it('matches only a complete identical line (CRLF tolerated)', () => {
    expect(notesContainExactLine(`a\n${line}`, line)).toBe(true)
    expect(notesContainExactLine(`a\r\n${line}\r\nb`, line)).toBe(true)
  })

  it.each([
    ['another flag', `x\n${flagMarkerLine(OTHER)}`],
    ['suffix', `${line}x`],
    ['prefix', `x${line}`],
    ['leading space', ` ${line}`],
    ['trailing space', `${line} `],
    ['inside a sentence', `see ${line} please`],
    ['case changed', line.toLowerCase().replace('str-app-ref', 'STR-app-ref')],
    ['uuid alone', FLAG],
  ])('rejects %s', (_l, notes) => {
    expect(notesContainExactLine(notes, line)).toBe(false)
  })

  it('exactMarkerMatches also requires membership of THIS project, and dedupes', () => {
    const tasks = [
      { gid: 'A', notes: line, projectGids: [P] },
      { gid: 'A', notes: line, projectGids: [P] },
      { gid: 'LIVE', notes: line, projectGids: ['1211426202387126'] },
      { gid: 'OTHER', notes: flagMarkerLine(OTHER), projectGids: [P] },
      { gid: 'NULL', notes: null, projectGids: [P] },
    ]
    expect(exactMarkerMatches(tasks, line, P)).toEqual(['A'])
  })

})

describe('LEGACY "Open in app:" matching — exact ROUTE, origin ignored', () => {
  const PROP = 'prop-1'
  const path = legacyFlagPath(PROP, FLAG)
  const has = (notes: string) => notesContainLegacyAppPath(notes, path)

  it('builds the route only from authoritative IDs', () => {
    expect(path).toBe(`/properties/${PROP}/flags/${FLAG}`)
    for (const bad of ['', 'a/b', 'a?b', 'a b', '..', 'p%2F1']) {
      expect(() => legacyFlagPath(bad, FLAG)).toThrow(/property id/)
    }
    expect(() => legacyFlagPath(PROP, 'flag-1')).toThrow(/not a UUID/)
  })

  it.each([
    ['the original origin', `Open in app: https://staging.example.com${path}`],
    ['a DIFFERENT valid origin (APP_BASE_URL changed)', `Open in app: https://app.drop-inn.co.za${path}`],
    ['http with a port', `Open in app: http://localhost:3000${path}`],
    ['inside full notes, CRLF', `Reported in the app.\r\n\r\nOpen in app: https://x.app${path}\r\n- Auto-created`],
  ])('MATCHES %s', (_l, notes) => {
    expect(has(notes)).toBe(true)
  })

  it.each([
    ['wrong flag UUID, same origin', `Open in app: https://staging.example.com/properties/${PROP}/flags/${OTHER}`],
    ['wrong property ID', `Open in app: https://staging.example.com/properties/prop-2/flags/${FLAG}`],
    ['UUID as loose text', `flag ${FLAG} at ${PROP}`],
    ['the path alone, no URL', `Open in app: ${path}`],
    ['extra path segment', `Open in app: https://x.app${path}/edit`],
    ['trailing slash', `Open in app: https://x.app${path}/`],
    ['base path prefix', `Open in app: https://x.app/app${path}`],
    ['query string', `Open in app: https://x.app${path}?x=1`],
    ['query trick carrying the path', `Open in app: https://x.app/?next=${path}`],
    ['fragment', `Open in app: https://x.app${path}#top`],
    ['fragment trick carrying the path', `Open in app: https://x.app/#${path}`],
    ['dot-segment trick', `Open in app: https://x.app/evil/..${path}`],
    ['percent-encoded variant', `Open in app: https://x.app/properties/${PROP}/flags/${FLAG.replace('-', '%2D')}`],
    ['credentials', `Open in app: https://user:pw@x.app${path}`],
    ['non-http scheme', `Open in app: ftp://x.app${path}`],
    ['javascript scheme', `Open in app: javascript://x.app${path}`],
    ['malformed authority', `Open in app: https://${path}`],
    ['malformed host', `Open in app: https://[bad${path}`],
    ['trailing text', `Open in app: https://x.app${path} (old)`],
    ['missing space', `Open in app:https://x.app${path}`],
    ['double space', `Open in app:  https://x.app${path}`],
    ['leading space', ` Open in app: https://x.app${path}`],
    ['different case', `open in app: https://x.app${path}`],
    ['inside a sentence', `See Open in app: https://x.app${path}`],
  ])('REJECTS %s', (_l, notes) => {
    expect(has(notes)).toBe(false)
  })
})

describe('resolveMatcher — always from authoritative IDs', () => {
  const PROP = 'prop-1'
  const legacyLine = `Open in app: https://new-origin.example${legacyFlagPath(PROP, FLAG)}`

  it('protocol-2 rows use ONLY the exact STR-APP-REF line', () => {
    const m = resolveMatcher(empty(), FLAG, PROP)
    expect(m).toMatchObject({ kind: 'flag_marker', storedMarker: flagMarkerLine(FLAG) })
    expect(m.matches(flagMarkerLine(FLAG))).toBe(true)
    expect(m.matches(legacyLine)).toBe(false)
  })

  it('a stored marker is never trusted as text (rebuilt from the flag UUID)', () => {
    const m = resolveMatcher({ ...empty(), marker: flagMarkerLine(OTHER) }, FLAG, PROP)
    expect(m.matches(flagMarkerLine(OTHER))).toBe(false)
    expect(m.matches(flagMarkerLine(FLAG))).toBe(true)
  })

  it('legacy rows (no protocol, or LEGACY_MARKER) use the exact route', () => {
    for (const s of [readCreateState({ flag_id: FLAG }), { ...empty(), marker: LEGACY_MARKER }]) {
      const m = resolveMatcher(s, FLAG, PROP)
      expect(m).toMatchObject({ kind: 'legacy_path', storedMarker: LEGACY_MARKER })
      expect(m.matches(legacyLine)).toBe(true)
      expect(m.matches(flagMarkerLine(FLAG))).toBe(false)
    }
  })
})

describe('response classification', () => {
  it.each([400, 401, 403, 404])('%i is a definite rejection (nothing created)', (status) => {
    expect(classifyCallError(new AsanaApiError('create task', status, 'x'))).toEqual({ kind: 'rejected', status })
  })

  it('429 honours Retry-After, with a fallback', () => {
    expect(classifyCallError(new AsanaApiError('create task', 429, 'x', 42))).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 42,
    })
    expect(classifyCallError(new AsanaApiError('create task', 429, 'x'))).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: RATE_LIMIT_FALLBACK_SECONDS,
    })
  })

  it.each([500, 502, 503, 504, 408, 409, 418, 302])('%i is AMBIGUOUS (conservative)', (status) => {
    expect(classifyCallError(new AsanaApiError('create task', status, 'x')).kind).toBe('ambiguous')
  })

  it('network errors, timeouts and unknown throws are AMBIGUOUS', () => {
    expect(classifyCallError(new TypeError('fetch failed')).kind).toBe('ambiguous')
    expect(classifyCallError(new DOMException('timed out', 'TimeoutError')).kind).toBe('ambiguous')
    expect(classifyCallError(new DOMException('aborted', 'AbortError')).kind).toBe('ambiguous')
    expect(classifyCallError('weird').kind).toBe('ambiguous')
  })
})

describe('two-check quarantine', () => {
  const attempted = (atMs: number): CreateState => startAttempt(empty(), flagMarkerLine(FLAG), atMs)

  it('one miss never permits a replacement', () => {
    const s = recordNotFound(attempted(T0), T0 + 30 * MIN)
    expect(s.notFoundCount).toBe(1)
    expect(replacementPermitted(s, T0 + 60 * MIN)).toBe(false)
  })

  it('a second miss closer than the spacing is NOT counted', () => {
    let s = recordNotFound(attempted(T0), T0 + 10 * MIN)
    s = recordNotFound(s, T0 + 10 * MIN + RECONCILE_SPACING_MS - 1)
    expect(s.notFoundCount).toBe(1)
    expect(replacementPermitted(s, T0 + 60 * MIN)).toBe(false)
  })

  it('two spaced misses but < quarantine age since the attempt: not yet', () => {
    let s = recordNotFound(attempted(T0), T0)
    s = recordNotFound(s, T0 + RECONCILE_SPACING_MS)
    expect(s.notFoundCount).toBe(2)
    expect(replacementPermitted(s, T0 + AMBIGUOUS_QUARANTINE_MS - 1)).toBe(false)
    expect(replacementPermitted(s, T0 + AMBIGUOUS_QUARANTINE_MS)).toBe(true)
  })

  it('a missing / bad attempt time never permits', () => {
    const s = { ...empty(), notFoundCount: 5, attemptedAt: 'garbage' }
    expect(replacementPermitted(s, T0)).toBe(false)
    expect(replacementPermitted({ ...s, attemptedAt: null }, T0)).toBe(false)
  })

  it('startAttempt resets the counters; clearAttempt forgets a definite non-creation', () => {
    let s = recordNotFound(attempted(T0), T0 + 5 * MIN)
    s = startAttempt(s, flagMarkerLine(FLAG), T0 + 20 * MIN)
    expect(s).toMatchObject({ notFoundCount: 0, lastReconciledAt: null, createdTaskGid: null })
    expect(clearAttempt(s)).toMatchObject({ attemptedAt: null, notFoundCount: 0 })
  })

  it('mustReconcile: an attempt on record, or a LEGACY row (no protocol)', () => {
    expect(mustReconcile(empty())).toBe(false)
    expect(mustReconcile(attempted(T0))).toBe(true)
    expect(mustReconcile(readCreateState({ flag_id: FLAG }))).toBe(true)
  })
})

describe('payload state merge', () => {
  it('preserves every existing payload key and never drops the enqueue hints', () => {
    const before = { flag_id: FLAG, property_id: 'p', category_key: 'k', create_protocol: CREATE_PROTOCOL }
    const s = startAttempt(readCreateState(before), flagMarkerLine(FLAG), T0)
    const merged = mergeCreateState(before, s)
    expect(merged).toMatchObject(before)
    expect(merged).toMatchObject({
      create_marker: flagMarkerLine(FLAG),
      create_attempted_at: new Date(T0).toISOString(),
      created_task_gid: null,
      reconciliation_not_found_count: 0,
      last_reconciled_at: null,
    })
    expect(readCreateState(merged)).toEqual(s)
  })

  it('reads tolerantly (garbage values become safe defaults)', () => {
    expect(readCreateState({ reconciliation_not_found_count: -3, created_task_gid: 7, create_marker: '' })).toMatchObject({
      notFoundCount: 0,
      createdTaskGid: null,
      marker: null,
      protocol: null,
    })
  })
})
