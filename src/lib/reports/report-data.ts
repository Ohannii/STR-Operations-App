import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { EVIDENCE_BUCKET } from '@/lib/photos/paths'
import { getFlagCategoryDisplay } from '@/lib/ui/flag-category'
import { flagStatusDisplay, chargeablePartyDisplay } from '@/lib/ui/flag-status'
import { formatDateSAST, formatDateTimeSAST } from '@/lib/ui/datetime'
import type { FlagFingerprintInput, PhotoFingerprint } from '@/lib/reports/report-paths'

/**
 * Server-only report data loaders. These run under `service_role` and are
 * only invoked by the prepare routes AFTER the user session has authorized
 * access to the company/property/entity. They read source data and embed
 * the COMPRESSED MASTER photos as base64 data URIs for @react-pdf/renderer.
 */

export type ReportPhoto = {
  id: string
  dataUri: string | null
  caption: string | null
  capturedText: string
  uploaderName: string
}

export type FlagReportData = {
  companyName: string
  reportId: string
  propertyName: string
  propertySubtitle: string
  categoryLabel: string
  statusLabel: string
  severity: string
  chargeableLabel: string
  issueTitle: string | null
  description: string | null
  noActionReason: string | null
  raisedText: string
  /** Raw raised-at ISO timestamp (for the stable share filename date). */
  raisedAtIso: string
  raisedByName: string
  closedText: string | null
  photos: ReportPhoto[]
  fingerprint: FlagFingerprintInput
}

export type PackReportData = {
  companyName: string
  reportId: string
  propertyName: string
  propertySubtitle: string
  title: string
  packTypeLabel: string
  submittedText: string
  submittedByName: string
  photos: ReportPhoto[]
}

type PhotoRow = {
  id: string
  storage_path: string
  notes: string | null
  captured_at: string | null
  uploaded_at: string
  uploaded_by: string
  width: number | null
  height: number | null
}

async function downloadDataUri(
  admin: ReturnType<typeof createServiceClient>,
  storagePath: string,
): Promise<string | null> {
  const { data, error } = await admin.storage.from(EVIDENCE_BUCKET).download(storagePath)
  if (error || !data) {
    console.error('[reports/data] master download failed:', storagePath, error?.message)
    return null
  }
  const buf = Buffer.from(await data.arrayBuffer())
  return `data:image/jpeg;base64,${buf.toString('base64')}`
}

function subtitleOf(p: { unit_reference: string | null; address: string | null }): string {
  return [p.unit_reference, p.address].filter(Boolean).join(' · ')
}

async function resolveNames(
  admin: ReturnType<typeof createServiceClient>,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (unique.length === 0) return map
  const { data } = await admin
    .from('profiles')
    .select('id, full_name, email')
    .in('id', unique)
    .returns<{ id: string; full_name: string | null; email: string | null }[]>()
  for (const p of data ?? []) {
    map.set(p.id, p.full_name?.trim() || p.email || 'User')
  }
  return map
}

async function buildPhotos(
  admin: ReturnType<typeof createServiceClient>,
  rows: PhotoRow[],
  nameById: Map<string, string>,
): Promise<{ photos: ReportPhoto[]; fingerprint: PhotoFingerprint[] }> {
  const photos: ReportPhoto[] = []
  const fingerprint: PhotoFingerprint[] = []
  for (const p of rows) {
    const dataUri = await downloadDataUri(admin, p.storage_path)
    const captured = p.captured_at ?? p.uploaded_at
    photos.push({
      id: p.id,
      dataUri,
      caption: p.notes?.trim() || null,
      capturedText: formatDateTimeSAST(captured),
      uploaderName: nameById.get(p.uploaded_by) ?? 'Unknown',
    })
    fingerprint.push({
      id: p.id,
      storagePath: p.storage_path,
      capturedAt: p.captured_at,
      uploadedAt: p.uploaded_at,
      notes: p.notes,
      width: p.width,
      height: p.height,
    })
  }
  return { photos, fingerprint }
}

