import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  EMPTY_SELECTIONS,
  ISSUE_ACTIONS,
  ISSUE_CATEGORIES,
  ISSUE_FIX_OWNERS,
  ISSUE_INCIDENT_TYPES,
  ISSUE_SEVERITIES,
  incidentTypesFor,
  parseIssueSelections,
  prefillFromIssueType,
  selectionsFromRow,
  selectionsToRpc,
  toggleAction,
  type IssueAction,
} from '@/lib/issues/issue-selections'
import {
  PREPARE_PHOTO_FAILED,
  isCopyConflict,
  prepareIssuePhotoFromPack,
  type PackPhotoRow,
  type PrepareIssuePhotoIO,
} from '@/lib/issues/prepare-issue-photo'
import { finalizeIssueErrorMessage } from '@/lib/issues/finalize-issue-errors'
import { ASANA_STATUS_LABEL, asanaIssueStatus, pickCreateJob } from '@/lib/issues/asana-status'
import { loadFlagAsanaStatuses, loadPackPhotoIssues } from '@/lib/issues/load-pack-photo-issues'
import { PHOTOS_NOT_UPLOADED_MESSAGE } from '@/lib/photos/finalize-helpers'
import { masterStoragePath, thumbStoragePath } from '@/lib/photos/paths'
import { desiredFieldValuesForIssue } from '@/lib/integrations/asana/field-issue-mapping'
import {
  BETA_FIELD_CONFIG,
  LIVE_INCIDENTS_FIELD_REFERENCE,
  writableFieldConfig,
  type ProjectFieldConfig,
} from '@/lib/integrations/asana/field-config'
import { resolveCustomFields, validateWritableFieldConfig } from '@/lib/integrations/asana/field-validation'
import { ASANA_TEST_PROJECT_GID } from '@/lib/integrations/asana/config'

/**
 * "Report issue" from a pre-arrival pack photo — the pure pieces:
 * selections validation, the server-side photo copy, error mapping, the
 * honest Asana status, the read-only issue loader, and the Asana field
 * mapping/resolution (BETA mirror of the verified live schema).
 */

const CO = '1669c464-8d26-40fc-9956-9f8955fd27c7'
const PROP = '3ed2a749-0954-4216-8095-2a1bf2af7aaa'
const FLAG = '96487471-8c6e-48bc-828e-26255ad5277d'
const PACK_PHOTO = 'a080d3ca-61b3-4dd5-9a56-87a90135761d'
const NEW_PHOTO = 'c5b1a2e4-1f7d-4c2b-9a8e-3d6f5e4c2b1a'

// ---------------------------------------------------------------- selections

describe('issue selections: parse (server-side validation)', () => {
  it('empty / null / undefined -> all blank', () => {
    for (const v of [null, undefined, {}]) expect(parseIssueSelections(v)).toEqual({ ok: true, value: EMPTY_SELECTIONS })
  })

  it('a full valid selection is accepted; actions are de-duplicated into canonical order', () => {
    expect(
      parseIssueSelections({
        category: 'inventory',
        incidentType: 'missing_item',
        actions: ['replace', 'fix', 'replace'],
        severity: 'major',
        fixOwner: 'vendor',
      }),
    ).toEqual({
      ok: true,
      value: { category: 'inventory', incidentType: 'missing_item', actions: ['fix', 'replace'], severity: 'major', fixOwner: 'vendor' },
    })
  })

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['an unknown key', { category: 'inventory', priority: 'high' }],
    ['an unknown category', { category: 'garden' }],
    ['incident type without category', { incidentType: 'missing_item' }],
    ['incident type of another category', { category: 'inventory', incidentType: 'stain' }],
    ['incident type for a category without types', { category: 'maintenance', incidentType: 'other' }],
    ['actions not an array', { actions: 'fix' }],
    ['an unknown action', { actions: ['fix', 'paint'] }],
    ['N/A with another action', { actions: ['na', 'fix'] }],
    ['too many actions', { actions: ['fix', 'clean', 'replace', 'record_keeping', 'fix', 'clean'] }],
    ['an unknown severity', { severity: 'critical' }],
    ['an unknown fix owner', { fixOwner: 'investor_recovery' }],
    ['a GID instead of a key', { category: '1211490712226253' }],
  ])('rejects %s', (_l, input) => {
    expect(parseIssueSelections(input).ok).toBe(false)
  })

  it('every category with incident types offers exactly its own list', () => {
    expect(incidentTypesFor('inventory')).toBe(ISSUE_INCIDENT_TYPES.inventory)
    expect(incidentTypesFor('linen')).toBe(ISSUE_INCIDENT_TYPES.linen)
    expect(incidentTypesFor('hoa')).toBe(ISSUE_INCIDENT_TYPES.hoa)
    for (const c of ['maintenance', 'amenity', 'permanent_fixtures', null] as const) expect(incidentTypesFor(c)).toEqual([])
  })

  it('round-trips through the RPC JSON and a stored row', () => {
    const value = { category: 'hoa' as const, incidentType: 'warning_2', actions: ['record_keeping'] as IssueAction[], severity: null, fixOwner: 'drop_inn' as const }
    const rpc = selectionsToRpc(value)
    expect(rpc).toEqual({ category: 'hoa', incident_type: 'warning_2', actions: ['record_keeping'], severity: null, fix_owner: 'drop_inn' })
    expect(selectionsFromRow(rpc)).toEqual(value)
  })

  it('an invalid stored row yields NO selections (nothing guessed)', () => {
    expect(selectionsFromRow({ category: 'inventory', incident_type: 'stain', actions: ['fix'], severity: null, fix_owner: null })).toEqual(EMPTY_SELECTIONS)
  })
})

