import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, Camera, Check, FileText, Trash2 } from 'lucide-react'
import { PrintButton } from '@/components/photos/print-button'
import { ShareButton } from '@/components/photos/share-button'
import { getUserContext } from '@/lib/auth/get-user-context'
import {
  THUMB_TTL_SECONDS,
  signEvidencePaths,
} from '@/lib/photos/signed-urls'
import { createClient } from '@/lib/supabase/server'
import { formatDateSAST, formatDateTimeSAST } from '@/lib/ui/datetime'
import {
  softDeleteEvidencePhoto,
  updatePhotoNote,
} from '../../../photos/actions'
import { submitEvidencePackAction } from '../../actions'

/**
 * GET /properties/[id]/packs/[packId]/report
 *
 * Pre-arrival Evidence Pack report — per-pack instance.
 *
 * Renders every photo where evidence_pack_id = packId. The pack
 * itself supplies the title, start/submitted timestamps, and
 * staff identities. This is the "shareable record per turnover"
 * the team will WhatsApp owners as proof the apartment was ready.
 *
 * Both draft and submitted packs render here — drafts show a
 * "Draft (in progress)" badge so a printed copy can't be mistaken
 * for a finalised pack.
 *
 * Layout follows the same hybrid we used for the Flag Evidence
 * Report (Red Rabbit header + Report & Run evidence sections);
 * print-friendly via window.print() and the @media print rules
 * in globals.css.
 */

type PackRow = {
  id: string
  property_id: string
  pack_type: string
  status: string
  title: string | null
  notes: string | null
  started_by: string
  started_at: string
  submitted_by: string | null
  submitted_at: string | null
}

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

// Display in Africa/Johannesburg (SAST). DB + Vercel server are UTC,
// so an un-zoned format rendered times two hours behind local.
// Centralised in @/lib/ui/datetime.
function formatDateTime(iso: string | null | undefined): string {
  return formatDateTimeSAST(iso)
}

function formatDateOnly(iso: string | null | undefined): string {
  return formatDateSAST(iso)
}