export async function loadFlagReportData(
  companyName: string,
  flagId: string,
): Promise<FlagReportData | null> {
  const admin = createServiceClient()

  const { data: flag } = await admin
    .from('flags')
    .select(
      `id, status, severity, issue_title, description, chargeable_party_decision,
       no_action_reason, raised_at, raised_by, closed_at, property_id,
       flag_category:flag_categories (key)`,
    )
    .eq('id', flagId)
    .is('deleted_at', null)
    .maybeSingle<{
      id: string
      status: string
      severity: string
      issue_title: string | null
      description: string | null
      chargeable_party_decision: string | null
      no_action_reason: string | null
      raised_at: string
      raised_by: string
      closed_at: string | null
      property_id: string
      flag_category: { key: string } | { key: string }[] | null
    }>()
  if (!flag) return null

  const [{ data: property }, { data: photoRows }] = await Promise.all([
    admin
      .from('properties')
      .select('name, address, unit_reference')
      .eq('id', flag.property_id)
      .maybeSingle<{ name: string; address: string | null; unit_reference: string | null }>(),
    admin
      .from('photos')
      .select('id, storage_path, notes, captured_at, uploaded_at, uploaded_by, width, height')
      .eq('flag_id', flagId)
      .is('deleted_at', null)
      .order('captured_at', { ascending: true, nullsFirst: false })
      .order('uploaded_at', { ascending: true })
      .returns<PhotoRow[]>(),
  ])

  const rows = photoRows ?? []
  const nameById = await resolveNames(admin, [flag.raised_by, ...rows.map((r) => r.uploaded_by)])
  const { photos, fingerprint } = await buildPhotos(admin, rows, nameById)

  const catRel = Array.isArray(flag.flag_category) ? flag.flag_category[0] : flag.flag_category
  const categoryKey = catRel?.key ?? ''
  const category = categoryKey ? getFlagCategoryDisplay(categoryKey) : undefined

  return {
    companyName,
    reportId: `FR-${flag.id.slice(0, 8).toUpperCase()}`,
    propertyName: property?.name ?? 'Unknown property',
    propertySubtitle: property ? subtitleOf(property) : '',
    categoryLabel: category?.label ?? 'Uncategorised',
    statusLabel: flagStatusDisplay(flag.status).label,
    severity: flag.severity,
    chargeableLabel: chargeablePartyDisplay(flag.chargeable_party_decision).label,
    issueTitle: flag.issue_title?.trim() || null,
    description: flag.description?.trim() || null,
    noActionReason: flag.no_action_reason?.trim() || null,
    raisedText: formatDateTimeSAST(flag.raised_at),
    raisedAtIso: flag.raised_at,
    raisedByName: nameById.get(flag.raised_by) ?? 'Unknown',
    closedText: flag.closed_at ? formatDateTimeSAST(flag.closed_at) : null,
    photos,
    fingerprint: {
      status: flag.status,
      severity: flag.severity,
      issueTitle: flag.issue_title,
      description: flag.description,
      chargeableParty: flag.chargeable_party_decision,
      noActionReason: flag.no_action_reason,
      categoryKey,
      raisedAt: flag.raised_at,
      raisedBy: flag.raised_by,
      closedAt: flag.closed_at,
      photos: fingerprint,
    },
  }
}

const PACK_TYPE_LABEL: Record<string, string> = {
  pre_arrival: 'Pre-arrival Evidence Pack',
}

export async function loadPackReportData(
  companyName: string,
  packId: string,
): Promise<PackReportData | null> {
  const admin = createServiceClient()

  const { data: pack } = await admin
    .from('evidence_packs')
    .select('id, property_id, pack_type, status, title, submitted_by, submitted_at')
    .eq('id', packId)
    .is('deleted_at', null)
    .maybeSingle<{
      id: string
      property_id: string
      pack_type: string
      status: string
      title: string | null
      submitted_by: string | null
      submitted_at: string | null
    }>()
  if (!pack) return null

  const [{ data: property }, { data: photoRows }] = await Promise.all([
    admin
      .from('properties')
      .select('name, address, unit_reference')
      .eq('id', pack.property_id)
      .maybeSingle<{ name: string; address: string | null; unit_reference: string | null }>(),
    admin
      .from('photos')
      .select('id, storage_path, notes, captured_at, uploaded_at, uploaded_by, width, height')
      .eq('evidence_pack_id', packId)
      .is('deleted_at', null)
      .order('captured_at', { ascending: true, nullsFirst: false })
      .order('uploaded_at', { ascending: true })
      .returns<PhotoRow[]>(),
  ])

  const rows = photoRows ?? []
  const nameById = await resolveNames(admin, [
    pack.submitted_by ?? '',
    ...rows.map((r) => r.uploaded_by),
  ])
  const { photos } = await buildPhotos(admin, rows, nameById)

  const packTypeLabel = PACK_TYPE_LABEL[pack.pack_type] ?? 'Evidence Pack'
  return {
    companyName,
    reportId: `PA-${pack.id.slice(0, 8).toUpperCase()}`,
    propertyName: property?.name ?? 'Unknown property',
    propertySubtitle: property ? subtitleOf(property) : '',
    title: pack.title?.trim() || packTypeLabel,
    packTypeLabel,
    submittedText: pack.submitted_at ? formatDateSAST(pack.submitted_at) : '',
    submittedByName: pack.submitted_by ? (nameById.get(pack.submitted_by) ?? 'Unknown') : '',
    photos,
  }
}