describe('"What needs to happen?" toggle', () => {
  it('multi-select add / remove', () => {
    expect(toggleAction([], 'fix')).toEqual(['fix'])
    expect(toggleAction(['fix'], 'clean')).toEqual(['fix', 'clean'])
    expect(toggleAction(['fix', 'clean'], 'fix')).toEqual(['clean'])
  })
  it('N/A is exclusive both ways', () => {
    expect(toggleAction(['fix', 'clean'], 'na')).toEqual(['na'])
    expect(toggleAction(['na'], 'replace')).toEqual(['replace'])
  })
})

describe('prefill from the app issue type (only where certain)', () => {
  it.each([
    ['maintenance_issue', { category: 'maintenance', incidentType: null }],
    ['inventory_missing', { category: 'inventory', incidentType: 'missing_item' }],
    ['inventory_damaged', { category: 'inventory', incidentType: 'physical_damage' }],
    ['cleaning_issue', { category: null, incidentType: null }],
    ['guest_damage', { category: null, incidentType: null }],
    ['safety_urgent', { category: null, incidentType: null }],
  ])('%s', (key, expected) => {
    expect(prefillFromIssueType(key)).toEqual(expected)
    // whatever is prefilled is itself a valid selection
    expect(parseIssueSelections(expected).ok).toBe(true)
  })
})

describe('the app keys line up with the verified live Asana options (no drift)', () => {
  const live = LIVE_INCIDENTS_FIELD_REFERENCE.fields
  it('every category / incident type / action / severity / fix owner key has a live option', () => {
    for (const c of ISSUE_CATEGORIES) expect(live.category?.options?.[c.key], c.key).toBeTruthy()
    for (const t of ISSUE_INCIDENT_TYPES.inventory) expect(live.inventoryIncidentType?.options?.[t.key], t.key).toBeTruthy()
    for (const t of ISSUE_INCIDENT_TYPES.linen) expect(live.linenIncidentType?.options?.[t.key], t.key).toBeTruthy()
    for (const t of ISSUE_INCIDENT_TYPES.hoa) expect(live.hoaIncidentType?.options?.[t.key], t.key).toBeTruthy()
    for (const a of ISSUE_ACTIONS) expect(live.replacementRequired?.options?.[a.key], a.key).toBeTruthy()
    for (const s of ISSUE_SEVERITIES) expect(live.severity?.options?.[s.key], s.key).toBeTruthy()
    for (const o of ISSUE_FIX_OWNERS) expect(live.fixOwner?.options?.[o.key], o.key).toBeTruthy()
  })
})

// ---------------------------------------------------------------- photo copy

const packRow = (over: Partial<PackPhotoRow> = {}): PackPhotoRow => ({
  id: PACK_PHOTO,
  company_id: CO,
  property_id: PROP,
  evidence_pack_id: 'pack-1',
  storage_path: `companies/${CO}/properties/${PROP}/photos/${PACK_PHOTO}.jpg`,
  thumbnail_path: `companies/${CO}/properties/${PROP}/photos/${PACK_PHOTO}_thumb.jpg`,
  width: 1600,
  height: 1200,
  size_bytes: 345678,
  sync_status: 'synced',
  deleted_at: null,
  bytes_deleted_at: null,
  ...over,
})

