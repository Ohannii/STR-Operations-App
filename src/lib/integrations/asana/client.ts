/**
 * Thin Asana REST client (Slice 6).
 *
 * Offline-testable: uses the global `fetch`, takes the token as a
 * parameter (never reads env, never stores it), and never puts the
 * token in an error message or log. No real call is made in this slice
 * — tests mock `fetch`.
 */

const ASANA_API_BASE = 'https://app.asana.com/api/1.0'

export interface CreateTaskArgs {
  projectGid: string
  /** Section placement happens IN the create request (atomic membership). */
  sectionGid: string
  name: string
  notes: string
  /** YYYY-MM-DD. Only sent when present. */
  dueOn?: string
  /**
   * Custom-field values keyed by field GID (enum: option GID; multi_enum:
   * option GIDs; text: string). Sent as `custom_fields` ONLY when present
   * and non-empty. The provider guarantees they are BETA-configured GIDs.
   */
  customFields?: Record<string, string | string[]>
}

/** True when there is at least one custom-field value to send. */
export function hasCustomFields(
  fields: Record<string, string | string[]> | undefined,
): fields is Record<string, string | string[]> {
  return fields !== undefined && fields !== null && Object.keys(fields).length > 0
}

/** Explicit per-request timeout for the create / reconcile calls (Stage 0). */
export const ASANA_REQUEST_TIMEOUT_MS = 30_000

/**
 * fetch + read under ONE explicit timeout that covers the whole exchange
 * (headers AND body). The timer is ALWAYS cleared in `finally` — on
 * success, on an HTTP error thrown by `read`, and on a network / abort
 * error — so no timer outlives the request.
 */
async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException('Asana request timed out', 'TimeoutError')),
    ASANA_REQUEST_TIMEOUT_MS,
  )
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    return await read(res)
  } finally {
    clearTimeout(timer)
  }
}

export interface CreatedTask {
  gid: string
  permalinkUrl: string
}

/** Error carrying the HTTP status. Its message never includes the token. */
export class AsanaApiError extends Error {
  readonly status: number
  /** Seconds to wait, parsed from a 429 Retry-After header (if any). */
  readonly retryAfterSeconds?: number
  constructor(operation: string, status: number, detail: string, retryAfterSeconds?: number) {
    super(`Asana ${operation} failed (HTTP ${status}): ${detail}`)
    this.name = 'AsanaApiError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Parse a Retry-After header (seconds, or an HTTP-date) into whole seconds. */
export function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs)
  const when = Date.parse(raw)
  if (!Number.isNaN(when)) return Math.max(0, Math.ceil((when - Date.now()) / 1000))
  return undefined
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}

/** Auth headers WITHOUT Content-Type — for multipart, so fetch sets the boundary. */
function authHeadersMultipart(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' }
}

async function throwAsana(operation: string, res: Response): Promise<never> {
  const retryAfter = res.status === 429 ? parseRetryAfter(res) : undefined
  throw new AsanaApiError(operation, res.status, await safeErrorDetail(res), retryAfter)
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text ? text.slice(0, 500) : '(no response body)'
  } catch {
    return '(unreadable response body)'
  }
}

/**
 * Create a task DIRECTLY in its project AND section in ONE request:
 * `projects: [project]` gives Asana the project (and so the workspace)
 * context it requires, and `memberships: [{ project, section }]` places the
 * task in its section — both from the same projectGid. There is no separate
 * section call that could fail after the task exists. Returns its gid +
 * permalink. Throws AsanaApiError (with Retry-After on 429) or a network /
 * timeout error.
 */
