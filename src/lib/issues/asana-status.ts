/**
 * Honest Asana status for an issue reported from a pack photo.
 * Derived only from facts: the flag's saved task link and its create job.
 *
 *   in_asana         the flag has a saved Asana task link;
 *   queued           a live create job is pending / being processed;
 *   needs_attention  the create job stopped without a saved link (dead,
 *                    manual review, "done" with no link, or any state this
 *                    code does not recognise);
 *   not_sent         CONFIRMED: no link and no create job exists;
 *   unknown          the status could not be read — never shown as
 *                    "not sent" or "sending".
 */
export type AsanaIssueStatus = 'in_asana' | 'queued' | 'needs_attention' | 'not_sent' | 'unknown'

/** A create job row as read from integration_outbox. */
export type CreateJobRow = {
  entity_id?: unknown
  status?: unknown
  created_at?: unknown
  deleted_at?: unknown
  provider?: unknown
  event_type?: unknown
  entity_type?: unknown
  id?: unknown
}

/** The job fact: a status, `null` = confirmed none, 'unknown' = lookup failed. */
export type CreateJobFact = { status: string } | null | 'unknown'

/** Create-task jobs of every destination (BETA and the controlled live test). */
const CREATE_EVENTS: readonly string[] = ['asana.create_task_for_flag', 'asana.live.create_task_for_flag']

/**
 * Pick THE create job for one flag from raw outbox rows, deterministically:
 * only live (not soft-deleted) Asana create-task rows for that flag count;
 * if history left several, the most recently created wins (ties: highest id).
 * Rows missing a column that was not selected are not excluded for it.
 */
export function pickCreateJob(rows: readonly CreateJobRow[], flagId: string): { status: string } | null {
  const live = rows.filter(
    (r) =>
      r.entity_id === flagId &&
      (r.deleted_at === null || r.deleted_at === undefined) &&
      (r.provider === undefined || r.provider === 'asana') &&
      (r.event_type === undefined || (typeof r.event_type === 'string' && CREATE_EVENTS.includes(r.event_type))) &&
      (r.entity_type === undefined || r.entity_type === 'flag') &&
      typeof r.status === 'string',
  )
  if (live.length === 0) return null
  const key = (r: CreateJobRow) => [String(r.created_at ?? ''), String(r.id ?? '')] as const
  const newest = live.reduce((a, b) => {
    const [ac, ai] = key(a)
    const [bc, bi] = key(b)
    return bc > ac || (bc === ac && bi > ai) ? b : a
  })
  return { status: newest.status as string }
}

export function asanaIssueStatus(input: {
  asanaTaskUrl: string | null | undefined
  createJob: CreateJobFact
}): AsanaIssueStatus {
  if (input.asanaTaskUrl) return 'in_asana'
  if (input.createJob === 'unknown') return 'unknown'
  if (input.createJob === null) return 'not_sent'
  switch (input.createJob.status) {
    case 'pending':
    case 'processing':
      return 'queued'
    default:
      // dead, manual_review, "done" without a saved link, or unrecognised:
      // nothing is on its way and nothing is proven in Asana.
      return 'needs_attention'
  }
}

export const ASANA_STATUS_LABEL: Record<AsanaIssueStatus, string> = {
  in_asana: 'In Asana',
  queued: 'Sending to Asana',
  needs_attention: 'Asana sync needs attention',
  not_sent: 'Not sent to Asana',
  unknown: 'Asana status unavailable',
}
