import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { AlertCircle, ArrowLeft, FileText } from 'lucide-react'
import { PrintButton } from '@/components/photos/print-button'
import { ShareButton } from '@/components/photos/share-button'
import { getUserContext } from '@/lib/auth/get-user-context'
import {
  THUMB_TTL_SECONDS,
  signEvidencePaths,
} from '@/lib/photos/signed-urls'
import { createClient } from '@/lib/supabase/server'
import {
  getChipDisplay,
  type ChipKind,
} from '@/lib/ui/chip-vocabulary'
import { getFlagCategoryDisplay } from '@/lib/ui/flag-category'
import {
  chargeablePartyDisplay,
  flagStatusDisplay,
} from '@/lib/ui/flag-status'

/**
 * GET /properties/[id]/flags/[flagId]/report
 *
 * Print-friendly Flag Evidence Report. Designed to land cleanly
 * on a single page-flow when printed or saved as PDF from the
 * browser. Layout is a hybrid of:
 *
 *   - Red Rabbit (the first reference): bright header bar +
 *     summary tables at the top. Status / severity / responsibility
 *     surface as colour-coded cells the eye can scan in one glance.
 *
 *   - Report & Run (the inventory audit PDF): one evidence section
 *     per photo with title, date, caption, and a large image. Each
 *     evidence section page-breaks cleanly so multi-photo reports
 *     don't stitch awkwardly.
 *
 * Print-only / screen-only branches use Tailwind's print: variants
 * — there is no second template. window.print() saves as PDF on
 * every modern browser; we deliberately avoid shipping a PDF
 * library this session (size + complexity that we'd revisit if the
 * team actually hits limits with print-to-PDF).
 *
 * Auth: same flow as the detail page. RLS scopes the read.
 */

type FlagCategoryRel = { id: string; key: string } | { id: string; key: string }[] | null

type FlagReportRow = {
  id: string
  status: string
  severity: string
  description: string | null
  chargeable_party_decision: string | null
  no_action_reason: string | null
  raised_at: string
  raised_by: string
  classified_at: string | null
  actioned_at: string | null
  closed_at: string | null
  flag_category: FlagCategoryRel
}

