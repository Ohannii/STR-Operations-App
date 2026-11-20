/**
 * Keeping a saved issue's Asana status up to date on the pack page (pure).
 *
 * The page asks a small read-only endpoint for the status of the issues
 * that are still "in flight" and updates ONLY those status labels in place.
 * No navigation, no page refresh, no re-render of the pack: captions, an
 * open issue form and the scroll position are untouched.
 */

import type { AsanaIssueStatus } from '@/lib/issues/asana-status'

const STATUSES: readonly AsanaIssueStatus[] = ['in_asana', 'queued', 'needs_attention', 'not_sent', 'unknown']

/** Statuses that can still change by themselves: keep checking these. */
export function isAsanaStatusPending(status: AsanaIssueStatus): boolean {
  return status === 'queued' || status === 'unknown'
}

/** Stop after this many checks (about 13 minutes); a reload starts again. */
export const ASANA_STATUS_MAX_POLLS = 30

/** Quick at first (the worker usually finishes within minutes), then every 30 s. */
export function nextAsanaStatusPollDelayMs(attempt: number): number {
  const steps = [4_000, 6_000, 10_000, 15_000, 20_000]
  return attempt >= 0 && attempt < steps.length ? steps[attempt] : 30_000
}

/** At most this many issues per request. */
export const ASANA_STATUS_MAX_IDS = 20

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Parse the `ids` query: valid, de-duplicated UUIDs only; null if unusable. */
export function parseStatusIds(raw: string | null): string[] | null {
  if (!raw) return null
  const ids = Array.from(new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)))
  if (ids.length === 0 || ids.length > ASANA_STATUS_MAX_IDS || !ids.every((id) => UUID_RE.test(id))) return null
  return ids
}

/** Defensive parse of the endpoint's response: only known statuses survive. */
export function parseStatusResponse(json: unknown): Record<string, AsanaIssueStatus> {
  const out: Record<string, AsanaIssueStatus> = {}
  const statuses = (json as { statuses?: unknown } | null)?.statuses
  if (typeof statuses !== 'object' || statuses === null) return out
  for (const [id, value] of Object.entries(statuses as Record<string, unknown>)) {
    if (typeof value === 'string' && (STATUSES as readonly string[]).includes(value)) {
      out[id.toLowerCase()] = value as AsanaIssueStatus
    }
  }
  return out
}

/**
 * Apply fresh statuses to the saved-issue list. Returns the SAME array when
 * nothing changed (so React does not re-render). An issue is never removed
 * and never downgraded from a proven "In Asana" by a later uncertain read.
 */
export function mergeIssueStatuses<T extends { flagId: string; asanaStatus: AsanaIssueStatus }>(
  saved: T[],
  fresh: Record<string, AsanaIssueStatus>,
): T[] {
  let changed = false
  const next = saved.map((issue) => {
    const status = fresh[issue.flagId.toLowerCase()]
    if (!status || status === issue.asanaStatus) return issue
    if (issue.asanaStatus === 'in_asana') return issue
    if (status === 'unknown') return issue // a failed check never replaces a known status
    changed = true
    return { ...issue, asanaStatus: status }
  })
  return changed ? next : saved
}