function io(over: Partial<PrepareIssuePhotoIO> = {}) {
  const calls: string[] = []
  const base: PrepareIssuePhotoIO = {
    loadPackPhoto: vi.fn(async () => packRow()),
    collision: vi.fn(async () => ({ ok: true as const })),
    copy: vi.fn(async (from: string, to: string) => (calls.push(`${from} -> ${to}`), { ok: true as const })),
    presence: vi.fn(async () => 'present' as const),
    ...over,
  }
  return { io: base, calls }
}
const input = { companyId: CO, propertyId: PROP, proposedFlagId: FLAG, packPhotoId: PACK_PHOTO, newPhotoId: NEW_PHOTO }
const target = { kind: 'flag' as const, companyId: CO, flagId: FLAG, photoId: NEW_PHOTO }

describe('prepareIssuePhotoFromPack (server-side copy; the pack photo is never changed)', () => {
  it('copies master + thumb to the issue\'s own derived paths and returns the descriptor', async () => {
    const h = io()
    expect(await prepareIssuePhotoFromPack(h.io, input)).toEqual({
      ok: true,
      photo: { photoId: NEW_PHOTO, width: 1600, height: 1200, sizeBytes: 345678 },
    })
    expect(h.calls).toEqual([
      `${packRow().storage_path} -> ${masterStoragePath(target)}`,
      `${packRow().thumbnail_path} -> ${thumbStoragePath(target)}`,
    ])
    expect(h.io.collision).toHaveBeenCalledWith(FLAG, NEW_PHOTO)
  })

  it.each([
    ['not found / not visible', null],
    ['another company', packRow({ company_id: 'other' })],
    ['another property', packRow({ property_id: 'other' })],
    ['not a pack photo', packRow({ evidence_pack_id: null })],
    ['deleted', packRow({ deleted_at: '2026-11-01T00:00:00Z' })],
    ['bytes deleted', packRow({ bytes_deleted_at: '2026-11-01T00:00:00Z' })],
    ['not synced', packRow({ sync_status: 'pending' })],
    ['no master', packRow({ storage_path: null })],
    ['no thumb', packRow({ thumbnail_path: null })],
    ['no width', packRow({ width: null })],
    ['zero size', packRow({ size_bytes: 0 })],
  ])('refuses a pack photo that is %s — and copies NOTHING', async (_l, row) => {
    const h = io({ loadPackPhoto: vi.fn(async () => row) })
    const r = await prepareIssuePhotoFromPack(h.io, input)
    expect(r.ok).toBe(false)
    expect(h.io.copy).not.toHaveBeenCalled()
    expect(h.io.collision).not.toHaveBeenCalled()
  })

  it('a failed read -> generic error, nothing copied', async () => {
    const h = io({ loadPackPhoto: vi.fn(async () => 'error' as const) })
    expect(await prepareIssuePhotoFromPack(h.io, input)).toEqual({ ok: false, error: PREPARE_PHOTO_FAILED })
    expect(h.io.copy).not.toHaveBeenCalled()
  })

  it('a collision (ids already used) -> refused before any copy', async () => {
    const h = io({ collision: vi.fn(async () => ({ ok: false as const, error: 'That id is already in use.' })) })
    expect(await prepareIssuePhotoFromPack(h.io, input)).toEqual({ ok: false, error: 'That id is already in use.' })
    expect(h.io.copy).not.toHaveBeenCalled()
  })

  it('RETRY: target already exists (conflict) and is proven present -> accepted, never overwritten', async () => {
    const h = io({ copy: vi.fn(async () => ({ ok: false as const, conflict: true })) })
    expect((await prepareIssuePhotoFromPack(h.io, input)).ok).toBe(true)
    expect(h.io.presence).toHaveBeenCalledWith(masterStoragePath(target))
    expect(h.io.presence).toHaveBeenCalledWith(thumbStoragePath(target))
  })

  it.each(['missing', 'unknown'] as const)('conflict but presence %s -> failure', async (p) => {
    const h = io({ copy: vi.fn(async () => ({ ok: false as const, conflict: true })), presence: vi.fn(async () => p) })
    expect(await prepareIssuePhotoFromPack(h.io, input)).toEqual({ ok: false, error: PREPARE_PHOTO_FAILED })
  })

  it('a non-conflict copy failure -> failure without a presence check', async () => {
    const h = io({ copy: vi.fn(async () => ({ ok: false as const, conflict: false })) })
    expect(await prepareIssuePhotoFromPack(h.io, input)).toEqual({ ok: false, error: PREPARE_PHOTO_FAILED })
    expect(h.io.presence).not.toHaveBeenCalled()
  })

  it('isCopyConflict', () => {
    expect(isCopyConflict({ statusCode: '409' })).toBe(true)
    expect(isCopyConflict({ statusCode: 409 })).toBe(true)
    expect(isCopyConflict({ message: 'The resource already exists' })).toBe(true)
    expect(isCopyConflict({ message: 'Duplicate' })).toBe(true)
    expect(isCopyConflict({ statusCode: '404', message: 'Object not found' })).toBe(false)
    expect(isCopyConflict(null)).toBe(false)
  })
})

