/**
 * Asana task-creation IDEMPOTENCY — pure decision logic (Stage 0).
 *
 * Asana's create-task endpoint has no documented idempotency key, so the
 * worker cannot make "exactly once" a guarantee. It combines:
 *   - GUARANTEED prevention where the outcome is known (atomic project +
 *     section membership; a saved task GID is always reused; definite
 *     rejections are known to have created nothing);
 *   - RECONCILIATION where the outcome is ambiguous (lost response,
 *     timeout, 5xx, crash after sending): an exact, deterministic marker
 *     line in the task notes is looked up in the BETA project;
 *   - a QUARANTINE before any replacement attempt after an ambiguous
 *     outcome (two spaced "not found" checks and a minimum age).
 * The residual risks are documented in the Stage 0 audit.
 *
 * PURE: no I/O. Worker state lives in integration_outbox.payload (JSONB);
 * these helpers read and merge it without touching any other payload key.
 */

import { AsanaApiError } from '@/lib/integrations/asana/client'

/** Create rows enqueued after this feature carry this protocol marker. */
export const CREATE_PROTOCOL = 2

/** Not-found reconciliations required before a replacement attempt. */
export const RECONCILE_MIN_NOT_FOUND = 2
/** Minimum spacing between two counted not-found reconciliations. */
export const RECONCILE_SPACING_MS = 5 * 60_000
/** Minimum age of an ambiguous attempt before any replacement attempt. */
export const AMBIGUOUS_QUARANTINE_MS = 10 * 60_000
/** Look back this far before the outbox row's creation when reconciling. */
export const LOOKUP_MARGIN_MS = 2 * 60_000
/** Fallback wait when a 429 carries no usable Retry-After. */
export const RATE_LIMIT_FALLBACK_SECONDS = 30

/** Worker-owned payload keys (never written by the enqueue path). */
export const STATE_KEYS = {
  protocol: 'create_protocol',
  marker: 'create_marker',
  attemptedAt: 'create_attempted_at',
  createdTaskGid: 'created_task_gid',
  notFoundCount: 'reconciliation_not_found_count',
  lastReconciledAt: 'last_reconciled_at',
} as const

