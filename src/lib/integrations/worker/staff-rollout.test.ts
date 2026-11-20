import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assertAllowedProject, liveIncidentsEnabled, liveIncidentsRolloutEnabled } from '@/lib/integrations/asana/config'
import { ASANA_DESTINATIONS, chooseDestinationForNewFlag, destinationPin, LIVE_TEST_SCOPE } from '@/lib/integrations/asana/destinations'
import { liveTestRefusal, LIVE_TEST_CODES } from '@/lib/integrations/worker/live-test-gate'

const CO = LIVE_TEST_SCOPE.companyId
const PROP = '9d27d742-fa0e-4af4-8bbc-17d4752d7ef7'
const FLAG = '5bbe6c9a-755b-4e00-82df-484ffad48bce'
const LIVE = ASANA_DESTINATIONS.live_incidents
beforeEach(() => {
  vi.stubEnv('ASANA_LIVE_INCIDENTS_ENABLED', 'true')
  vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', '')
})
afterEach(() => vi.unstubAllEnvs())

function db(over: { company?: string; property?: unknown; error?: string; otherJob?: boolean } = {}) {
  const reads: string[] = []
  const filters: Record<string, unknown> = {}
  const client = {
    from(table: string) {
      reads.push(table)
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters[`${table}.${key}`] = value; return query },
        is: (key: string, value: unknown) => { filters[`${table}.${key}`] = value; return query },
        limit: () => query,
        maybeSingle: async () => query,
        then(resolve: (v: unknown) => unknown) {
          const data = table === 'flags' ? { company_id: over.company ?? CO, property_id: PROP }
            : table === 'properties' ? ('property' in over ? over.property : { id: PROP, company_id: CO })
              : table === 'integration_outbox' ? (over.otherJob ? [{ id: 'opposing' }] : []) : null
          return Promise.resolve(resolve({ data, error: over.error === table ? { code: 'XX000' } : null }))
        },
      }
      return query
    },
  } as unknown as SupabaseClient
  return { client, reads, filters }
}
const job = { companyId: CO, flagId: FLAG, payload: destinationPin('live_incidents') }

describe('staff rollout destination and database gate', () => {
  it.each([false, true])('new ordinary/pack-photo issue (%s) on a real property goes to intake', (isPackPhotoIssue) => {
    expect(chooseDestinationForNewFlag({ companyId: CO, propertyId: PROP, isPackPhotoIssue })).toBe('live_incidents')
    expect(() => assertAllowedProject(LIVE.projectGid)).not.toThrow()
  })
  it.each(['', 'false', 'TRUE', '1'])('only an exact true enables rollout (%s)', (value) => {
    vi.stubEnv('ASANA_LIVE_INCIDENTS_ENABLED', value)
    expect(liveIncidentsRolloutEnabled()).toBe(false)
    expect(liveIncidentsEnabled()).toBe(false)
    expect(chooseDestinationForNewFlag({ companyId: CO, propertyId: PROP, isPackPhotoIssue: true })).toBe('beta')
  })
  it('never opts another company into live', async () => {
    expect(chooseDestinationForNewFlag({ companyId: 'other', propertyId: PROP, isPackPhotoIssue: true })).toBe('beta')
    const h = db({ company: 'other' })
    expect(await liveTestRefusal(h.client, LIVE, { ...job, companyId: 'other' })).toEqual({ code: LIVE_TEST_CODES.outOfScope, permanent: true })
    expect(h.reads).toEqual(['flags'])
  })
  it('ordinary issue needs no photo selections; verifies active property ownership', async () => {
    const h = db()
    expect(await liveTestRefusal(h.client, LIVE, job)).toBeNull()
    expect(h.reads).toEqual(['flags', 'properties', 'integration_outbox'])
    expect(h.filters['properties.company_id']).toBe(CO)
    expect(h.filters['properties.deleted_at']).toBeNull()
  })
  it.each([null, { id: PROP, company_id: 'other' }, { id: 'other-property', company_id: CO }])('missing or mismatched property is refused', async (property) => {
    const h = db({ property })
    expect(await liveTestRefusal(h.client, LIVE, job)).toEqual({ code: LIVE_TEST_CODES.outOfScope, permanent: true })
    expect(h.reads).not.toContain('integration_outbox')
  })
  it.each(['flags', 'properties', 'integration_outbox'])('a failed %s read retries without approving a write', async (error) => {
    const h = db({ error })
    expect(await liveTestRefusal(h.client, LIVE, job)).toEqual({ code: LIVE_TEST_CODES.scopeReadFailed, permanent: false })
  })
  it('pin and opposing-destination checks still apply during rollout', async () => {
    const h = db({ otherJob: true })
    expect(await liveTestRefusal(h.client, LIVE, job)).toEqual({ code: LIVE_TEST_CODES.otherDestinationJob, permanent: true })
    const badPin = db()
    expect(await liveTestRefusal(badPin.client, LIVE, { ...job, payload: destinationPin('beta') })).toEqual({ code: LIVE_TEST_CODES.pinMismatch, permanent: true })
    expect(badPin.reads).toEqual([])
  })
})