// ---------------------------------------------------------------- errors / status

describe('finalizeIssueErrorMessage (no raw database text ever reaches the UI)', () => {
  it.each([
    [{ code: '23514', message: `evidence master object missing for photo ${NEW_PHOTO}` }, PHOTOS_NOT_UPLOADED_MESSAGE],
    [{ code: 'PGRST202', message: 'Could not find the function public.finalize_flag_issue_with_photos' }, /not switched on yet/],
    [{ code: '42883', message: 'function does not exist' }, /not switched on yet/],
    [{ code: '23505', message: 'issue selections already exist with different selections' }, /different details/],
    [{ code: 'P0002', message: 'source pack photo not found' }, /pack photo could not be found/],
    [{ code: '22023', message: 'invalid selections' }, /not valid/],
  ])('%o', (err, expected) => {
    const msg = finalizeIssueErrorMessage(err)
    if (typeof expected === 'string') expect(msg).toBe(expected)
    else expect(msg).toMatch(expected)
    expect(msg).not.toContain(err.message)
  })

  it('anything else -> null (caller shows its own generic message)', () => {
    expect(finalizeIssueErrorMessage({ code: 'XX000', message: 'boom' })).toBeNull()
    expect(finalizeIssueErrorMessage(null)).toBeNull()
  })
})

describe('asanaIssueStatus is derived only from facts', () => {
  const job = (status: string) => ({ status })
  it.each([
    [{ asanaTaskUrl: 'https://app.asana.com/0/1/2', createJob: job('dead') }, 'in_asana'],
    [{ asanaTaskUrl: 'https://app.asana.com/0/1/2', createJob: 'unknown' as const }, 'in_asana'],
    [{ asanaTaskUrl: null, createJob: job('pending') }, 'queued'],
    [{ asanaTaskUrl: null, createJob: job('processing') }, 'queued'],
    [{ asanaTaskUrl: null, createJob: job('dead') }, 'needs_attention'],
    [{ asanaTaskUrl: null, createJob: job('manual_review') }, 'needs_attention'],
    // "done" but no link saved on the flag: nothing is on its way, nothing is proven.
    [{ asanaTaskUrl: null, createJob: job('done') }, 'needs_attention'],
    [{ asanaTaskUrl: null, createJob: job('some_future_state') }, 'needs_attention'],
    [{ asanaTaskUrl: null, createJob: null }, 'not_sent'],
    [{ asanaTaskUrl: '', createJob: null }, 'not_sent'],
    // a FAILED lookup is never "not sent" and never "sending"
    [{ asanaTaskUrl: null, createJob: 'unknown' as const }, 'unknown'],
  ])('%o -> %s', (i, expected) => {
    expect(asanaIssueStatus(i)).toBe(expected)
  })

  it('never claims "In Asana" without a task link; a dead job is never "Sending"', () => {
    for (const s of ['pending', 'processing', 'done', 'dead', 'mystery']) {
      expect(asanaIssueStatus({ asanaTaskUrl: null, createJob: job(s) })).not.toBe('in_asana')
    }
    expect(asanaIssueStatus({ asanaTaskUrl: null, createJob: job('dead') })).not.toBe('queued')
    expect(ASANA_STATUS_LABEL).toEqual({
      in_asana: 'In Asana',
      queued: 'Sending to Asana',
      needs_attention: 'Asana sync needs attention',
      not_sent: 'Not sent to Asana',
      unknown: 'Asana status unavailable',
    })
  })
})

