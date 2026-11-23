/**
 * Test-activity isolation (migration 20261123120000) — shared, pure helpers.
 *
 * A flag is a TEST issue when the database stamped it so at creation:
 *   - it was raised on a test apartment (properties.is_test), or
 *   - its reporter is a manager with active test mode ON THAT APARTMENT
 *     (time-limited; their issues on other apartments stay live).
 * Test issues are routed to the BETA Asana project, never to live Incidents.
 * Nothing here decides classification; the database does.
 */

/** Who may manage test apartments and test sessions (server-enforced in SQL too). */
export function canManageTesting(role: string | null | undefined): boolean {
  return ['company_admin', 'gm', 'ops_manager'].includes(role ?? '')
}

/** The signed-in manager's running test mode: ONE apartment, until endsAt. */
export type ActiveTestSession = { endsAt: string; reason: string; propertyId: string; propertyName: string }

/** Session durations offered in the UI (minutes). SQL allows 5–240. */
export const TEST_SESSION_MINUTES = [30, 60, 120, 240] as const

export function validTestReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 3 && value.trim().length <= 200
}

/** "14:30" in South Africa time, for the banner. */
export function testSessionEndLabel(endsAt: string): string {
  const d = new Date(endsAt)
  if (Number.isNaN(d.getTime())) return 'later today'
  const s = new Date(d.getTime() + 2 * 60 * 60 * 1000)
  return `${String(s.getUTCHours()).padStart(2, '0')}:${String(s.getUTCMinutes()).padStart(2, '0')}`
}

/** Pick the caller's active session from rows read through RLS (never trusts one blindly). */
export type TestSessionRow = {
  ends_at: unknown; ended_at: unknown; started_at: unknown; reason: unknown
  property_id?: unknown; property?: unknown
}

function propertyNameOf(p: unknown): string {
  const row = Array.isArray(p) ? p[0] : p
  const name = row && typeof row === 'object' ? (row as { name?: unknown }).name : null
  return typeof name === 'string' && name.trim() ? name.trim() : 'the selected apartment'
}

export function activeSessionFrom(rows: TestSessionRow[] | null | undefined, now = Date.now()): ActiveTestSession | null {
  for (const r of rows ?? []) {
    if (r.ended_at !== null || typeof r.ends_at !== 'string' || typeof r.started_at !== 'string') continue
    if (typeof r.property_id !== 'string') continue
    const ends = Date.parse(r.ends_at), started = Date.parse(r.started_at)
    if (Number.isFinite(ends) && Number.isFinite(started) && started <= now && ends > now) {
      return {
        endsAt: r.ends_at,
        reason: typeof r.reason === 'string' ? r.reason : '',
        propertyId: r.property_id,
        propertyName: propertyNameOf(r.property),
      }
    }
  }
  return null
}

export function testingError(error: { code?: string } | null): string {
  if (['PGRST202', '42P01', '42703', '42883'].includes(error?.code ?? '')) {
    return 'Testing tools are not switched on yet (database update pending).'
  }
  if (error?.code === '42501') return 'Only operations managers can change testing settings.'
  if (error?.code === '22023') return 'Choose an apartment and add a short reason (3–200 characters), then try again.'
  if (error?.code === '55000') return 'Test mode is already on for another apartment. End it first, then start again.'
  return 'Could not save. Check your connection and try again.'
}
