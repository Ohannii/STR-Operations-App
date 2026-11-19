/**
 * Asana Phase 1 (BETA) configuration + the HARD PROJECT ALLOWLIST.
 *
 * This is the safety brain of the integration. Because Phase 1 uses a
 * personal access token that technically has access to every project
 * in the workspace, the ONLY thing preventing a write to a live
 * operational project (Incidents & Damages, Maintenance Control, etc.)
 * is code. `assertAllowedProject` is that lock: it throws unless the
 * target is exactly the private BETA test project.
 *
 * GIDs below were captured when the private "Drop-Inn STR —
 * Integration Test (BETA)" project was created. Slice 3 is offline —
 * nothing here calls Asana.
 */

/** Arcis workspace GID (read-only reference; not a write target). */
export const ASANA_WORKSPACE_GID = '1195313768891883'

/** The ONLY project Phase 1 may ever write to — the private BETA sandbox. */
export const ASANA_TEST_PROJECT_GID = '1216372108028101'

/**
 * Section GIDs inside the BETA test project, keyed by the app's
 * category-group id (see flagCategoryGroupId / FLAG_CATEGORY_GROUPS).
 * `owner_chargeable` routes to Unsorted/Other for the beta — the test
 * project has no owner-cost section yet, and we are not expanding
 * Asana structure mid-slice.
 */
export const ASANA_TEST_SECTION_GIDS: Record<string, string> = {
  damage: '1216372209433460', // Guest Damage & Incidents
  maintenance: '1216372035584080', // Maintenance
  inventory: '1216372171871349', // Inventory & Linen
  cleaning: '1216372209283198', // Cleaning
  safety: '1216372209385431', // Safety (Urgent)
  notes: '1216379954794985', // Notes & Follow-up
  owner_chargeable: '1216372171983792', // -> Unsorted / Other (beta)
}

/** Where unmapped / unknown category groups land. */
export const ASANA_FALLBACK_SECTION_GID = '1216372171983792' // Unsorted / Other

/**
 * CONTROLLED LIVE TEST (Nov 2026) — the ONE live project that may ever be
 * targeted, and only while the test switch below is on:
 * "Incidents & Damages Reporting", section "New (Intake".
 */
export const ASANA_LIVE_INCIDENTS_PROJECT_GID = '1211426202387126'
export const ASANA_LIVE_INCIDENTS_INTAKE_SECTION_GID = '1211426202387127'

/**
 * The switch for the controlled live test. OFF unless this environment
 * variable is EXACTLY 'true' — unset, empty, 'TRUE', '1' … all mean off.
 * It is meant to be set on the Vercel PREVIEW environment only, so a
 * deployment without it (production / the scheduled worker) keeps the
 * BETA-only boundary exactly as before.
 */
export const ASANA_LIVE_TEST_ENV = 'ASANA_LIVE_INCIDENTS_TEST'

export function liveIncidentsTestEnabled(): boolean {
  return process.env[ASANA_LIVE_TEST_ENV] === 'true'
}

/** Thrown when a project outside the allowlist is targeted. */
export class DisallowedAsanaProjectError extends Error {
  constructor(projectGid: string) {
    super(
      `Refusing to target Asana project "${projectGid}". Writes are ` +
        `hard-pinned to the BETA test project ${ASANA_TEST_PROJECT_GID}` +
        ` (plus the live Incidents project ONLY while the controlled live test is switched on).`,
    )
    this.name = 'DisallowedAsanaProjectError'
  }
}

/**
 * HARD ALLOWLIST. Throws unless `projectGid` is
 *   - exactly the pinned BETA test project, or
 *   - exactly the live Incidents & Damages project AND the controlled live
 *     test is switched on (liveIncidentsTestEnabled).
 * Every other project is refused, always. Call before any code path that
 * could write. (Which of the two a given job may use is decided by its
 * DESTINATION — see destinations.ts; this is the outer wall.)
 */
export function assertAllowedProject(projectGid: string): void {
  if (projectGid === ASANA_TEST_PROJECT_GID) return
  if (projectGid === ASANA_LIVE_INCIDENTS_PROJECT_GID && liveIncidentsTestEnabled()) return
  throw new DisallowedAsanaProjectError(projectGid)
}

/**
 * Map an app category-group id (from flagCategoryGroupId, which may be
 * null) to a section GID, falling back to Unsorted/Other.
 */
export function sectionGidForGroup(groupId: string | null): string {
  if (groupId && Object.prototype.hasOwnProperty.call(ASANA_TEST_SECTION_GIDS, groupId)) {
    return ASANA_TEST_SECTION_GIDS[groupId]
  }
  return ASANA_FALLBACK_SECTION_GID
}