describe('pickCreateJob: THE create job for a flag, deterministically', () => {
  const F = '11111111-1111-4111-8111-111111111111'
  const row = (over: Record<string, unknown>) => ({
    id: 'a', entity_id: F, status: 'pending', created_at: '2026-11-01T10:00:00Z', deleted_at: null,
    provider: 'asana', event_type: 'asana.create_task_for_flag', entity_type: 'flag', ...over,
  })

  it('no rows -> null (confirmed absence)', () => {
    expect(pickCreateJob([], F)).toBeNull()
  })

  it('historical SOFT-DELETED jobs are ignored; the live one decides', () => {
    const rows = [
      row({ id: 'old1', status: 'dead', created_at: '2026-10-01T00:00:00Z', deleted_at: '2026-10-02T00:00:00Z' }),
      row({ id: 'old2', status: 'done', created_at: '2026-11-05T00:00:00Z', deleted_at: '2026-11-06T00:00:00Z' }),
      row({ id: 'live', status: 'pending', created_at: '2026-10-15T00:00:00Z' }),
    ]
    expect(pickCreateJob(rows, F)).toEqual({ status: 'pending' })
    expect(pickCreateJob(rows.slice(0, 2), F)).toBeNull() // only deleted history -> none
  })

  it('unrelated rows (other flag / event / provider / entity type) are ignored', () => {
    const rows = [
      row({ entity_id: '22222222-2222-4222-8222-222222222222', status: 'dead' }),
      row({ event_type: 'asana.attach_flag_evidence', status: 'dead' }),
      row({ provider: 'other', status: 'dead' }),
      row({ entity_type: 'property', status: 'dead' }),
      row({ status: null }),
    ]
    expect(pickCreateJob(rows, F)).toBeNull()
    expect(pickCreateJob([...rows, row({ status: 'processing' })], F)).toEqual({ status: 'processing' })
  })

  it('several live rows: newest created wins, ties by id — whatever the input order', () => {
    const rows = [
      row({ id: 'b', status: 'dead', created_at: '2026-11-02T00:00:00Z' }),
      row({ id: 'c', status: 'pending', created_at: '2026-11-03T00:00:00Z' }),
      row({ id: 'a', status: 'done', created_at: '2026-11-03T00:00:00Z' }),
    ]
    for (const order of [rows, [...rows].reverse(), [rows[1], rows[2], rows[0]]]) {
      expect(pickCreateJob(order, F)).toEqual({ status: 'pending' })
    }
  })
})

// ---------------------------------------------------------------- loader

type Res = { data: unknown; error?: unknown }
function loaderDb(t: { selections?: Res; flags?: Res; jobs?: Res; throws?: 'all' | 'status' }) {
  const filters: Record<string, Array<[string, string, unknown]>> = {}
  const client = {
    from: (table: string) => {
      if (t.throws === 'all' || (t.throws === 'status' && table !== 'flag_issue_selections')) throw new Error('down')
      const f: Array<[string, string, unknown]> = (filters[table] ??= [])
      const res = table === 'flag_issue_selections' ? t.selections : table === 'flags' ? t.flags : t.jobs
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (f.push(['eq', c, v]), q),
        in: (c: string, v: unknown) => (f.push(['in', c, v]), q),
        is: (c: string, v: unknown) => (f.push(['is', c, v]), q),
        order: () => q,
        then: (resolve: (v: unknown) => void) => resolve(res ?? { data: [], error: null }),
      }
      return q
    },
  } as unknown as SupabaseClient
  return { client, filters }
}

const F1 = '11111111-1111-4111-8111-111111111111'
const F2 = '22222222-2222-4222-8222-222222222222'
const F3 = '33333333-3333-4333-8333-333333333333'
const jobRow = (flag: string, status: string, over: Record<string, unknown> = {}) => ({
  id: `job-${flag}-${status}`, entity_id: flag, status, created_at: '2026-11-10T00:00:00Z', deleted_at: null,
  provider: 'asana', event_type: 'asana.create_task_for_flag', entity_type: 'flag', ...over,
})

