import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASANA_LIVE_INCIDENTS_INTAKE_SECTION_GID,
  ASANA_LIVE_INCIDENTS_PROJECT_GID,
  ASANA_TEST_PROJECT_GID,
  DisallowedAsanaProjectError,
  assertAllowedProject,
  liveIncidentsTestEnabled,
} from '@/lib/integrations/asana/config'
import {
  ALL_CREATE_EVENTS,
  ASANA_DESTINATIONS,
  LIVE_TEST_SCOPE,
  chooseDestinationForNewFlag,
  isInLiveTestScope,
  payloadPinMatches,
} from '@/lib/integrations/asana/destinations'
import {
  LIVE_INCIDENTS_FIELD_REFERENCE,
  LIVE_INCIDENTS_INTAKE_SECTION_GID,
  LIVE_INCIDENTS_PROJECT_GID,
  BETA_FIELD_CONFIG,
  configForWrite,
  writableFieldConfig,
} from '@/lib/integrations/asana/field-config'
import { createAsanaProvider } from '@/lib/integrations/asana/provider'
import { buildAttachEvidenceEvent, buildFlagOutboxEvent } from '@/lib/integrations/outbox'
import { pickCreateJob } from '@/lib/issues/asana-status'
import type { TaskPayload } from '@/lib/integrations/types'

/**
 * CONTROLLED LIVE TEST (Nov 2026): destinations, the switch, the hard
 * allowlist and the destination-bound provider. Nothing here calls Asana.
 */

const LIVE = '1211426202387126'
const INTAKE = '1211426202387127'
const CO = '1669c464-8d26-40fc-9956-9f8955fd27c7'
const PROP = '3ed2a749-0954-4216-8095-2a1bf2af7aaa'
const FLAG = '96487471-8c6e-48bc-828e-26255ad5277d'
const L = LIVE_INCIDENTS_FIELD_REFERENCE.fields
const on = () => vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', 'true')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the live destination is exactly the verified project + intake section', () => {
  it('GIDs', () => {
    expect(ASANA_LIVE_INCIDENTS_PROJECT_GID).toBe(LIVE)
    expect(ASANA_LIVE_INCIDENTS_INTAKE_SECTION_GID).toBe(INTAKE)
    // one source of truth with the verified field reference
    expect(LIVE_INCIDENTS_PROJECT_GID).toBe(LIVE)
    expect(LIVE_INCIDENTS_INTAKE_SECTION_GID).toBe(INTAKE)
    expect(LIVE_INCIDENTS_FIELD_REFERENCE.projectGid).toBe(LIVE)
    expect(ASANA_DESTINATIONS.live_incidents).toMatchObject({ projectGid: LIVE, fixedSectionGid: INTAKE })
    expect(ASANA_DESTINATIONS.beta).toMatchObject({ projectGid: ASANA_TEST_PROJECT_GID, fixedSectionGid: null })
  })

  it('the two destinations use DIFFERENT event types (so their queues can never mix)', () => {
    expect(ASANA_DESTINATIONS.beta.createEvent).toBe('asana.create_task_for_flag')
    expect(ASANA_DESTINATIONS.beta.attachEvent).toBe('asana.attach_flag_evidence')
    const events = [
      ASANA_DESTINATIONS.beta.createEvent,
      ASANA_DESTINATIONS.beta.attachEvent,
      ASANA_DESTINATIONS.live_incidents.createEvent,
      ASANA_DESTINATIONS.live_incidents.attachEvent,
    ]
    expect(new Set(events).size).toBe(4)
    expect([...ALL_CREATE_EVENTS]).toEqual(['asana.create_task_for_flag', 'asana.live.create_task_for_flag'])
  })

  it('the status reader recognises a live create job exactly like a BETA one', () => {
    const row = (event_type: string) => ({ id: 'a', entity_id: FLAG, status: 'pending', created_at: 't', deleted_at: null, provider: 'asana', event_type, entity_type: 'flag' })
    for (const e of ALL_CREATE_EVENTS) expect(pickCreateJob([row(e)], FLAG)).toEqual({ status: 'pending' })
    expect(pickCreateJob([row('asana.live.attach_flag_evidence')], FLAG)).toBeNull()
  })
})

