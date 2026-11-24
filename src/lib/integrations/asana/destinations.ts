/**
 * Destination is pinned by the outbox event type and never rewritten.
 * ASANA_LIVE_INCIDENTS_ENABLED opts this company's new ordinary and pack-photo
 * issues into live intake, with automatic processing by the scheduled worker.
 * The separate preview TEST switch remains limited to Test 1 pack-photo issues
 * and manual processing. Existing BETA jobs retain their destination.
 * Every live worker run re-checks the flag/company/property in the database.
 */

import {
  ASANA_LIVE_INCIDENTS_INTAKE_SECTION_GID,
  ASANA_LIVE_INCIDENTS_PROJECT_GID,
  ASANA_TEST_PROJECT_GID,
  liveIncidentsRolloutEnabled,
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
 * Destination for a NEW issue, decided once at enqueue. Staff rollout covers
 * the pinned company; the preview test remains limited to Test 1 pack issues.
 *
 * TEST ISSUES NEVER GO LIVE. `isTest` is the database's own classification
 * of the flag (flags.is_test, stamped by trigger from a test apartment or the
 * reporter's active test session — migration 20261123120000). A test issue
 * always goes to the BETA project. The database additionally refuses a live
 * job for a test flag, so a wrong value here cannot leak test work.
 */
export function chooseDestinationForNewFlag(input: {
  companyId: string
  propertyId: string
  isPackPhotoIssue: boolean
  isTest: boolean
}): AsanaDestinationKey {
  if (input.isTest) return 'beta'
  if (liveIncidentsRolloutEnabled() && input.companyId === LIVE_TEST_SCOPE.companyId) {
    return 'live_incidents'
  }
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
