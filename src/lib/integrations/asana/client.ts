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
  constructor(operation: string, status: number, detail: string) {
    super(`Asana ${operation} failed (HTTP ${status}): ${detail}`)
    this.name = 'AsanaApiError'
    this.status = status
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
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