describe('the switch: ON only for exactly "true"', () => {
  it.each([[undefined, false], ['', false], ['false', false], ['TRUE', false], ['1', false], [' true', false], ['true', true]])(
    '%j -> %s',
    (value, expected) => {
      if (value !== undefined) vi.stubEnv('ASANA_LIVE_INCIDENTS_TEST', value)
      expect(liveIncidentsTestEnabled()).toBe(expected)
    },
  )
})

describe('hard allowlist', () => {
  it('BETA is always allowed; live ONLY with the switch on; anything else NEVER', () => {
    expect(() => assertAllowedProject(ASANA_TEST_PROJECT_GID)).not.toThrow()
    expect(() => assertAllowedProject(LIVE)).toThrow(DisallowedAsanaProjectError)
    on()
    expect(() => assertAllowedProject(LIVE)).not.toThrow()
    expect(() => assertAllowedProject(ASANA_TEST_PROJECT_GID)).not.toThrow()
    for (const other of ['', '1', '1211426202387127', '1195313768891883', LIVE + '0', ' ' + LIVE]) {
      expect(() => assertAllowedProject(other), other).toThrow(DisallowedAsanaProjectError)
    }
  })

  it('writable field configuration for live: refused with the switch off, minted with it on; unknown projects always refused', () => {
    expect(() => configForWrite(LIVE)).toThrow(DisallowedAsanaProjectError)
    expect(() => writableFieldConfig(LIVE_INCIDENTS_FIELD_REFERENCE)).toThrow(DisallowedAsanaProjectError)
    on()
    expect(configForWrite(LIVE).projectGid).toBe(LIVE)
    expect(() => configForWrite('1211426202387127')).toThrow(DisallowedAsanaProjectError)
  })
})

describe('which destination a NEW flag gets (decided once, at enqueue)', () => {
  const pick = (o: Partial<Parameters<typeof chooseDestinationForNewFlag>[0]> = {}) =>
    chooseDestinationForNewFlag({ companyId: CO, propertyId: PROP, isPackPhotoIssue: true, ...o })

  it('scope constants', () => {
    expect(LIVE_TEST_SCOPE).toEqual({ companyId: CO, propertyId: PROP })
    expect(isInLiveTestScope({ companyId: CO, propertyId: PROP })).toBe(true)
    expect(isInLiveTestScope({ companyId: CO, propertyId: null })).toBe(false)
  })

  it('switch OFF -> always BETA', () => {
    expect(pick()).toBe('beta')
  })

  it('switch ON -> live ONLY for a pack-photo issue of the test company + Test 1 property', () => {
    on()
    expect(pick()).toBe('live_incidents')
    expect(pick({ isPackPhotoIssue: false })).toBe('beta') // ordinary flag on the same property
    expect(pick({ propertyId: 'a0000000-0000-4000-8000-000000000001' })).toBe('beta') // other property
    expect(pick({ companyId: 'b0000000-0000-4000-8000-000000000001' })).toBe('beta') // other company
    expect(pick({ propertyId: PROP.toUpperCase() })).toBe('beta') // exact match only
  })
})