export type CreateState = {
  /** CREATE_PROTOCOL for rows enqueued by this version; null = legacy row. */
  protocol: number | null
  /** The exact notes line that identifies this flag's task. */
  marker: string | null
  /** ISO time of the last create attempt whose outcome may be ambiguous. */
  attemptedAt: string | null
  createdTaskGid: string | null
  notFoundCount: number
  /** ISO time of the last COUNTED not-found reconciliation. */
  lastReconciledAt: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

export function readCreateState(payload: Record<string, unknown> | null | undefined): CreateState {
  const p = payload ?? {}
  const count = p[STATE_KEYS.notFoundCount]
  return {
    protocol: typeof p[STATE_KEYS.protocol] === 'number' ? (p[STATE_KEYS.protocol] as number) : null,
    marker: str(p[STATE_KEYS.marker]),
    attemptedAt: str(p[STATE_KEYS.attemptedAt]),
    createdTaskGid: str(p[STATE_KEYS.createdTaskGid]),
    notFoundCount: typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0,
    lastReconciledAt: str(p[STATE_KEYS.lastReconciledAt]),
  }
}

/**
 * Merge worker state into the existing payload. Every non-state key (e.g.
 * flag_id, property_id, category_key) is preserved exactly; null state
 * values are written as null so a cleared value cannot resurface.
 */
export function mergeCreateState(
  payload: Record<string, unknown> | null | undefined,
  state: CreateState,
): Record<string, unknown> {
  return {
    ...(payload ?? {}),
    ...(state.protocol !== null ? { [STATE_KEYS.protocol]: state.protocol } : {}),
    [STATE_KEYS.marker]: state.marker,
    [STATE_KEYS.attemptedAt]: state.attemptedAt,
    [STATE_KEYS.createdTaskGid]: state.createdTaskGid,
    [STATE_KEYS.notFoundCount]: state.notFoundCount,
    [STATE_KEYS.lastReconciledAt]: state.lastReconciledAt,
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The deterministic marker line for a flag's task. Built ONLY from the
 * authoritative flag UUID (privacy-safe: an internal id, no names, no
 * guest data). A non-UUID id throws rather than produce an ambiguous line.
 */
export function flagMarkerLine(flagId: string): string {
  if (!UUID.test(flagId)) throw new Error('flag id is not a UUID; refusing to build a marker')
  return `STR-APP-REF: flag/${flagId.toLowerCase()}`
}

// ----------------------------------------------------------------
// Legacy (pre-Stage-0) tasks: matched by the exact app ROUTE, not origin
// ----------------------------------------------------------------

/**
 * Stored as create_marker for a LEGACY row. It is a kind, not notes text:
 * the expected route is always rebuilt from the authoritative property ID
 * and flag UUID at run time.
 */
export const LEGACY_MARKER = 'legacy:open_in_app_path'

/** The exact prefix of the line legacy tasks carry ("Open in app: <url>"). */
export const LEGACY_LINE_PREFIX = 'Open in app: '

const PROPERTY_ID = /^[A-Za-z0-9-]+$/

/**
 * The exact app route a legacy task's "Open in app:" URL must have:
 * /properties/<property ID>/flags/<flag UUID>. Built only from
 * authoritative IDs; anything that could alter the route throws.
 */
export function legacyFlagPath(propertyId: string, flagId: string): string {
  if (!UUID.test(flagId)) throw new Error('flag id is not a UUID; refusing to build a legacy path')
  if (!PROPERTY_ID.test(propertyId)) throw new Error('property id is malformed; refusing to build a legacy path')
  return `/properties/${propertyId}/flags/${flagId}`
}

/** scheme://authority/path — no whitespace, query or fragment allowed. */
const LEGACY_URL = /^(https?):\/\/([^\s/?#]+)(\/[^\s?#]*)$/

/**
 * LEGACY reconciliation only. True when the notes contain a line that is
 * EXACTLY "Open in app: <url>" where <url> is a valid http(s) URL whose
 * COMPLETE path equals `expectedPath`.
 *
 * The URL ORIGIN IS INTENTIONALLY IGNORED here (and only here): legacy
 * tasks embed APP_BASE_URL as it was when they were created, and a
 * deployment may since have moved to another origin. Identity comes from
 * the route, which carries the authoritative property ID and flag UUID.
 *
 * Rejected: any other line format (prefix, case, spacing), non-http(s)
 * schemes, malformed URLs, credentials, a query or fragment, a trailing
 * slash, extra / missing segments, dot-segments or percent-encoded
 * variants of the path (the RAW path must equal the expected path, and
 * the parsed path must agree), and loose text containing the UUID.
 * Protocol-2 rows never use this: they match the exact STR-APP-REF line.
 */
export function notesContainLegacyAppPath(notes: unknown, expectedPath: string): boolean {
  if (typeof notes !== 'string' || !expectedPath.startsWith('/')) return false
  return notes.split('\n').some((raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.startsWith(LEGACY_LINE_PREFIX)) return false
    const urlText = line.slice(LEGACY_LINE_PREFIX.length)
    const m = LEGACY_URL.exec(urlText)
    if (!m || m[3] !== expectedPath) return false
    let url: URL
    try {
      url = new URL(urlText)
    } catch {
      return false
    }
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname.length > 0 &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname === expectedPath
    )
  })
}

/**
 * EXACT line match: the notes must contain `line` as a complete line
 * (only a trailing "\r" from CRLF notes is tolerated). Never a substring,
 * never case-insensitive, never trimmed.
 */
export function notesContainExactLine(notes: unknown, line: string): boolean {
  if (typeof notes !== 'string' || !line) return false
  return notes.split('\n').some((l) => (l.endsWith('\r') ? l.slice(0, -1) : l) === line)
}

export type ReconcileTask = { gid: string; notes: string | null; projectGids: string[] }

/** Decides whether a task's notes identify THIS flag. */
export type NotesMatcher = (notes: unknown) => boolean

/**
 * GIDs of tasks IN `projectGid` whose notes match. A string is an exact
 * marker line; a function is a structured matcher (legacy route).
 */
export function exactMarkerMatches(
  tasks: ReadonlyArray<ReconcileTask>,
  match: string | NotesMatcher,
  projectGid: string,
): string[] {
  const matches: NotesMatcher =
    typeof match === 'string' ? (notes) => notesContainExactLine(notes, match) : match
  return [
    ...new Set(
      tasks.filter((t) => t.projectGids.includes(projectGid) && matches(t.notes)).map((t) => t.gid),
    ),
  ]
}

export type ResolvedMatcher = {
  kind: 'flag_marker' | 'legacy_path'
  /** The value stored in create_marker for this row. */
  storedMarker: string
  matches: NotesMatcher
}

/**
 * How THIS row's task is recognised, always from authoritative IDs:
 *   - a LEGACY row (marker LEGACY_MARKER, or no marker and no protocol)
 *     -> the exact "Open in app:" route (origin ignored);
 *   - otherwise -> the exact STR-APP-REF line for the flag UUID. A stored
 *     marker is never trusted as text: the line is rebuilt from the ID.
 */
export function resolveMatcher(
  state: CreateState,
  flagId: string,
  propertyId: string,
): ResolvedMatcher {
  const legacy =
    state.marker === LEGACY_MARKER || (state.marker === null && state.protocol !== CREATE_PROTOCOL)
  if (legacy) {
    const path = legacyFlagPath(propertyId, flagId)
    return {
      kind: 'legacy_path',
      storedMarker: LEGACY_MARKER,
      matches: (notes) => notesContainLegacyAppPath(notes, path),
    }
  }
  const line = flagMarkerLine(flagId)
  return {
    kind: 'flag_marker',
    storedMarker: line,
    matches: (notes) => notesContainExactLine(notes, line),
  }
}

// ----------------------------------------------------------------
// Response classification
// ----------------------------------------------------------------

export type CallFailure =
  /** Asana answered and refused: nothing was created. */
  | { kind: 'rejected'; status: number }
  /** Asana answered 429: not processed; wait Retry-After. */
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  /** Network error, timeout, 5xx or anything unknown: may have been processed. */
  | { kind: 'ambiguous'; status?: number }

const DEFINITE_REJECTIONS = new Set([400, 401, 403, 404])

export function classifyCallError(err: unknown): CallFailure {
  if (err instanceof AsanaApiError) {
    if (err.status === 429) {
      return {
        kind: 'rate_limited',
        retryAfterSeconds:
          typeof err.retryAfterSeconds === 'number' && err.retryAfterSeconds >= 0
            ? err.retryAfterSeconds
            : RATE_LIMIT_FALLBACK_SECONDS,
      }
    }
    if (DEFINITE_REJECTIONS.has(err.status)) return { kind: 'rejected', status: err.status }
    return { kind: 'ambiguous', status: err.status } // 5xx and anything unrecognised
  }
  return { kind: 'ambiguous' } // network error, abort / timeout, unknown
}

// ----------------------------------------------------------------
// Reconciliation decisions
// ----------------------------------------------------------------

/** True when this row must reconcile before any create request. */
export function mustReconcile(state: CreateState): boolean {
  return state.attemptedAt !== null || state.protocol !== CREATE_PROTOCOL
}

/**
 * Record one successful not-found reconciliation. It COUNTS only when it is
 * at least RECONCILE_SPACING_MS after the previous counted one.
 */
export function recordNotFound(state: CreateState, nowMs: number): CreateState {
  const last = state.lastReconciledAt ? Date.parse(state.lastReconciledAt) : NaN
  if (Number.isFinite(last) && nowMs - last < RECONCILE_SPACING_MS) return state
  return {
    ...state,
    notFoundCount: state.notFoundCount + 1,
    lastReconciledAt: new Date(nowMs).toISOString(),
  }
}

/**
 * A replacement create is permitted only when ALL hold:
 *   - at least RECONCILE_MIN_NOT_FOUND counted not-found checks
 *     (counted only when spaced >= RECONCILE_SPACING_MS apart);
 *   - at least AMBIGUOUS_QUARANTINE_MS since the ambiguous attempt.
 * A missing / unparseable attempt time never permits.
 */
export function replacementPermitted(state: CreateState, nowMs: number): boolean {
  if (state.notFoundCount < RECONCILE_MIN_NOT_FOUND) return false
  const attempted = state.attemptedAt ? Date.parse(state.attemptedAt) : NaN
  if (!Number.isFinite(attempted)) return false
  return nowMs - attempted >= AMBIGUOUS_QUARANTINE_MS
}

/** Milliseconds until the next useful reconciliation. */
export function nextReconcileDelayMs(state: CreateState, nowMs: number): number {
  const attempted = state.attemptedAt ? Date.parse(state.attemptedAt) : NaN
  const untilQuarantine = Number.isFinite(attempted)
    ? attempted + AMBIGUOUS_QUARANTINE_MS - nowMs
    : RECONCILE_SPACING_MS
  return Math.max(RECONCILE_SPACING_MS, untilQuarantine, 0)
}

/** State for a fresh create attempt (counters reset). */
export function startAttempt(state: CreateState, marker: string, nowMs: number): CreateState {
  return {
    ...state,
    marker,
    attemptedAt: new Date(nowMs).toISOString(),
    createdTaskGid: null,
    notFoundCount: 0,
    lastReconciledAt: null,
  }
}

/** After a DEFINITE non-creation (rejection or 429): nothing to reconcile. */
export function clearAttempt(state: CreateState): CreateState {
  return { ...state, attemptedAt: null, notFoundCount: 0, lastReconciledAt: null }
}

/** Stable, value-free error codes (stored in last_error / logged). */
export const CODES = {
  lostLock: 'lost_lock',
  createAmbiguous: 'create_ambiguous',
  createRejected: (status: number) => `create_rejected_http_${status}`,
  lookupFailed: 'reconcile_lookup_failed',
  savedTaskReadFailed: 'saved_task_read_failed',
  linkInsertFailed: 'link_insert_failed',
  linkReadFailed: 'link_read_failed',
  flagUrlUpdateFailed: 'flag_url_update_failed',
  manualLinkConflict: 'manual_review:link_conflict',
  manualLinkIncomplete: 'manual_review:link_incomplete',
  manualSavedTaskMissing: 'manual_review:saved_task_missing',
  manualSavedTaskMismatch: 'manual_review:saved_task_mismatch',
  manualDuplicateTasks: 'manual_review:duplicate_tasks',
  flagNotFound: 'flag not found',
} as const
