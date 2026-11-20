import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ASANA_STATUS_MAX_IDS,
  ASANA_STATUS_MAX_POLLS,
  isAsanaStatusPending,
  mergeIssueStatuses,
  nextAsanaStatusPollDelayMs,
  parseStatusIds,
  parseStatusResponse,
} from '@/lib/issues/asana-status-poll'
import type { AsanaIssueStatus } from '@/lib/issues/asana-status'

/** The saved issue's Asana status updates itself, in place. */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const issue = (flagId: string, asanaStatus: AsanaIssueStatus) => ({ flagId, asanaStatus })

describe('which statuses keep being checked', () => {
  it('only "queued" and "unknown" can still change by themselves', () => {
    expect((['in_asana', 'queued', 'needs_attention', 'not_sent', 'unknown'] as const).filter(isAsanaStatusPending)).toEqual(['queued', 'unknown'])
  })

  it('the checks are bounded and back off', () => {
    const delays = Array.from({ length: ASANA_STATUS_MAX_POLLS }, (_, i) => nextAsanaStatusPollDelayMs(i))
    expect(delays.slice(0, 6)).toEqual([4_000, 6_000, 10_000, 15_000, 20_000, 30_000])
    expect(Math.max(...delays)).toBe(30_000)
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(4_000)
    const total = delays.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(10 * 60_000)
    expect(total).toBeLessThan(20 * 60_000)
  })
})

describe('mergeIssueStatuses', () => {
  it('"Sending to Asana" becomes "In Asana" when the task link is saved', () => {
    const saved = [issue(A, 'queued'), issue(B, 'queued')]
    const next = mergeIssueStatuses(saved, { [A]: 'in_asana' })
    expect(next).toEqual([issue(A, 'in_asana'), issue(B, 'queued')])
    expect(next[1]).toBe(saved[1]) // untouched issue keeps its identity
  })

  it('nothing changed -> the SAME array (no re-render at all)', () => {
    const saved = [issue(A, 'queued')]
    expect(mergeIssueStatuses(saved, { [A]: 'queued' })).toBe(saved)
    expect(mergeIssueStatuses(saved, {})).toBe(saved)
    expect(mergeIssueStatuses(saved, { [B]: 'in_asana' })).toBe(saved)
  })

  it('a failed check ("unknown") never replaces a known status; "In Asana" is never downgraded', () => {
    const saved = [issue(A, 'queued'), issue(B, 'in_asana')]
    expect(mergeIssueStatuses(saved, { [A]: 'unknown', [B]: 'not_sent' })).toBe(saved)
  })

  it('a stopped job is shown as needing attention; an issue is never removed', () => {
    const saved = [issue(A, 'queued'), issue(B, 'unknown')]
    expect(mergeIssueStatuses(saved, { [A]: 'needs_attention', [B]: 'queued' })).toEqual([issue(A, 'needs_attention'), issue(B, 'queued')])
  })

  it('ids are matched case-insensitively', () => {
    expect(mergeIssueStatuses([issue(A.toUpperCase(), 'queued')], { [A]: 'in_asana' })[0].asanaStatus).toBe('in_asana')
  })
})

describe('request / response parsing', () => {
  it('ids: valid, de-duplicated UUIDs only', () => {
    expect(parseStatusIds(`${A},${B},${A}`)).toEqual([A, B])
    expect(parseStatusIds(` ${A.toUpperCase()} `)).toEqual([A])
    for (const bad of [null, '', ',', 'abc', `${A},not-a-uuid`, `${A};drop table`]) expect(parseStatusIds(bad)).toBeNull()
    const many = Array.from({ length: ASANA_STATUS_MAX_IDS + 1 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`).join(',')
    expect(parseStatusIds(many)).toBeNull()
  })

  it('response: only known statuses survive', () => {
    expect(parseStatusResponse({ statuses: { [A]: 'in_asana', [B]: 'hacked', x: 5 } })).toEqual({ [A]: 'in_asana' })
    for (const bad of [null, undefined, 'x', {}, { statuses: null }, { statuses: 'x' }]) expect(parseStatusResponse(bad)).toEqual({})
  })
})

describe('source contracts: the update happens in place', () => {
  const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('the pack photo card never refreshes or navigates the page to update a status', () => {
    const src = code('src/components/photos/pack-photo-issue.tsx')
    expect(src).not.toMatch(/router\.refresh|useRouter|location\.(reload|href|assign|replace)|revalidatePath/)
    expect(src).toContain('setSaved((list) => mergeIssueStatuses(list, fresh))')
    expect(src).toContain("document.visibilityState === 'visible'")
    expect(src).toContain('attempt >= ASANA_STATUS_MAX_POLLS')
    expect(src).toContain('clearTimeout(timer)')
    // a plain GET, not a server action (which would queue behind / ahead of a save)
    expect(src).toContain('fetch(`/api/issues/asana-status?ids=')
  })

  it('the status endpoint is read-only, signed-in only, RLS-scoped and never cached', () => {
    const src = code('src/app/api/issues/asana-status/route.ts')
    expect(src).not.toMatch(/createServiceClient|\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(|export async function (POST|PUT|PATCH|DELETE)/)
    expect(src.indexOf('getUserContext()')).toBeGreaterThan(-1)
    expect(src.indexOf('getUserContext()')).toBeLessThan(src.indexOf('loadFlagAsanaStatuses('))
    expect(src).toContain('loadFlagAsanaStatuses(supabase, ctx.company.id, ids)')
    expect(src).toContain("'Cache-Control': 'no-store'")
  })
})