describe('the destination record written at enqueue', () => {
  const input = { companyId: CO, flagId: FLAG, createdBy: 'u1', payload: { property_id: PROP } }

  it('BETA rows are byte-for-byte what they were (no new keys)', () => {
    expect(buildFlagOutboxEvent(input)).toEqual({
      company_id: CO, provider: 'asana', event_type: 'asana.create_task_for_flag', entity_type: 'flag', entity_id: FLAG,
      payload: { property_id: PROP, flag_id: FLAG, create_protocol: buildFlagOutboxEvent(input).payload.create_protocol },
      created_by: 'u1',
    })
    expect(Object.keys(buildFlagOutboxEvent(input).payload).sort()).toEqual(['create_protocol', 'flag_id', 'property_id'])
    expect(buildAttachEvidenceEvent(input)).toMatchObject({ event_type: 'asana.attach_flag_evidence' })
    expect(buildAttachEvidenceEvent(input).payload).not.toHaveProperty('destination')
  })

  it('live rows: live event types + the pin; a caller hint can never forge it', () => {
    const forged = { ...input, payload: { destination: 'beta', destination_project_gid: 'x', flag_id: 'y' } }
    for (const row of [buildFlagOutboxEvent(forged, 'live_incidents'), buildAttachEvidenceEvent(forged, 'live_incidents')]) {
      expect(row.payload).toMatchObject({ flag_id: FLAG, destination: 'live_incidents', destination_project_gid: LIVE })
      expect(row.event_type.startsWith('asana.live.')).toBe(true)
    }
  })

  it('payloadPinMatches', () => {
    expect(payloadPinMatches('beta', {})).toBe(true) // legacy BETA rows carry no record
    expect(payloadPinMatches('beta', { destination: 'beta', destination_project_gid: ASANA_TEST_PROJECT_GID })).toBe(true)
    expect(payloadPinMatches('beta', { destination: 'live_incidents', destination_project_gid: LIVE })).toBe(false)
    expect(payloadPinMatches('live_incidents', { destination: 'live_incidents', destination_project_gid: LIVE })).toBe(true)
    expect(payloadPinMatches('live_incidents', {})).toBe(false)
    expect(payloadPinMatches('live_incidents', { destination: 'live_incidents' })).toBe(false)
    expect(payloadPinMatches('live_incidents', { destination: 'live_incidents', destination_project_gid: ASANA_TEST_PROJECT_GID })).toBe(false)
  })
})

// ---------------------------------------------------------------- provider

function mockResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}
const livePayload = (over: Partial<TaskPayload> = {}): TaskPayload => ({
  workspaceGid: 'W', projectGid: LIVE, sectionGid: INTAKE, name: 'TEST — Test 1 [Inventory]', notes: 'body', ...over,
})
const liveFields = {
  [L.category!.gid]: L.category!.options!.inventory,
  [L.replacementRequired!.gid]: [L.replacementRequired!.options!.fix],
  [L.severity!.gid]: L.severity!.options!.minor,
  [L.fixOwner!.gid]: L.fixOwner!.options!.maintenance,
  [L.evidenceReceived!.gid]: L.evidenceReceived!.options!.yes,
}

