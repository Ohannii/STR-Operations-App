import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, Camera, FileText } from 'lucide-react'
import { PrintButton } from '@/components/photos/print-button'
import { getUserContext } from '@/lib/auth/get-user-context'
import {
  THUMB_TTL_SECONDS,
  signEvidencePaths,
} from '@/lib/photos/signed-urls'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /properties/[id]/pre-arrival/report
 *
 * The Pre-arrival Evidence Pack.
 *
 * Renders every photo attached to the property with
 * retention_class = 'routine_pre_arrival' AND flag_id is null.
 * Designed to be print-friendly via window.print() / Save as PDF —
 * the same pattern as the Flag Evidence Report, sharing the
 * @media print rules from globals.css and the PrintButton
 * component.
 *
 * This is DELIBERATELY not labelled "Inspection Report":
 *   - The full inspection workflow (line items, sections, finalise,
 *     audit chain) ships in a later session.
 *   - The pack we render here is the pre-arrival baseline only —
 *     enough to share over WhatsApp ("Unit 20 is ready, see
 *     attached") but not a formal inspection record.
 *   - When the inspection workflow ships, this same set of photos
 *     will be embedded inside the Inspection Report; the
 *     underlying photos table doesn't change. Same data, richer
 *     wrapper later.
 *
 * Layout follows Report & Run for evidence sections (one large
 * image per photo with caption / capture date / uploader) and
 * Red Rabbit for the header bar (slate-900 strip + report id).
 *
 * Master URLs are NOT pre-signed. Thumbnails are inlined and the
 * "Open full photo" link points at the on-demand view route which
 * signs the master at click time. Print-to-PDF uses the
 * thumbnails (sufficient for 400px @ 70% on letter paper); a
 * future session can upgrade the print path to embed masters if
 * the team needs higher resolution in the PDF.
 */

type PrePhotoRow = {
  id: string
  storage_path: string
  thumbnail_path: string | null
  notes: string | null
  captured_at: string | null
  uploaded_at: string
  uploaded_by: string
  width: number | null
  height: number | null
}

type ProfileRow = {
  id: string
  full_name: string | null
  email: string | null
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export default async function PreArrivalReportPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { id: propertyId } = await params

  const supabase = await createClient()

  const propertyPromise = supabase
    .from('properties')
    .select('id, name, address, unit_reference')
    .eq('id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<{
      id: string
      name: string
      address: string | null
      unit_reference: string | null
    }>()

  // Pre-arrival = property-scoped photos with the routine_pre_arrival
  // retention class and no parent flag (flag-scoped pre-arrival
  // promotions ship later via the retention promotion logic).
  const photosPromise = supabase
    .from('photos')
    .select(
      `id, storage_path, thumbnail_path, notes, captured_at,
       uploaded_at, uploaded_by, width, height`,
    )
    .eq('property_id', propertyId)
    .eq('retention_class', 'routine_pre_arrival')
    .is('flag_id', null)
    .is('deleted_at', null)
    .order('captured_at', { ascending: true, nullsFirst: false })
    .order('uploaded_at', { ascending: true })
    .returns<PrePhotoRow[]>()

  const [{ data: property }, { data: photos }] = await Promise.all([
    propertyPromise,
    photosPromise,
  ])

  if (!property) notFound()

  const photoRows = photos ?? []

  // Thumbnails only — print-to-PDF still gets a high-enough
  // resolution from a 400 px JPEG at letter-paper output.
  const thumbPaths = photoRows
    .map((p) => p.thumbnail_path)
    .filter((p): p is string => Boolean(p))
  const thumbUrls =
    thumbPaths.length > 0
      ? await signEvidencePaths(thumbPaths, THUMB_TTL_SECONDS)
      : {}

  const uploaderIds = Array.from(
    new Set(photoRows.map((p) => p.uploaded_by).filter((i): i is string => Boolean(i))),
  )
  let profiles: ProfileRow[] = []
  if (uploaderIds.length > 0) {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', uploaderIds)
      .returns<ProfileRow[]>()
    profiles = data ?? []
  }
  const nameById = new Map<string, string>()
  for (const p of profiles) {
    nameById.set(p.id, p.full_name?.trim() || p.email || 'User')
  }

  const subtitle = [property.unit_reference, property.address]
    .filter(Boolean)
    .join(' · ')

  const generatedAt = new Date()
  const reportId = `PA-${property.id.slice(0, 8).toUpperCase()}`

  // Capture window: earliest → latest captured/uploaded_at.
  const timestamps = photoRows
    .map((p) => p.captured_at ?? p.uploaded_at)
    .filter((t): t is string => Boolean(t))
    .map((t) => new Date(t).getTime())
  const minTs = timestamps.length > 0 ? Math.min(...timestamps) : null
  const maxTs = timestamps.length > 0 ? Math.max(...timestamps) : null

  return (
    <div className="min-h-screen bg-white text-slate-900 print:bg-white">
      <div className="print:hidden sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link
            href={`/properties/${property.id}`}
            className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 transition"
          >
            <ArrowLeft size={14} aria-hidden />
            Back to apartment
          </Link>
          <PrintButton />
        </div>
      </div>

      <article className="max-w-4xl mx-auto px-6 py-8 print:p-0 print:max-w-none">
        {/* Header bar — Red Rabbit style */}
        <header className="rounded-t-md bg-slate-900 text-white px-6 py-5 print:rounded-none print:bg-slate-900">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-white/60">
                {ctx.company.name}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight mt-0.5">
                Pre-arrival Evidence Pack
              </h1>
              <p className="text-sm text-white/80 mt-1 truncate">
                {property.name}
                {subtitle ? <span className="text-white/60"> — {subtitle}</span> : null}
              </p>
            </div>
            <div className="text-right text-xs text-white/80 shrink-0">
              <p>
                <span className="text-white/60">Generated</span>{' '}
                {formatDateOnly(generatedAt.toISOString())}
              </p>
              <p className="mt-0.5">
                <span className="text-white/60">Report ID</span> {reportId}
              </p>
            </div>
          </div>
        </header>

        {/* Summary block — what this pack contains */}
        <section className="border border-t-0 border-slate-200 print:border-slate-300">
          <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 print:bg-slate-50">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
              Pack Summary
            </h2>
          </div>
          <table className="w-full text-sm border-collapse">
            <tbody>
              <tr className="border-b border-slate-200">
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 w-1/4 bg-white">
                  Apartment
                </th>
                <td className="px-6 py-3 bg-white">{property.name}</td>
              </tr>
              {subtitle ? (
                <tr className="border-b border-slate-200">
                  <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 bg-slate-50/60">
                    Address
                  </th>
                  <td className="px-6 py-3 bg-slate-50/60">{subtitle}</td>
                </tr>
              ) : null}
              <tr className="border-b border-slate-200">
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 bg-white">
                  Photos in pack
                </th>
                <td className="px-6 py-3 bg-white">
                  <span className="font-medium">{photoRows.length}</span>{' '}
                  pre-arrival photo{photoRows.length === 1 ? '' : 's'}
                </td>
              </tr>
              {minTs && maxTs ? (
                <tr>
                  <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 bg-slate-50/60">
                    Capture window
                  </th>
                  <td className="px-6 py-3 bg-slate-50/60">
                    {formatDateTime(new Date(minTs).toISOString())}
                    {minTs !== maxTs ? (
                      <span>
                        {' '}— {formatDateTime(new Date(maxTs).toISOString())}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="px-6 py-3 text-xs text-slate-600 border-t border-slate-200 bg-slate-50/40">
            This pack is a pre-arrival evidence record. The full
            inspection report (line-item checklist, sign-off, audit
            chain) ships in a later session and will embed these same
            photos automatically.
          </p>
        </section>

        {/* EVIDENCE — Report & Run style */}
        <section className="mt-8">
          <div className="flex items-center justify-between border-b-2 border-slate-900 pb-2 mb-1">
            <h2 className="text-lg font-bold uppercase tracking-wider text-slate-900">
              Evidence
            </h2>
            <p className="text-xs text-slate-600">
              {photoRows.length} photo{photoRows.length === 1 ? '' : 's'}
            </p>
          </div>

          {photoRows.length === 0 ? (
            <div className="mt-6 border border-dashed border-slate-300 rounded-md p-8 text-center print:border-slate-400">
              <Camera size={20} className="mx-auto text-slate-400 mb-2" aria-hidden />
              <p className="text-sm text-slate-600">
                No pre-arrival photos have been captured for this apartment yet.
              </p>
              <Link
                href={`/properties/${property.id}`}
                className="mt-3 inline-flex items-center gap-1.5 text-sm text-slate-700 hover:underline print:hidden"
              >
                <ArrowLeft size={14} aria-hidden />
                Back to apartment to capture
              </Link>
            </div>
          ) : (
            <ol className="mt-4 space-y-6">
              {photoRows.map((photo, idx) => {
                const thumbUrl = photo.thumbnail_path
                  ? thumbUrls[photo.thumbnail_path]
                  : undefined
                const uploader = nameById.get(photo.uploaded_by) ?? 'Unknown'
                const capturedDisplay = photo.captured_at ?? photo.uploaded_at
                return (
                  <li
                    key={photo.id}
                    className="border border-slate-200 rounded-md overflow-hidden print:rounded-none print:break-inside-avoid"
                  >
                    <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 print:bg-slate-50">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-sm font-semibold text-slate-900">
                          Photo {idx + 1} of {photoRows.length}
                        </p>
                        <p className="text-xs text-slate-600">
                          {formatDateTime(capturedDisplay)}
                        </p>
                      </div>
                    </div>
                    <div className="bg-slate-50 print:bg-white">
                      {thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumbUrl}
                          alt={photo.notes ?? `Pre-arrival photo ${idx + 1}`}
                          loading="lazy"
                          className="block mx-auto max-h-[60vh] print:max-h-[80vh] w-auto"
                        />
                      ) : (
                        <div className="h-64 flex items-center justify-center text-sm text-slate-500">
                          Image unavailable
                        </div>
                      )}
                    </div>
                    <div className="px-5 py-3 text-sm">
                      {photo.notes ? (
                        <p className="text-slate-800 leading-relaxed whitespace-pre-wrap">
                          {photo.notes}
                        </p>
                      ) : (
                        <p className="text-slate-400 italic">No caption.</p>
                      )}
                      <p className="text-xs text-slate-500 mt-2">
                        Captured {formatDateTime(capturedDisplay)} · Uploaded by {uploader}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </section>

        <footer className="mt-10 pt-4 border-t border-slate-300 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-3 print:mt-12">
          <p className="inline-flex items-center gap-1.5">
            <FileText size={12} aria-hidden />
            Generated by STR Operations App
          </p>
          <p>
            {ctx.company.name} · {reportId} · {formatDateTime(generatedAt.toISOString())}
          </p>
        </footer>
      </article>
    </div>
  )
}