describe('loadFlagAsanaStatuses (the REAL job state + task link; a failed read is "unknown")', () => {
  it('link saved / live pending / dead / completed-with-link / no job / deleted flag', async () => {
    const F4 = '44444444-4444-4444-8444-444444444444'
    const F5 = '55555555-5555-4555-8555-555555555555'
    const db = loaderDb({
      flags: {
        data: [
          { id: F1, asana_task_url: 'https://app.asana.com/0/1/9' }, // completed job, link saved
          { id: F2, asana_task_url: null },
          { id: F3, asana_task_url: null },
          { id: F4, asana_task_url: null },
        ],
      },
      jobs: { data: [jobRow(F1, 'done'), jobRow(F2, 'dead'), jobRow(F3, 'pending')] },
    })
    const m = await loadFlagAsanaStatuses(db.client, CO, [F1, F2, F3, F4, F5])
    expect(Object.fromEntries(m)).toEqual({
      [F1]: 'in_asana',
      [F2]: 'needs_attention',
      [F3]: 'queued',
      [F4]: 'not_sent', // confirmed: flag read OK, outbox read OK, no job
      [F5]: 'deleted',
    })
    // scoped to the company; only live Asana create-task rows for flags
    expect(db.filters.flags).toEqual(expect.arrayContaining([['eq', 'company_id', CO], ['is', 'deleted_at', null]]))
    expect(db.filters.integration_outbox).toEqual(
      expect.arrayContaining([
        ['eq', 'company_id', CO],
        ['eq', 'provider', 'asana'],
        ['eq', 'event_type', 'asana.create_task_for_flag'],
        ['eq', 'entity_type', 'flag'],
        ['is', 'deleted_at', null],
      ]),
    )
  })

  it('historical soft-deleted jobs never decide the status (even if the query returned them)', async () => {
    const db = loaderDb({
      flags: { data: [{ id: F1, asana_task_url: null }, { id: F2, asana_task_url: null }] },
      jobs: {
        data: [
          jobRow(F1, 'dead', { id: 'old', deleted_at: '2026-11-01T00:00:00Z', created_at: '2026-11-20T00:00:00Z' }),
          jobRow(F1, 'pending', { id: 'live', created_at: '2026-11-02T00:00:00Z' }),
          jobRow(F2, 'pending', { id: 'old2', deleted_at: '2026-11-01T00:00:00Z' }),
        ],
      },
    })
    expect(Object.fromEntries(await loadFlagAsanaStatuses(db.client, CO, [F1, F2]))).toEqual({ [F1]: 'queued', [F2]: 'not_sent' })
  })

  it('FAILED outbox read -> "unknown" (never "not sent"); a saved link still shows "In Asana"', async () => {
    const db = loaderDb({
      flags: { data: [{ id: F1, asana_task_url: null }, { id: F2, asana_task_url: 'https://app.asana.com/0/1/9' }] },
      jobs: { data: null, error: { code: 'XX000' } },
    })
    expect(Object.fromEntries(await loadFlagAsanaStatuses(db.client, CO, [F1, F2]))).toEqual({ [F1]: 'unknown', [F2]: 'in_asana' })
  })

  it('FAILED flags read or a thrown error -> every flag "unknown" (never "deleted" / "not sent")', async () => {
    const failed = loaderDb({ flags: { data: null, error: { code: 'XX000' } }, jobs: { data: [] } })
    expect(Object.fromEntries(await loadFlagAsanaStatuses(failed.client, CO, [F1, F2]))).toEqual({ [F1]: 'unknown', [F2]: 'unknown' })
    expect(Object.fromEntries(await loadFlagAsanaStatuses(loaderDb({ throws: 'all' }).client, CO, [F1]))).toEqual({ [F1]: 'unknown' })
  })

  it('no flags -> no reads', async () => {
    expect((await loadFlagAsanaStatuses(loaderDb({ throws: 'all' }).client, CO, [])).size).toBe(0)
  })
})