describe('destination-bound provider (every refusal happens BEFORE any network call)', () => {
  it('live provider, switch on: ONE POST with projects + memberships (intake) + custom fields', async () => {
    on()
    const fetchMock = vi.fn(async () => mockResponse({ data: { gid: 'T1', permalink_url: 'https://app.asana.com/0/1/T1' } }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await createAsanaProvider('tok', 'live_incidents').createTask(livePayload({ customFields: liveFields }))
    expect(res.externalTaskGid).toBe('T1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }]
    expect(opts.method).toBe('POST')
    expect(String(url)).not.toContain('/sections/')
    const data = JSON.parse(opts.body).data
    expect(data.projects).toEqual([LIVE])
    expect(data.memberships).toEqual([{ project: LIVE, section: INTAKE }])
    expect(data.custom_fields).toEqual(liveFields)
  })

  it('live provider with the switch OFF refuses everything', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const p = createAsanaProvider('tok', 'live_incidents')
    await expect(p.createTask(livePayload())).rejects.toBeInstanceOf(DisallowedAsanaProjectError)
    await expect(p.getTask(LIVE, 'T1')).rejects.toBeInstanceOf(DisallowedAsanaProjectError)
    await expect(p.listTasksModifiedSince(LIVE, '2026-01-01T00:00:00Z')).rejects.toBeInstanceOf(DisallowedAsanaProjectError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['the BETA project', livePayload({ projectGid: ASANA_TEST_PROJECT_GID }), 'DisallowedAsanaProjectError'],
    ['an unrelated project', livePayload({ projectGid: '1210000000000000' }), 'DisallowedAsanaProjectError'],
    ['any section other than intake', livePayload({ sectionGid: '1211426202387130' }), 'DisallowedAsanaSectionError'],
    ['a BETA section', livePayload({ sectionGid: '1216372035584080' }), 'DisallowedAsanaSectionError'],
    ['an unknown field', livePayload({ customFields: { '999': 'x' } }), 'DisallowedAsanaFieldError'],
    ['a BETA field GID', livePayload({ customFields: { [BETA_FIELD_CONFIG.fields.category!.gid]: BETA_FIELD_CONFIG.fields.category!.options!.inventory } }), 'DisallowedAsanaFieldError'],
    ['a BETA option on a live field', livePayload({ customFields: { [L.category!.gid]: BETA_FIELD_CONFIG.fields.category!.options!.inventory } }), 'DisallowedAsanaFieldError'],
    ['a disabled live option (Replacement Required "Yes")', livePayload({ customFields: { [L.replacementRequired!.gid]: ['1214079196883376'] } }), 'DisallowedAsanaFieldError'],
    ['a field on the project that is not configured (Severity Status)', livePayload({ customFields: { '1211899401497849': ['1211899401497850'] } }), 'DisallowedAsanaFieldError'],
  ])('live provider (switch on) refuses %s — no fetch', async (_l, payload, errorName) => {
    on()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createAsanaProvider('tok', 'live_incidents').createTask(payload)).rejects.toMatchObject({ name: errorName })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the DEFAULT (BETA) provider can never reach the live project, even with the switch on', async () => {
    on()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const p = createAsanaProvider('tok')
    await expect(p.createTask(livePayload())).rejects.toBeInstanceOf(DisallowedAsanaProjectError)
    await expect(p.getTask(LIVE, 'T1')).rejects.toBeInstanceOf(DisallowedAsanaProjectError)
    await expect(p.listTasksModifiedSince(LIVE, '2026-01-01T00:00:00Z')).rejects.toBeInstanceOf(DisallowedAsanaProjectError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the live provider can never read or list the BETA project', async () => {
    on()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const p = createAsanaProvider('tok', 'live_incidents')
    await expect(p.getTask(ASANA_TEST_PROJECT_GID, 'T1')).rejects.toBeInstanceOf(DisallowedAsanaProjectError)
    await expect(p.listTasksModifiedSince(ASANA_TEST_PROJECT_GID, '2026-01-01T00:00:00Z')).rejects.toBeInstanceOf(DisallowedAsanaProjectError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- source contracts

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('source contracts', () => {
  it('manual live trigger remains secret-protected, switched, and limited to ONE named flag', () => {
    const route = code(read('src/app/api/integrations/asana/worker/route.ts'))
    const post = route.slice(route.indexOf('export async function POST'))
    const order = [
      "isValidTriggerSecret(hdrs.get('x-worker-secret')",
      "if (target === 'live_incidents')",
      'if (!liveIncidentsEnabled())',
      'if (!UUID_RE.test(flagId))',
      'onlyFlagId: flagId',
      "createAsanaProvider(asanaToken, 'live_incidents')",
    ].map((needle) => post.indexOf(needle))
    expect(order.every((i) => i > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // the only other provider in the file is the default (BETA) one
    expect(route.match(/createAsanaProvider\(/g)).toHaveLength(4)
    expect(route.match(/createAsanaProvider\(asanaToken\)/g)).toHaveLength(2)
  })

  it('attachments: a job resolves its task ONLY from a link recorded for its own destination project', () => {
    const attach = code(read('src/lib/integrations/worker/attach-evidence.ts'))
    expect(attach).toContain(".eq('external_project_gid', projectGid)")
    expect(attach).toContain('createAttachIO(supabase, token, dest.projectGid)')
    expect(attach).toContain('readAndGuardOutbox(supabase, deps, dest.attachEvent)')
  })

  it('no code path rewrites a job\'s event type (the destination pin)', () => {
    for (const f of [
      'src/lib/integrations/worker/process-outbox.ts',
      'src/lib/integrations/worker/attach-evidence.ts',
      'src/lib/integrations/outbox.ts',
    ]) {
      const src = code(read(f))
      const updates = src.match(/\.update\(\{[\s\S]*?\}\)/g) ?? []
      for (const u of updates) expect(u, f).not.toContain('event_type')
      expect(src).not.toMatch(/event_type:\s*[^,\n]*\n?[^)]*\}\)\s*\.eq\('id'/)
    }
    const worker = code(read('src/lib/integrations/worker/process-outbox.ts'))
    expect(worker).not.toMatch(/event_type\s*:/)
  })
})
