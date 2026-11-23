/**
 * Asana handoff health — the manager-visible early warning (pure).
 *
 * Input is the result of the database function asana_handoff_health()
 * (migration 20261123120000): counts of REAL issues (never test issues)
 * that were expected in Asana but are not there, up to 10 examples
 * (apartment + time + problem only), and the reconciliation worker's
 * heartbeat. Output is what a manager should see and do.
 *
 * Thresholds (database side): "missing" only after 10 minutes without any
 * job (5 worker runs — ordinary 2-minute latency is never an incident);
 * "stuck" after 30 minutes waiting. Worker heartbeat stale after 15 minutes.
 */

export const HEARTBEAT_STALE_MINUTES = 15

export type HandoffProblem = 'missing' | 'stopped' | 'stuck'
export type HandoffHealthRaw = {
  asana_enabled: boolean
  missing: number
  missing_beyond_retry: number
  stopped: number
  stuck: number
  oldest_problem_at: string | null
  items: Array<{ flag_id: string; property_id: string; property_name: string; raised_at: string; problem: HandoffProblem }>
  last_check_at: string | null
  last_check_ok_at: string | null
  last_check_ok: boolean | null
}

export type WorkerState = 'ok' | 'never_ran' | 'stale' | 'failing'
export type HandoffItem = { href: string; apartment: string; raisedAt: string; label: string }
export type HandoffHealth = {
  level: 'ok' | 'attention' | 'off'
  worker: WorkerState
  problems: number
  headline: string
  details: string[]
  actions: string[]
  items: HandoffItem[]
  lastCheckAt: string | null
  lastCheckOkAt: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
const iso = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null)
const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`

/** Validate the database answer. Anything unexpected -> null (shown as "could not check"). */
export function parseHandoffHealth(v: unknown): HandoffHealthRaw | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (typeof r.asana_enabled !== 'boolean') return null
  const items = Array.isArray(r.items) ? r.items : []
  return {
    asana_enabled: r.asana_enabled,
    missing: n(r.missing), missing_beyond_retry: n(r.missing_beyond_retry), stopped: n(r.stopped), stuck: n(r.stuck),
    oldest_problem_at: iso(r.oldest_problem_at),
    items: items.flatMap((i) => {
      const x = i as Record<string, unknown>
      return typeof x.flag_id === 'string' && UUID.test(x.flag_id) && typeof x.property_id === 'string' && UUID.test(x.property_id)
        && iso(x.raised_at) && (x.problem === 'missing' || x.problem === 'stopped' || x.problem === 'stuck')
        ? [{ flag_id: x.flag_id, property_id: x.property_id, property_name: typeof x.property_name === 'string' ? x.property_name : 'Apartment', raised_at: x.raised_at as string, problem: x.problem as HandoffProblem }]
        : []
    }).slice(0, 10),
    last_check_at: iso(r.last_check_at),
    last_check_ok_at: iso(r.last_check_ok_at),
    last_check_ok: typeof r.last_check_ok === 'boolean' ? r.last_check_ok : null,
  }
}

const RETRY_DAYS = 14
function itemLabel(problem: HandoffProblem, raisedAt: string, now: number): string {
  if (problem === 'stopped') return 'Sending stopped'
  if (problem === 'stuck') return 'Waiting more than 30 minutes'
  return now - Date.parse(raisedAt) > RETRY_DAYS * 86_400_000 ? 'Not sent, no longer retried automatically' : 'Not sent yet'
}

export function assessHandoffHealth(raw: HandoffHealthRaw, now = Date.now()): HandoffHealth {
  const worker: WorkerState = !raw.last_check_at ? 'never_ran'
    : raw.last_check_ok === false ? 'failing'
      : now - Date.parse(raw.last_check_at) > HEARTBEAT_STALE_MINUTES * 60_000 ? 'stale' : 'ok'
  const problems = raw.missing + raw.stopped + raw.stuck
  const base = {
    worker, problems, lastCheckAt: raw.last_check_at, lastCheckOkAt: raw.last_check_ok_at,
    items: raw.items.map((i) => ({
      href: `/properties/${i.property_id}/flags/${i.flag_id}`, apartment: i.property_name, raisedAt: i.raised_at,
      label: itemLabel(i.problem, i.raised_at, now),
    })),
  }
  if (!raw.asana_enabled) {
    return { ...base, level: 'off', headline: 'Asana is switched off for this company.', details: [], actions: [] }
  }
  const workerDown = worker === 'stale' || worker === 'failing'
  if (problems === 0 && !workerDown) {
    return { ...base, level: 'ok', headline: worker === 'never_ran' ? 'No issues waiting for Asana. The automatic check has not reported yet.' : 'All issues reached Asana.', details: [], actions: [] }
  }
  const details: string[] = []
  const actions: string[] = []
  if (raw.missing) details.push(`${plural(raw.missing, 'issue was', 'issues were')} not sent${raw.missing_beyond_retry ? ` (${raw.missing_beyond_retry} older than 14 days, no longer retried automatically)` : ''}.`)
  if (raw.stopped) details.push(`${plural(raw.stopped, 'issue', 'issues')}: Asana could not create the task.`)
  if (raw.stuck) details.push(`${plural(raw.stuck, 'issue has', 'issues have')} been waiting more than 30 minutes.`)
  if (worker === 'failing') details.push('The automatic Asana check ran but failed.')
  if (worker === 'stale') details.push(`The automatic Asana check has not run for more than ${HEARTBEAT_STALE_MINUTES} minutes.`)
  if (workerDown) actions.push('New issues are still saved in the app, but they will not reach Asana until the automatic check runs again. Ask your developer to check the Vercel cron job for /api/integrations/asana/worker.')
  if ((raw.missing || raw.stuck) && !workerDown) actions.push('The app keeps retrying every few minutes. If an issue is still listed in 30 minutes, ask your developer to check the Asana connection.')
  if (raw.stopped || raw.missing_beyond_retry) actions.push('For issues that are no longer retried, open the issue and create the Asana task by hand, or ask your developer to send it again. Nothing is lost: the issue and its photos stay in the app.')
  const headline = problems > 0
    ? `${plural(problems, 'issue has', 'issues have')} not reached Asana`
    : 'Automatic sending to Asana is not running'
  return { ...base, level: 'attention', headline, details, actions }
}
