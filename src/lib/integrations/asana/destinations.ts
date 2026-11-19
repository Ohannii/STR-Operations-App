/**
 * Asana DESTINATIONS — where a flag's task is created (pure; no I/O).
 *
 *   beta            the private BETA test project. Section by category
 *                   group. This is every flag's destination unless the
 *                   controlled live test below applies. UNCHANGED.
 *
 *   live_incidents  CONTROLLED LIVE TEST (Nov 2026): the live "Incidents &
 *                   Damages Reporting" project, ALWAYS section "New (Intake"
 *                   whatever the category — the project's own Asana rules do
 *                   the downstream routing.
 *
 * HOW A JOB'S DESTINATION IS PINNED
 * The destination is the outbox row's EVENT TYPE. It is chosen once, when
 * the job is enqueued (before any create attempt), it is part of the row's
 * identity, and no code path ever rewrites it — so retries, reconciliation
 * and attachments of that job can only ever use the same destination. The
 * payload also records it (`destination`, `destination_project_gid`) and the
 * worker refuses a row whose record disagrees with its event type.
 *
 * WHY SEPARATE EVENT TYPES
 * The scheduled worker (and any older deployment) only ever reads the BETA
 * event types below. A live-destination job has a different event type, so
 * an older worker can never claim it and send it to BETA.
 *
 * A live job is only ever enqueued, and only ever processed, when ALL hold:
 *   - the live test switch is on (ASANA_LIVE_INCIDENTS_TEST === 'true');
 *   - the flag belongs to the test company AND the test property;
 *   - the flag is a pack-photo issue (it has saved issue selections).
 * The worker re-checks every one of these from the database on every run;
 * nothing in the outbox payload is trusted for them.
 */

import {
  ASANA_LIVE_INCIDENTS_INTAKE_SECTION_GID,
  ASANA_LIVE_INCIDENTS_PROJECT_GID,
  ASANA_TEST_PROJECT_GID,
  liveIncidentsTestEnabled,
} from '@/lib/integrations/asana/config'
import type { OutboxEventType } from '@/lib/integrations/types'

export type AsanaDestinationKey = 'beta' | 'live_incidents'

export type AsanaDestination = {
  key: AsanaDestinationKey
  projectGid: string
  /** When set, EVERY task of this destination starts in this section. */
  fixedSectionGid: string | null
  createEvent: OutboxEventType
  attachEvent: OutboxEventType
}

export const ASANA_DESTINATIONS: Readonly<Record<AsanaDestinationKey, AsanaDestination>> = Object.freeze({
  beta: Object.freeze({
    key: 'beta',
    projectGid: ASANA_TEST_PROJECT_GID,
    fixedSectionGid: null,
    createEvent: 'asana.create_task_for_flag',
    attachEvent: 'asana.attach_flag_evidence',
  }),
  live_incidents: Object.freeze({
    key: 'live_incidents',
    projectGid: ASANA_LIVE_INCIDENTS_PROJECT_GID,
    fixedSectionGid: ASANA_LIVE_INCIDENTS_INTAKE_SECTION_GID,
    createEvent: 'asana.live.create_task_for_flag',
    attachEvent: 'asana.live.attach_flag_evidence',
  }),
})

export const ALL_CREATE_EVENTS: readonly OutboxEventType[] = [
  ASANA_DESTINATIONS.beta.createEvent,
  ASANA_DESTINATIONS.live_incidents.createEvent,
]

export function isCreateEvent(eventType: unknown): eventType is OutboxEventType {
  return typeof eventType === 'string' && (ALL_CREATE_EVENTS as readonly string[]).includes(eventType)
}

export function otherDestination(key: AsanaDestinationKey): AsanaDestination {
  return ASANA_DESTINATIONS[key === 'beta' ? 'live_incidents' : 'beta']
}

/**
 * The scope of the controlled live test: ONE company and ONE property
 * ("Test 1"). Every other company / property keeps its current routing.
 */
export const LIVE_TEST_SCOPE = Object.freeze({
  companyId: '1669c464-8d26-40fc-9956-9f8955fd27c7',
  propertyId: '3ed2a749-0954-4216-8095-2a1bf2af7aaa',
})

export function isInLiveTestScope(input: { companyId: unknown; propertyId: unknown }): boolean {
  return input.companyId === LIVE_TEST_SCOPE.companyId && input.propertyId === LIVE_TEST_SCOPE.propertyId
}

/**
 * Destination for a NEW issue, decided once at enqueue. Live ONLY for a
 * pack-photo issue of the test company + property while the switch is on;
 * BETA for everything else (ordinary flags, other properties, switch off).
 */
export function chooseDestinationForNewFlag(input: {
  companyId: string
  propertyId: string
  isPackPhotoIssue: boolean
}): AsanaDestinationKey {
  return input.isPackPhotoIssue && liveIncidentsTestEnabled() && isInLiveTestScope(input)
    ? 'live_incidents'
    : 'beta'
}

/** The destination record written into a job's payload at enqueue. */
export function destinationPin(key: AsanaDestinationKey): { destination: AsanaDestinationKey; destination_project_gid: string } {
  return { destination: key, destination_project_gid: ASANA_DESTINATIONS[key].projectGid }
}

/**
 * Does a job's payload agree with the destination its event type pins?
 * BETA rows enqueued before destinations existed carry no record: allowed.
 * A live row MUST carry the exact live record.
 */
export function payloadPinMatches(key: AsanaDestinationKey, payload: Record<string, unknown>): boolean {
  const d = payload.destination
  const p = payload.destination_project_gid
  if (key === 'beta' && d === undefined && p === undefined) return true
  return d === key && p === ASANA_DESTINATIONS[key].projectGid
}