export default async function PackReportPage({
  params,
}: {
  params: Promise<{ id: string; packId: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { id: propertyId, packId } = await params

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

  const packPromise = supabase
    .from('evidence_packs')
    .select(
      `id, property_id, pack_type, status, title, notes,
       started_by, started_at, submitted_by, submitted_at`,
    )
    .eq('id', packId)
    .is('deleted_at', null)
    .maybeSingle<PackRow>()

  const photosPromise = supabase
    .from('photos')
    .select(
      `id, storage_path, thumbnail_path, notes, captured_at,
       uploaded_at, uploaded_by, width, height`,
    )
    .eq('evidence_pack_id', packId)
    .is('deleted_at', null)
    .order('captured_at', { ascending: true, nullsFirst: false })
    .order('uploaded_at', { ascending: true })
    .returns<PrePhotoRow[]>()

  const [{ data: property }, { data: pack }, { data: photos }] = await Promise.all([
    propertyPromise,
    packPromise,
    photosPromise,
  ])

  if (!property || !pack) notFound()
  if (pack.property_id !== propertyId) notFound()

  const photoRows = photos ?? []

  // Thumbs only — masters served via the on-demand view route.
  const thumbPaths = photoRows
    .map((p) => p.thumbnail_path)
    .filter((p): p is string => Boolean(p))
  const thumbUrls =
    thumbPaths.length > 0
      ? await signEvidencePaths(thumbPaths, THUMB_TTL_SECONDS)
      : {}

  const profileIds = Array.from(
    new Set<string>([
      pack.started_by,
      pack.submitted_by ?? '',
      ...photoRows.map((p) => p.uploaded_by),
    ].filter(Boolean)),
  )
  let profiles: ProfileRow[] = []
  if (profileIds.length > 0) {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', profileIds)
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
  const reportId = `PA-${pack.id.slice(0, 8).toUpperCase()}`
  const isDraft = pack.status === 'draft'
  const startedByName = nameById.get(pack.started_by) ?? 'Unknown'
  const submittedByName = pack.submitted_by
    ? (nameById.get(pack.submitted_by) ?? 'Unknown')
    : null

  const shareTitle = pack.title ?? 'Pre-arrival Evidence Pack'
  const shareText = `${property.name} — ${shareTitle}`

  return (
    <div className="min-h-screen bg-white text-slate-900 print:bg-white overflow-x-clip">
      <div className="print:hidden sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between gap-3 flex-wrap">
          <Link
            href={`/properties/${property.id}`}
            className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 transition"
          >
            <ArrowLeft size={14} aria-hidden />
            Back to apartment
          </Link>
          <div className="flex items-center gap-2 flex-wrap">
            {isDraft ? (
              <form action={submitEvidencePackAction}>
                <input type="hidden" name="property_id" value={property.id} />
                <input type="hidden" name="pack_id" value={pack.id} />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 text-white px-3.5 py-1.5 text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition"
                  title="Mark this pack as submitted. Submitted packs become an immutable record."
                >
                  <Check size={14} aria-hidden />
                  Submit pack
                </button>
              </form>
            ) : null}
            <ShareButton title={shareTitle} text={shareText} />
            <PrintButton />
          </div>
        </div>
        {/* Two-step PDF flow: print/save as PDF locally, then share
            the saved file. Sharing the PDF bytes directly from the
            web app requires a real PDF generator we deliberately
            haven't added yet (see ShareButton header comment). */}
        <p className="max-w-4xl mx-auto px-6 pb-2 -mt-1 text-xs text-slate-500">
          To send as PDF: tap <span className="font-medium">Print / Save as PDF</span> first, save the
          file, then share it via WhatsApp / email from your device. &ldquo;Share link&rdquo; sends a
          web link, useful for internal teams.
        </p>
      </div>

      <article className="max-w-4xl mx-auto px-6 py-8 print:p-0 print:max-w-none">
        <header className="rounded-t-md bg-slate-900 text-white px-6 py-5 print:rounded-none print:bg-slate-900">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-white/60">
                {ctx.company.name}
              </p>
              <div className="flex flex-wrap items-center gap-2 mt-0.5">
                <h1 className="text-2xl font-semibold tracking-tight break-normal">
                  {pack.title ?? 'Pre-arrival Evidence Pack'}
                </h1>
                {isDraft ? (
                  <span className="inline-flex shrink-0 items-center whitespace-nowrap px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded bg-amber-400 text-slate-900">
                    Draft
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-white/80 mt-1 truncate">
                {property.name}
                {subtitle ? <span className="text-white/60"> — {subtitle}</span> : null}
              </p>
            </div>
            <div className="text-left text-xs text-white/80 shrink-0 sm:text-right">
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

        {isDraft ? (
          <div className="border border-t-0 border-amber-300 bg-amber-50 px-6 py-3 print:hidden">
            <p className="text-sm text-amber-900">
              <span className="font-semibold">This pack is still a draft.</span>{' '}
              Edit captions below, remove photos that shouldn&rsquo;t be in the
              pack, then return to the apartment and tap{' '}
              <span className="font-semibold">Submit pack</span>. Submitted packs
              become an immutable record.
            </p>
          </div>
        ) : null}

        <section className="border border-t-0 border-slate-200 print:border-slate-300">
          <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 print:bg-slate-50">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
              Pack Summary
            </h2>
          </div>
          <table className="w-full table-fixed text-sm border-collapse">
            <tbody>
              <tr className="border-b border-slate-200">
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider break-normal px-6 py-3 w-2/5 sm:w-1/4 bg-white">
                  Apartment
                </th>
                <td className="px-6 py-3 bg-white">{property.name}</td>
              </tr>
              {subtitle ? (
                <tr className="border-b border-slate-200">
                  <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider break-normal px-6 py-3 bg-slate-50/60">
                    Address
                  </th>
                  <td className="px-6 py-3 bg-slate-50/60">{subtitle}</td>
                </tr>
              ) : null}
              <tr className="border-b border-slate-200">
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider break-normal px-6 py-3 bg-white">
                  Status
                </th>
                <td className="px-6 py-3 bg-white">
                  {isDraft ? (
                    <span className="inline-flex items-center px-2 py-0.5 text-xs font-bold uppercase tracking-wider rounded bg-amber-100 text-amber-900 border border-amber-300">
                      Draft (in progress)
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 text-xs font-bold uppercase tracking-wider rounded bg-emerald-100 text-emerald-900 border border-emerald-300">
                      Submitted
                    </span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-slate-200">
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider break-normal px-6 py-3 bg-slate-50/60">
                  Started
                </th>
                <td className="px-6 py-3 bg-slate-50/60">
                  {formatDateTime(pack.started_at)}
                  <span className="text-slate-500"> — by {startedByName}</span>
                </td>
              </tr>
              {pack.submitted_at ? (
                <tr className="border-b border-slate-200">
                  <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider break-normal px-6 py-3 bg-white">
                    Submitted
                  </th>
                  <td className="px-6 py-3 bg-white">
                    {formatDateTime(pack.submitted_at)}
                    <span className="text-slate-500"> — by {submittedByName}</span>
                  </td>
                </tr>
              ) : null}
              <tr>
                <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider break-normal px-6 py-3 bg-slate-50/60">
                  Photos in pack
                </th>
                <td className="px-6 py-3 bg-slate-50/60">
                  <span className="font-medium">{photoRows.length}</span>{' '}
                  photo{photoRows.length === 1 ? '' : 's'}
                </td>
              </tr>
              {pack.notes ? (
                <tr className="border-t border-slate-200">
                  <th className="text-left text-xs font-semibold text-slate-600 uppercase tracking-wider break-normal px-6 py-3 bg-white align-top">
                    Notes
                  </th>
                  <td className="px-6 py-3 bg-white whitespace-pre-wrap">
                    {pack.notes}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

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
                No photos in this pack yet.
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
                      {isDraft ? (
                        // Pack is still a draft — inline caption editor + delete.
                        // Submitted packs render the caption as static text below.
                        // The print:hidden wrapper hides the editor controls when
                        // printing so saved PDFs show the rendered caption only.
                        <div className="print:hidden">
                          <form
                            action={updatePhotoNote}
                            className="flex flex-col gap-2"
                          >
                            <input
                              type="hidden"
                              name="property_id"
                              value={propertyId}
                            />
                            <input
                              type="hidden"
                              name="photo_id"
                              value={photo.id}
                            />
                            <input
                              type="hidden"
                              name="return_to"
                              value={`/properties/${propertyId}/packs/${packId}/report`}
                            />
                            <label
                              htmlFor={`note-${photo.id}`}
                              className="text-[10px] font-semibold uppercase tracking-wider text-slate-500"
                            >
                              Caption (optional)
                            </label>
                            <textarea
                              id={`note-${photo.id}`}
                              name="note"
                              rows={2}
                              maxLength={2000}
                              defaultValue={photo.notes ?? ''}
                              placeholder="What is this photo of? — optional"
                              className="w-full px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-slate-900 resize-y"
                            />
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs text-slate-500">
                                Captured {formatDateTime(capturedDisplay)} ·
                                Uploaded by {uploader}
                              </p>
                              <button
                                type="submit"
                                className="inline-flex items-center gap-1 rounded bg-slate-900 text-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-800 active:bg-slate-950 transition"
                              >
                                Save caption
                              </button>
                            </div>
                          </form>
                        </div>
                      ) : null}
                      {/* Rendered caption — visible on both screen and
                          print for submitted packs; print-only for draft
                          packs (so the saved PDF shows the captions
                          without the editor UI). */}
                      <div className={isDraft ? 'hidden print:block' : ''}>
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

                      {/* Soft-delete control — only when draft. Once
                          submitted, the pack is an immutable record. */}
                      {isDraft ? (
                        <form
                          action={softDeleteEvidencePhoto}
                          className="mt-3 print:hidden"
                        >
                          <input
                            type="hidden"
                            name="property_id"
                            value={propertyId}
                          />
                          <input
                            type="hidden"
                            name="photo_id"
                            value={photo.id}
                          />
                          <input
                            type="hidden"
                            name="return_to"
                            value={`/properties/${propertyId}/packs/${packId}/report`}
                          />
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 transition"
                          >
                            <Trash2 size={11} aria-hidden />
                            Remove this photo from the pack
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </section>

        {/* Bottom-of-page Submit affordance for draft packs.
            Reaches the user after they've scrolled through every
            photo and added captions, so it's the natural next
            action. Hidden in print (the submit button shouldn't
            appear in the PDF). */}
        {isDraft ? (
          <div className="mt-8 rounded-md border border-emerald-300 bg-emerald-50 p-5 print:hidden">
            <h3 className="text-sm font-semibold text-emerald-900">
              Ready to submit?
            </h3>
            <p className="text-sm text-emerald-800 mt-1 leading-relaxed">
              Submitted packs move into the apartment&rsquo;s history and become
              an immutable record. After submit, a new pre-arrival pack can be
              started for the next turnover.
            </p>
            <form action={submitEvidencePackAction} className="mt-3">
              <input type="hidden" name="property_id" value={property.id} />
              <input type="hidden" name="pack_id" value={pack.id} />
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 text-white px-4 py-2 text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition"
              >
                <Check size={14} aria-hidden />
                Submit pack
              </button>
            </form>
          </div>
        ) : null}

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