type PhotoRow = {
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

type AuditEventRow = {
  id: string
  event_kind: string
  actor_id: string | null
  metadata: unknown
  before: unknown
  after: unknown
  created_at: string
}

function pickEmbedded<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
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

export default async function FlagReportPage({
  params,
}: {
  params: Promise<{ id: string; flagId: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { id: propertyId, flagId } = await params

  const supabase = await createClient()

  // Parallel reads scoped by RLS to the user's company.
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

  const flagPromise = supabase
    .from('flags')
    .select(
      `
      id, status, severity, description, chargeable_party_decision,
      no_action_reason, raised_at, raised_by, classified_at,
      actioned_at, closed_at,
      flag_category:flag_categories (id, key)
      `,
    )
    .eq('id', flagId)
    .eq('property_id', propertyId)
    .is('deleted_at', null)
    .maybeSingle<FlagReportRow>()

  const photosPromise = supabase
    .from('photos')
    .select(
      `id, storage_path, thumbnail_path, notes, captured_at,
       uploaded_at, uploaded_by, width, height`,
    )
    .eq('flag_id', flagId)
    .is('deleted_at', null)
    .order('captured_at', { ascending: true, nullsFirst: false })
    .order('uploaded_at', { ascending: true })
    .returns<PhotoRow[]>()

  const marksPromise = supabase
    .from('flag_operational_marks')
    .select('kind')
    .eq('flag_id', flagId)
    .is('cleared_at', null)
    .returns<{ kind: string }[]>()

  // Recent activity — last 10 events for the summary card.
  const auditPromise = supabase
    .from('audit_events')
    .select('id, event_kind, actor_id, metadata, before, after, created_at')
    .eq('entity_type', 'flag')
    .eq('entity_id', flagId)
    .order('created_at', { ascending: false })
    .limit(10)
    .returns<AuditEventRow[]>()

  const [
    { data: property },
    { data: flag },
    { data: photos },
    { data: marks },
    { data: audit },
  ] = await Promise.all([
    propertyPromise,
    flagPromise,
    photosPromise,
    marksPromise,
    auditPromise,
  ])

  if (!property || !flag) notFound()

  // Sign thumbnails only — the printed report renders the thumbs
  // (sufficient resolution at print scale), and the on-demand
  // /photos/[photoId]/view route handles masters when the user
  // clicks through. Avoids signing N master URLs per render.
  const photoRows = photos ?? []
  const thumbPaths = photoRows
    .map((p) => p.thumbnail_path)
    .filter((p): p is string => Boolean(p))
  const thumbUrls =
    thumbPaths.length > 0
      ? await signEvidencePaths(thumbPaths, THUMB_TTL_SECONDS)
      : {}

  // Resolve profile names for actors we'll mention in footers.
  const actorIds = Array.from(
    new Set<string>([
      flag.raised_by,
      ...(audit ?? []).map((a) => a.actor_id).filter((a): a is string => Boolean(a)),
      ...photoRows.map((p) => p.uploaded_by),
    ]),
  )
  let profiles: ProfileRow[] = []
  if (actorIds.length > 0) {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', actorIds)
      .returns<ProfileRow[]>()
    profiles = data ?? []
  }
  const nameById = new Map<string, string>()
  for (const p of profiles) {
    nameById.set(p.id, p.full_name?.trim() || p.email || 'User')
  }

  const categoryRow = pickEmbedded(flag.flag_category)
  const cat = categoryRow ? getFlagCategoryDisplay(categoryRow.key) : undefined
  const status = flagStatusDisplay(flag.status)
  const charge = chargeablePartyDisplay(flag.chargeable_party_decision)

  const activeChipKinds = (marks ?? []).map((m) => m.kind as ChipKind)
  const generatedAt = new Date()
  const reportId = `FR-${flag.id.slice(0, 8).toUpperCase()}`

  const subtitle = [property.unit_reference, property.address]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="min-h-screen bg-white text-slate-900 print:bg-white">
      {/* On-screen toolbar — hidden when printing. */}
      <div className="print:hidden sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
          <Link
            href={`/properties/${property.id}/flags/${flag.id}`}
            className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 transition"
          >
            <ArrowLeft size={14} aria-hidden />
            Back to flag
          </Link>
          <div className="flex items-center gap-2">
            <ShareButton
              title={`Flag Evidence Report — ${cat?.label ?? 'Flag'}`}
              text={`${property.name} · ${cat?.label ?? 'Flag'} · ${status.label}`}
            />
            <PrintButton />
          </div>
        </div>
        <p className="max-w-4xl mx-auto px-6 pb-2 -mt-1 text-xs text-slate-500">
          To send as PDF: tap <span className="font-medium">Print / Save as PDF</span> first, save
          the file, then share it via WhatsApp / email from your device. &ldquo;Share link&rdquo; sends
          a web link, useful for internal teams.
        </p>
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
                Flag Evidence Report
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

        {/* Summary block — Red Rabbit style coloured cells */}
        <section className="border border-t-0 border-slate-200 print:border-slate-300">
          <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 print:bg-slate-50">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
              Flag Summary
            </h2>
          </div>

          <table className="w-full table-fixed text-sm border-collapse">
            <tbody>
              <tr className="border-b border-slate-200">
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 w-1/4 bg-white">
                  Category
                </th>
                <td className="px-6 py-3 bg-white">{cat?.label ?? '—'}</td>
              </tr>
              <tr className="border-b border-slate-200">
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 bg-slate-50/60">
                  Severity
                </th>
                <td className="px-6 py-3 bg-slate-50/60">
                  <SeverityCell value={flag.severity} />
                </td>
              </tr>
              <tr className="border-b border-slate-200">
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 bg-white">
                  Status
                </th>
                <td className="px-6 py-3 bg-white">
                  <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded bg-slate-900 text-white">
                    {status.label}
                  </span>
                </td>
              </tr>
              <tr className="border-b border-slate-200">
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 bg-slate-50/60">
                  Responsibility
                </th>
                <td className="px-6 py-3 bg-slate-50/60">{charge.label}</td>
              </tr>
              <tr className="border-b border-slate-200">
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 bg-white">
                  Raised
                </th>
                <td className="px-6 py-3 bg-white">
                  {formatDateTime(flag.raised_at)}
                  <span className="text-slate-500">
                    {' '}— by {nameById.get(flag.raised_by) ?? 'Unknown'}
                  </span>
                </td>
              </tr>
              {flag.closed_at ? (
                <tr className="border-b border-slate-200">
                  <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 bg-slate-50/60">
                    Closed
                  </th>
                  <td className="px-6 py-3 bg-slate-50/60">
                    {formatDateTime(flag.closed_at)}
                  </td>
                </tr>
              ) : null}
              <tr>
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 bg-white align-top">
                  Description
                </th>
                <td className="px-6 py-3 bg-white whitespace-pre-wrap leading-relaxed">
                  {flag.description?.trim() || (
                    <span className="text-slate-400 italic">No description provided.</span>
                  )}
                </td>
              </tr>
              {flag.no_action_reason ? (
                <tr className="border-t border-slate-200">
                  <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider px-6 py-3 bg-slate-50/60 align-top">
                    Close reason
                  </th>
                  <td className="px-6 py-3 bg-slate-50/60 whitespace-pre-wrap">
                    {flag.no_action_reason}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        {/* Operational state — active chips as a compact table */}
        {activeChipKinds.length > 0 ? (
          <section className="mt-6 border border-slate-200 print:border-slate-300 print:break-inside-avoid">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 print:bg-slate-50">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Operational State
              </h2>
            </div>
            <div className="px-6 py-4">
              <ul className="flex flex-wrap gap-2">
                {activeChipKinds.map((kind) => {
                  const chip = getChipDisplay(kind)
                  if (!chip) return null
                  return (
                    <li
                      key={kind}
                      className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs text-slate-800"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {chip.label}
                    </li>
                  )
                })}
              </ul>
              <p className="mt-3 text-xs text-slate-500">
                These chips reflect current operational state at report
                generation. See the live flag view for any subsequent updates.
              </p>
            </div>
          </section>
        ) : null}

        {/* Recent activity — last few events */}
        {audit && audit.length > 0 ? (
          <section className="mt-6 border border-slate-200 print:border-slate-300 print:break-inside-avoid">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 print:bg-slate-50">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Activity Summary
              </h2>
            </div>
            <ul className="divide-y divide-slate-200">
              {audit.slice(0, 6).map((event) => (
                <li key={event.id} className="px-6 py-2.5 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-slate-800">
                      {humanizeEventKind(event.event_kind)}
                    </span>
                    <span className="text-xs text-slate-500 shrink-0">
                      {formatDateTime(event.created_at)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {event.actor_id
                      ? (nameById.get(event.actor_id) ?? 'User')
                      : 'System'}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* EVIDENCE — Report & Run style, one section per photo */}
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
              <AlertCircle size={20} className="mx-auto text-slate-400 mb-2" aria-hidden />
              <p className="text-sm text-slate-600">
                No evidence photos were attached to this flag.
              </p>
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
                          {cat?.label ?? 'Evidence'} — Photo {idx + 1} of {photoRows.length}
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
                          alt={photo.notes ?? `Evidence photo ${idx + 1}`}
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

        {/* Footer — print-only identity */}
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

function SeverityCell({ value }: { value: string }) {
  const tone =
    value === 'high'
      ? 'bg-red-100 text-red-900 border-red-300'
      : value === 'med'
        ? 'bg-amber-100 text-amber-900 border-amber-300'
        : 'bg-slate-100 text-slate-800 border-slate-300'
  const label =
    value === 'high'
      ? 'HIGH'
      : value === 'med'
        ? 'MEDIUM'
        : value === 'low'
          ? 'LOW'
          : value.toUpperCase()
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-bold rounded border ${tone}`}
    >
      {label}
    </span>
  )
}

function humanizeEventKind(kind: string): string {
  switch (kind) {
    case 'flag_update':
      return 'Flag updated'
    case 'flag_note':
      return 'Note added'
    case 'flag_reopen':
      return 'Flag reopened'
    case 'photo_upload':
      return 'Photo attached'
    case 'photo_delete':
      return 'Photo removed'
    default:
      return kind.replace(/_/g, ' ')
  }
}