export async function createTaskInProject(
  token: string,
  args: CreateTaskArgs,
): Promise<CreatedTask> {
  const { status, json } = await fetchWithTimeout(
    `${ASANA_API_BASE}/tasks?opt_fields=permalink_url`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        data: {
          name: args.name,
          notes: args.notes,
          projects: [args.projectGid],
          memberships: [{ project: args.projectGid, section: args.sectionGid }],
          ...(args.dueOn ? { due_on: args.dueOn } : {}),
          ...(hasCustomFields(args.customFields) ? { custom_fields: args.customFields } : {}),
        },
      }),
    },
    async (res) => {
      if (!res.ok) await throwAsana('create task', res)
      return {
        status: res.status,
        json: (await res.json()) as { data?: { gid?: string; permalink_url?: string } },
      }
    },
  )
  const gid = json?.data?.gid
  if (!gid) {
    throw new AsanaApiError('create task', status, 'missing task gid in response')
  }
  const permalinkUrl =
    typeof json.data?.permalink_url === 'string' && json.data.permalink_url
      ? json.data.permalink_url
      : `https://app.asana.com/0/0/${gid}`

  return { gid, permalinkUrl }
}

/** Max custom-field-setting pages read for one project (100 per page). */
export const FIELD_SETTINGS_MAX_PAGES = 20

/**
 * READ-ONLY (Phase 1, hardened): EVERY custom-field setting of a project —
 * GET /projects/{gid}/custom_field_settings, paginated (limit=100, following
 * next_page.offset until null). Each setting is requested with exactly the
 * nested properties the validator needs (never Asana's compact default):
 * parent project GID, field GID, resource_subtype, enum option GID + enabled.
 *
 * Returns `{ gid, custom_field_settings }` for field-validation.ts to parse
 * defensively. THROWS on any HTTP error (AsanaApiError, with the 429
 * Retry-After), a malformed page, a repeated offset or too many pages — the
 * non-throwing wrapper (field-schema.ts) turns every failure into "no usable
 * fields". A GET cannot modify the project, so it is not behind the write
 * allowlist.
 */
export async function getProjectCustomFieldSettings(
  token: string,
  projectGid: string,
): Promise<{ gid: string; custom_field_settings: unknown[] }> {
  const settings: unknown[] = []
  const seenOffsets = new Set<string>()
  let offset: string | undefined
  for (let page = 0; ; page++) {
    if (page >= FIELD_SETTINGS_MAX_PAGES) {
      throw new Error(`custom field settings exceeded ${FIELD_SETTINGS_MAX_PAGES} pages`)
    }
    const url = new URL(
      `${ASANA_API_BASE}/projects/${encodeURIComponent(projectGid)}/custom_field_settings`,
    )
    url.searchParams.set('limit', '100')
    url.searchParams.set(
      'opt_fields',
      [
        // `parent` is current; `project` is Asana's deprecated alias — both
        // are requested and the validator accepts either (never neither).
        'parent.gid',
        'project.gid',
        'custom_field.gid',
        'custom_field.resource_subtype',
        'custom_field.enum_options.gid',
        'custom_field.enum_options.enabled',
      ].join(','),
    )
    if (offset) url.searchParams.set('offset', offset)

    // Bounded: the same per-request timeout as the create / reconcile calls.
    const json = await fetchWithTimeout(
      url.toString(),
      { method: 'GET', headers: authHeaders(token) },
      async (res) => {
        if (!res.ok) await throwAsana('read project fields', res)
        return (await res.json()) as { data?: unknown; next_page?: unknown }
      },
    )
    if (!json || !Array.isArray(json.data)) {
      throw new Error('custom field settings page is malformed')
    }
    settings.push(...json.data)

    // FAIL CLOSED: because limit=100 is supplied, Asana always returns
    // `next_page` — null when complete, an object with an offset when not.
    // A missing or damaged next_page must never read as "no more pages",
    // or a truncated schema would be validated as if it were complete.
    if (!('next_page' in json)) {
      throw new Error('custom field settings pagination is malformed')
    }
    const nextPage = json.next_page
    if (nextPage === null) break
    if (typeof nextPage !== 'object' || Array.isArray(nextPage)) {
      throw new Error('custom field settings pagination is malformed')
    }
    const next = (nextPage as { offset?: unknown }).offset
    if (typeof next !== 'string' || next.trim().length === 0) {
      throw new Error('custom field settings pagination offset is malformed')
    }
    if (seenOffsets.has(next)) {
      throw new Error('custom field settings pagination repeated an offset')
    }
    seenOffsets.add(next)
    offset = next
  }
  return { gid: projectGid, custom_field_settings: settings }
}