describe('loadPackPhotoIssues (read-only; never blocks the pack page)', () => {
  it('groups saved issues by pack photo with the real Asana status; skips deleted flags', async () => {
    const db = loaderDb({
      selections: {
        data: [
          { flag_id: F1, source_pack_photo_id: PACK_PHOTO },
          { flag_id: F2, source_pack_photo_id: PACK_PHOTO },
          { flag_id: F3, source_pack_photo_id: 'other-photo' },
        ],
      },
      flags: { data: [{ id: F1, asana_task_url: 'https://app.asana.com/0/1/9' }, { id: F2, asana_task_url: null }] },
      jobs: { data: [jobRow(F2, 'dead')] },
    })
    expect(await loadPackPhotoIssues(db.client, CO, [PACK_PHOTO, 'other-photo'])).toEqual({
      [PACK_PHOTO]: [
        { flagId: F1, asanaStatus: 'in_asana' },
        { flagId: F2, asanaStatus: 'needs_attention' },
      ],
    })
    expect(db.filters.flag_issue_selections).toContainEqual(['eq', 'company_id', CO])
  })

  it('issue table missing / unreadable / throw -> {} (page still renders)', async () => {
    expect(await loadPackPhotoIssues(loaderDb({ selections: { data: null, error: { code: '42P01' } } }).client, CO, [PACK_PHOTO])).toEqual({})
    expect(await loadPackPhotoIssues(loaderDb({ throws: 'all' }).client, CO, [PACK_PHOTO])).toEqual({})
  })

  it('a failed STATUS lookup keeps the saved issue visible as "unknown" — not hidden, not "not sent"', async () => {
    const selections = { data: [{ flag_id: F1, source_pack_photo_id: PACK_PHOTO }] }
    for (const db of [
      loaderDb({ selections, flags: { data: null, error: { code: 'XX' } } }),
      loaderDb({ selections, flags: { data: [{ id: F1, asana_task_url: null }] }, jobs: { data: null, error: { code: 'XX' } } }),
      loaderDb({ selections, throws: 'status' }),
    ]) {
      expect(await loadPackPhotoIssues(db.client, CO, [PACK_PHOTO])).toEqual({ [PACK_PHOTO]: [{ flagId: F1, asanaStatus: 'unknown' }] })
    }
  })

  it('no photos -> no reads', async () => {
    expect(await loadPackPhotoIssues(loaderDb({ throws: 'all' }).client, CO, [])).toEqual({})
  })
})

// ---------------------------------------------------------------- Asana fields

/** custom_field_settings for a config: every configured option enabled. */
function schemaFor(config: ProjectFieldConfig, projectGid: string) {
  return {
    gid: projectGid,
    custom_field_settings: Object.values(config.fields).flatMap((spec) =>
      spec
        ? [
            {
              project: { gid: projectGid },
              custom_field: {
                gid: spec.gid,
                resource_subtype: spec.type,
                ...(spec.type === 'enum' || spec.type === 'multi_enum'
                  ? { enum_options: Object.values(spec.options ?? {}).map((gid) => ({ gid, enabled: true })) }
                  : {}),
              },
            },
          ]
        : [],
    ),
  }
}

/** What BETA will look like once the admin mirrors the live fields. */
const MIRROR = writableFieldConfig({ ...LIVE_INCIDENTS_FIELD_REFERENCE, projectGid: ASANA_TEST_PROJECT_GID, label: 'BETA mirror (test)' })
const mirrorValidation = () => validateWritableFieldConfig(MIRROR, schemaFor(MIRROR, ASANA_TEST_PROJECT_GID))
const L = LIVE_INCIDENTS_FIELD_REFERENCE.fields

const resolveIssue = (s: Parameters<typeof desiredFieldValuesForIssue>[0], evidence: boolean | null = true) => {
  const mapped = desiredFieldValuesForIssue(s, evidence)
  const resolved = resolveCustomFields(mapped.desired, mirrorValidation())
  return { ...resolved, mappedWarnings: mapped.warnings }
}

