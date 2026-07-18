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
  name: string
  notes: string
  /** YYYY-MM-DD. Only sent when present. */
  dueOn?: string
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

/** Create a task in the given project. Returns its gid + permalink. */
export async function createTaskInProject(
  token: string,
  args: CreateTaskArgs,
): Promise<CreatedTask> {
  const res = await fetch(`${ASANA_API_BASE}/tasks?opt_fields=permalink_url`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      data: {
        name: args.name,
        notes: args.notes,
        projects: [args.projectGid],
        ...(args.dueOn ? { due_on: args.dueOn } : {}),
      },
    }),
  })

  if (!res.ok) {
    throw new AsanaApiError('create task', res.status, await safeErrorDetail(res))
  }

  const json = (await res.json()) as {
    data?: { gid?: string; permalink_url?: string }
  }
  const gid = json?.data?.gid
  if (!gid) {
    throw new AsanaApiError('create task', res.status, 'missing task gid in response')
  }
  const permalinkUrl =
    typeof json.data?.permalink_url === 'string' && json.data.permalink_url
      ? json.data.permalink_url
      : `https://app.asana.com/0/0/${gid}`

  return { gid, permalinkUrl }
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