/** Fallback task URL (used when the permalink is not part of the response). */
export function taskUrlForGid(gid: string): string {
  return `https://app.asana.com/0/0/${gid}`
}

export type ReconcileTaskRecord = {
  gid: string
  notes: string | null
  projectGids: string[]
}

function toReconcileTask(raw: unknown): ReconcileTaskRecord | null {
  const t = raw as { gid?: unknown; notes?: unknown; memberships?: unknown } | null
  if (!t || typeof t.gid !== 'string' || !t.gid) return null
  const memberships = Array.isArray(t.memberships) ? t.memberships : []
  const projectGids = memberships
    .map((m) => (m as { project?: { gid?: unknown } } | null)?.project?.gid)
    .filter((g): g is string => typeof g === 'string' && g.length > 0)
  return { gid: t.gid, notes: typeof t.notes === 'string' ? t.notes : null, projectGids }
}

/**
 * READ-ONLY (Stage 0): one task by GID — notes and project memberships only.
 * Returns null on 404 (deleted / not visible). Throws AsanaApiError for any
 * other HTTP failure, or a network / timeout error.
 */
export async function getTaskForReconciliation(
  token: string,
  taskGid: string,
): Promise<ReconcileTaskRecord | null> {
  const url = new URL(`${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}`)
  url.searchParams.set('opt_fields', 'notes,memberships.project.gid')
  const json = await fetchWithTimeout(
    url.toString(),
    { method: 'GET', headers: authHeaders(token) },
    async (res) => {
      if (res.status === 404) return null
      if (!res.ok) await throwAsana('read task', res)
      return (await res.json()) as { data?: unknown }
    },
  )
  if (json === null) return null
  const task = toReconcileTask(json?.data)
  if (!task) throw new Error('task read is malformed')
  return task
}

/** Max task pages read for one reconciliation lookup (100 per page). */
export const RECONCILE_MAX_PAGES = 20

/**
 * READ-ONLY (Stage 0): every task of ONE project modified since
 * `modifiedSinceIso` — GID, notes and project memberships only. Paginated
 * (limit=100) and FAIL-CLOSED: a malformed page, a missing / damaged
 * next_page, a repeated offset or more than RECONCILE_MAX_PAGES pages
 * THROWS, so an incomplete list can never read as "not found".
 */
export async function listProjectTasksModifiedSince(
  token: string,
  projectGid: string,
  modifiedSinceIso: string,
): Promise<ReconcileTaskRecord[]> {
  const tasks: ReconcileTaskRecord[] = []
  const seenOffsets = new Set<string>()
  let offset: string | undefined
  for (let page = 0; ; page++) {
    if (page >= RECONCILE_MAX_PAGES) {
      throw new Error(`reconciliation lookup exceeded ${RECONCILE_MAX_PAGES} pages`)
    }
    const url = new URL(`${ASANA_API_BASE}/tasks`)
    url.searchParams.set('project', projectGid)
    url.searchParams.set('modified_since', modifiedSinceIso)
    url.searchParams.set('limit', '100')
    url.searchParams.set('opt_fields', 'notes,memberships.project.gid')
    if (offset) url.searchParams.set('offset', offset)

    const json = await fetchWithTimeout(
      url.toString(),
      { method: 'GET', headers: authHeaders(token) },
      async (res) => {
        if (!res.ok) await throwAsana('reconcile tasks', res)
        return (await res.json()) as { data?: unknown; next_page?: unknown }
      },
    )
    if (!json || !Array.isArray(json.data)) throw new Error('reconciliation page is malformed')
    for (const raw of json.data) {
      const task = toReconcileTask(raw)
      if (!task) throw new Error('reconciliation task is malformed')
      tasks.push(task)
    }
    if (!('next_page' in json)) throw new Error('reconciliation pagination is malformed')
    const nextPage = json.next_page
    if (nextPage === null) break
    if (typeof nextPage !== 'object' || Array.isArray(nextPage)) {
      throw new Error('reconciliation pagination is malformed')
    }
    const next = (nextPage as { offset?: unknown }).offset
    if (typeof next !== 'string' || next.trim().length === 0) {
      throw new Error('reconciliation pagination offset is malformed')
    }
    if (seenOffsets.has(next)) throw new Error('reconciliation pagination repeated an offset')
    seenOffsets.add(next)
    offset = next
  }
  return tasks
}