describe('Report-issue selections -> Asana fields (BETA mirror of the live schema)', () => {
  it('full selection -> Category, incident type, Replacement Required (all), Severity, Fix Owner, Evidence', () => {
    const r = resolveIssue({ category: 'inventory', incidentType: 'physical_damage', actions: ['fix', 'replace'], severity: 'moderate', fixOwner: 'maintenance' })
    expect(r.customFields).toEqual({
      [L.category!.gid]: L.category!.options!.inventory,
      [L.inventoryIncidentType!.gid]: L.inventoryIncidentType!.options!.physical_damage,
      [L.replacementRequired!.gid]: [L.replacementRequired!.options!.fix, L.replacementRequired!.options!.replace],
      [L.severity!.gid]: L.severity!.options!.moderate,
      [L.fixOwner!.gid]: L.fixOwner!.options!.maintenance,
      [L.evidenceReceived!.gid]: L.evidenceReceived!.options!.yes,
    })
    expect(r.warnings).toEqual([])
  })

  it('HOA incident type is a multi_enum ARRAY and only sent with Category = HOA', () => {
    const r = resolveIssue({ category: 'hoa', incidentType: 'noise_complaint', actions: [], severity: null, fixOwner: null })
    expect(r.customFields[L.hoaIncidentType!.gid]).toEqual([L.hoaIncidentType!.options!.noise_complaint])
    expect(r.customFields[L.category!.gid]).toBe(L.category!.options!.hoa)
  })

  it('resolver defence: an HOA incident type WITHOUT an emitted HOA Category is never sent', () => {
    for (const category of ['inventory', undefined] as const) {
      const r = resolveCustomFields({ category, hoaIncidentType: 'facilities' }, mirrorValidation())
      expect(r.customFields).not.toHaveProperty(L.hoaIncidentType!.gid)
      expect(r.warnings.map((w) => `${w.code}:${w.field}`)).toContain('dependency_unmet:hoaIncidentType')
    }
  })

  it('blank optional details are simply not sent (Severity / Fix Owner start blank)', () => {
    const r = resolveIssue({ ...EMPTY_SELECTIONS, category: 'maintenance', actions: ['clean'] })
    expect(Object.keys(r.customFields).sort()).toEqual([L.category!.gid, L.replacementRequired!.gid, L.evidenceReceived!.gid].sort())
  })

  it('nothing chosen -> Evidence only; no evidence -> nothing; unknown evidence -> warning, nothing guessed', () => {
    expect(resolveIssue(EMPTY_SELECTIONS).customFields).toEqual({ [L.evidenceReceived!.gid]: L.evidenceReceived!.options!.yes })
    expect(resolveIssue(EMPTY_SELECTIONS, false).customFields).toEqual({})
    const u = resolveIssue(EMPTY_SELECTIONS, null)
    expect(u.customFields).toEqual({})
    expect(u.mappedWarnings.map((w) => w.code)).toEqual(['source_unavailable'])
  })

  it('Replacement Required is all-or-nothing (a partial set would mis-route the task)', () => {
    const partial = writableFieldConfig({
      ...MIRROR,
      fields: { ...MIRROR.fields, replacementRequired: { ...L.replacementRequired!, options: { fix: L.replacementRequired!.options!.fix } } },
    })
    const v = validateWritableFieldConfig(partial, schemaFor(partial, ASANA_TEST_PROJECT_GID))
    const mapped = desiredFieldValuesForIssue({ ...EMPTY_SELECTIONS, actions: ['fix', 'replace'] }, true)
    const r = resolveCustomFields(mapped.desired, v)
    expect(r.customFields).not.toHaveProperty(L.replacementRequired!.gid)
    expect(r.warnings.map((w) => `${w.code}:${w.field}`)).toContain('unmapped_value:replacementRequired')
  })

  it('TODAY\'s real BETA config (fields not mirrored yet): routing / triage fields are omitted with warnings, never sent to a wrong field', () => {
    const beta = writableFieldConfig(BETA_FIELD_CONFIG)
    const v = validateWritableFieldConfig(beta, schemaFor(BETA_FIELD_CONFIG, ASANA_TEST_PROJECT_GID))
    const mapped = desiredFieldValuesForIssue({ category: 'linen', incidentType: 'stain', actions: ['clean'], severity: 'minor', fixOwner: 'housekeeping' }, true)
    const r = resolveCustomFields(mapped.desired, v)
    const B = BETA_FIELD_CONFIG.fields
    expect(r.customFields).toEqual({
      [B.category!.gid]: B.category!.options!.linen,
      [B.linenIncidentType!.gid]: B.linenIncidentType!.options!.stain,
      [B.evidenceReceived!.gid]: B.evidenceReceived!.options!.yes,
    })
    expect(r.warnings.filter((w) => w.code === 'field_unusable').map((w) => w.field).sort()).toEqual(['fixOwner', 'replacementRequired', 'severity'])
    // no LIVE GID can appear in a BETA write
    const liveGids = new Set(Object.values(L).flatMap((s) => (s ? [s.gid, ...Object.values(s.options ?? {})] : [])))
    const sharedLibrary = new Set([L.unit!.gid, L.unitNumber!.gid])
    for (const g of [...Object.keys(r.customFields), ...Object.values(r.customFields).flat()]) {
      if (!sharedLibrary.has(g)) expect(liveGids.has(g)).toBe(false)
    }
  })

  it('Unit #, Unit Number and Accountable Party are never produced', () => {
    const r = resolveIssue({ category: 'inventory', incidentType: 'lost_keys', actions: ['replace'], severity: 'write_off', fixOwner: 'drop_inn' })
    for (const f of [L.unit!.gid, L.unitNumber!.gid, L.accountableParty!.gid]) expect(r.customFields).not.toHaveProperty(f)
  })
})
