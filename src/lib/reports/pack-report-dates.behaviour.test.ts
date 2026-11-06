import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isValidElement, type ReactNode } from 'react'

/**
 * The SHARED PDF of a pre-arrival pack is dated by its SUBMISSION (South
 * Africa time), through the real data loader (loadPackReportData, with
 * only the service client faked) and the real PDF document tree.
 * Acceptance pack: Nichole's Unit 75 pack 4c28e0c5 (draft 29 Oct 09:20,
 * submitted 3 Nov 16:02).
 */

vi.mock('server-only', () => ({}))

const PACK_ID = '4c28e0c5-c40a-484e-b38a-3e6d3b3bf747'
let packRow: Record<string, unknown> | null

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'order', 'in']) q[m] = () => q
      q.maybeSingle = async () => {
        if (table === 'evidence_packs') return { data: packRow, error: null }
        if (table === 'properties')
          return { data: { name: 'Unit 75', address: 'Ballito Life Estate', unit_reference: '75', bedrooms: 2 }, error: null }
        return { data: null, error: null }
      }
      q.returns = async () => {
        if (table === 'photos')
          return {
            data: [
              { id: 'ph1', storage_path: 'x/ph1.jpg', notes: 'Kettle chipped', captured_at: '2026-11-03T13:35:34Z', uploaded_at: '2026-11-03T13:54:00Z', uploaded_by: 'u-nichole', width: 1600, height: 1200 },
            ],
            error: null,
          }
        if (table === 'profiles') return { data: [{ id: 'u-nichole', full_name: 'Nichole', email: null }], error: null }
        return { data: [], error: null }
      }
      return q
    },
    storage: {
      from: () => ({
        download: async () => ({ data: { arrayBuffer: async () => new ArrayBuffer(4) }, error: null }),
      }),
    },
  }),
}))

import { loadPackReportData } from '@/lib/reports/report-data'
import { PackReportDocument } from '@/lib/reports/pack-report-document'
import { packContentHash, packReportObjectPath } from '@/lib/reports/report-paths'
import { formatDateDMY } from '@/lib/ui/datetime'
import { packShareFilename } from '@/lib/reports/report-paths'

/** All text rendered by a react-pdf element tree. */
function textOf(node: ReactNode): string[] {
  if (node == null || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textOf)
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    if (typeof node.type === 'function') {
      return textOf((node.type as (p: unknown) => ReactNode)(node.props))
    }
    return textOf(props.children)
  }
  return []
}

beforeEach(() => {
  packRow = {
    id: PACK_ID,
    property_id: '9d27d742-fa0e-4af4-8bbc-17d4752d7ef7',
    pack_type: 'pre_arrival',
    status: 'submitted',
    title: 'Pre-arrival pack — 29 Oct 2026, 09:20',
    started_at: '2026-10-29T07:20:33.968014+00:00',
    submitted_by: 'u-nichole',
    submitted_at: '2026-11-03T14:02:56.438344+00:00',
  }
})

describe('shared PDF for the Unit 75 pack', () => {
  it('data: heading/date = submission (3 Nov), draft created kept as secondary', async () => {
    const data = await loadPackReportData('Drop-Inn', PACK_ID)
    expect(data).not.toBeNull()
    expect(data!.heading).toBe('Pre-arrival pack — 3 Nov 2026')
    expect(data!.mainDate).toBe('3 Nov 2026')
    expect(data!.submittedText).toBe('3 Nov 2026, 16:02')
    expect(data!.draftCreatedText).toBe('29 Oct 2026, 09:20')
    // stored values untouched
    expect(data!.title).toBe('Pre-arrival pack — 29 Oct 2026, 09:20')
    expect(data!.fingerprint.startedAt).toBe('2026-10-29T07:20:33.968014+00:00')
    expect(data!.fingerprint.submittedAt).toBe('2026-11-03T14:02:56.438344+00:00')
    // share filename date = submission date
    expect(packShareFilename(data!.propertyName, formatDateDMY(data!.reportDateIso))).toBe('Unit 75 - 03-11-2026.pdf')
  })

  it('PDF text: "Submitted 3 Nov 2026, 16:02", Title = 3 Nov heading, "Draft created" 29 Oct as detail', async () => {
    const data = (await loadPackReportData('Drop-Inn', PACK_ID))!
    const text = textOf(PackReportDocument({ data })).join(' ')
    expect(text).toContain('Submitted 3 Nov 2026, 16:02')
    expect(text).toContain('Pre-arrival pack — 3 Nov 2026')
    expect(text).toContain('Draft created')
    expect(text).toContain('29 Oct 2026, 09:20')
    expect(text).not.toContain('Pre-arrival pack — 29 Oct 2026, 09:20')
    expect(text).not.toMatch(/\bStarted\b/)
    expect(text).toContain('Kettle chipped') // captions unchanged
  })

  it('a fresh share uses a NEW artifact path (old saved PDF is not reused)', async () => {
    const data = (await loadPackReportData('Drop-Inn', PACK_ID))!
    const path = packReportObjectPath('co', PACK_ID, packContentHash(data.fingerprint))
    expect(path).toContain('/pack-report-t2-')
    // The existing stored Unit 75 PDF (generated 3 Nov) was a template-1 artifact.
    expect(path).not.toContain('pack-report-t1-178e40627a6b55db.pdf')
  })

  it('a custom title is kept and the submission date is still shown', async () => {
    packRow!.title = 'Owner walk-through'
    const data = (await loadPackReportData('Drop-Inn', PACK_ID))!
    const text = textOf(PackReportDocument({ data })).join(' ')
    expect(data.heading).toBe('Owner walk-through')
    expect(text).toContain('Owner walk-through')
    expect(text).toContain('Submitted 3 Nov 2026, 16:02')
  })

  it('a submitted pack with no recorded time is honest and the filename has no date', async () => {
    packRow!.submitted_at = null
    const data = (await loadPackReportData('Drop-Inn', PACK_ID))!
    const text = textOf(PackReportDocument({ data })).join(' ')
    expect(data.reportDateIso).toBeNull()
    expect(text).toContain('Submission time not recorded')
    // no invented report date (photo capture times are separate and unchanged)
    expect(text).not.toMatch(/Submitted \d/)
    expect(data.heading).toBe('Pre-arrival pack')
    expect(packShareFilename(data.propertyName, formatDateDMY(data.reportDateIso))).toBe('Unit 75.pdf')
  })
})