/** Move a task into a section of its project. */
export async function addTaskToSection(
  token: string,
  args: { taskGid: string; sectionGid: string },
): Promise<void> {
  const res = await fetch(`${ASANA_API_BASE}/sections/${args.sectionGid}/addTask`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ data: { task: args.taskGid } }),
  })

  if (!res.ok) {
    throw new AsanaApiError('add task to section', res.status, await safeErrorDetail(res))
  }
}

export type TaskAttachment = { gid: string; name: string }

/**
 * List ALL attachments on a task, following Asana's offset pagination.
 * Returns every attachment's gid + name (name is the idempotency signal).
 */
export async function listTaskAttachments(
  token: string,
  taskGid: string,
): Promise<TaskAttachment[]> {
  const out: TaskAttachment[] = []
  let offset: string | undefined
  // Bounded loop: Asana caps limit at 100; a flag never has many attachments,
  // but we still page defensively with a hard ceiling.
  for (let page = 0; page < 50; page++) {
    const url = new URL(`${ASANA_API_BASE}/attachments`)
    url.searchParams.set('parent', taskGid)
    url.searchParams.set('opt_fields', 'name')
    url.searchParams.set('limit', '100')
    if (offset) url.searchParams.set('offset', offset)

    const res = await fetch(url.toString(), { headers: authHeaders(token) })
    if (!res.ok) await throwAsana('list attachments', res)

    const json = (await res.json()) as {
      data?: { gid?: string; name?: string }[]
      next_page?: { offset?: string } | null
    }
    for (const a of json.data ?? []) {
      if (a.gid) out.push({ gid: a.gid, name: a.name ?? '' })
    }
    const next = json.next_page?.offset
    if (!next) break
    offset = next
  }
  return out
}

/**
 * Upload ONE file as a real multipart attachment on a task. `bytes` is held
 * by the caller for exactly this call (one buffer in memory at a time).
 * Returns the new attachment gid.
 */
export async function addAttachmentToTask(
  token: string,
  args: { taskGid: string; filename: string; contentType: string; bytes: Uint8Array },
): Promise<{ gid: string }> {
  const form = new FormData()
  form.append('parent', args.taskGid)
  // Copy the exact bytes into a fresh ArrayBuffer-backed buffer. The incoming
  // Uint8Array is typed over ArrayBufferLike (which may be a SharedArrayBuffer),
  // and TypeScript won't accept that as a BlobPart — a plain ArrayBuffer is.
  const buffer = new ArrayBuffer(args.bytes.byteLength)
  new Uint8Array(buffer).set(args.bytes)
  form.append('file', new Blob([buffer], { type: args.contentType }), args.filename)

  const res = await fetch(`${ASANA_API_BASE}/attachments`, {
    method: 'POST',
    headers: authHeadersMultipart(token), // no Content-Type → fetch sets the multipart boundary
    body: form,
  })
  if (!res.ok) await throwAsana('add attachment', res)

  const json = (await res.json()) as { data?: { gid?: string } }
  const gid = json?.data?.gid
  if (!gid) {
    throw new AsanaApiError('add attachment', res.status, 'missing attachment gid in response')
  }
  return { gid }
}
