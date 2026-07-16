import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer'
import type { ReactNode } from 'react'
import { formatDateSAST } from '@/lib/ui/datetime'
import type { FlagReportData } from '@/lib/reports/report-data'

// Uses @react-pdf's built-in Helvetica — no Font.register, no remote font.
const s = StyleSheet.create({
  page: { paddingTop: 32, paddingBottom: 40, paddingHorizontal: 36, fontSize: 10, color: '#0f172a', lineHeight: 1.4 },
  header: { backgroundColor: '#0f172a', color: '#ffffff', padding: 16, borderRadius: 4 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between' },
  company: { fontSize: 8, letterSpacing: 1, textTransform: 'uppercase', color: '#94a3b8' },
  title: { fontSize: 18, fontFamily: 'Helvetica-Bold', marginTop: 2 },
  propertyLine: { fontSize: 10, color: '#e2e8f0', marginTop: 3 },
  headerMeta: { fontSize: 8, color: '#cbd5e1', textAlign: 'right' },
  sectionTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', letterSpacing: 1, textTransform: 'uppercase', color: '#334155', marginTop: 18, marginBottom: 6 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', paddingVertical: 5 },
  rowLabel: { width: '28%', fontSize: 8, fontFamily: 'Helvetica-Bold', letterSpacing: 0.5, textTransform: 'uppercase', color: '#64748b' },
  rowValue: { width: '72%', fontSize: 10, color: '#0f172a' },
  badge: { alignSelf: 'flex-start', fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#ffffff', backgroundColor: '#0f172a', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3 },
  sevHigh: { backgroundColor: '#b91c1c' },
  sevMed: { backgroundColor: '#b45309' },
  sevLow: { backgroundColor: '#475569' },
  evidenceHead: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 2, borderBottomColor: '#0f172a', paddingBottom: 4, marginTop: 22, marginBottom: 8 },
  evidenceTitle: { fontSize: 13, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', letterSpacing: 1 },
  photoItem: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 3, marginBottom: 12 },
  photoHead: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#f8fafc', paddingHorizontal: 10, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  photoHeadTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold' },
  photoHeadDate: { fontSize: 8, color: '#475569' },
  photoImage: { width: '100%', maxHeight: 430, objectFit: 'contain' },
  photoMeta: { paddingHorizontal: 10, paddingVertical: 6 },
  caption: { fontSize: 9, color: '#1e293b' },
  captionMuted: { fontSize: 9, color: '#94a3b8', fontStyle: 'italic' },
  photoFoot: { fontSize: 8, color: '#64748b', marginTop: 3 },
  placeholder: { height: 120, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f1f5f9' },
  footer: { marginTop: 24, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#cbd5e1', flexDirection: 'row', justifyContent: 'space-between', fontSize: 8, color: '#64748b' },
  empty: { borderWidth: 1, borderColor: '#cbd5e1', borderStyle: 'dashed', borderRadius: 4, padding: 24, alignItems: 'center', marginTop: 6 },
})

function SeverityBadge({ value }: { value: string }) {
  const style =
    value === 'high' ? s.sevHigh : value === 'med' ? s.sevMed : s.sevLow
  const label = value === 'high' ? 'HIGH' : value === 'med' ? 'MEDIUM' : value === 'low' ? 'LOW' : value.toUpperCase()
  return <Text style={[s.badge, style]}>{label}</Text>
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <View style={s.rowValue}>{children}</View>
    </View>
  )
}

export function FlagReportDocument({ data }: { data: FlagReportData }) {
  const generated = formatDateSAST(new Date().toISOString())
  return (
    <Document title={`Flag Evidence Report ${data.reportId}`}>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <View style={s.headerRow}>
            <View>
              <Text style={s.company}>{data.companyName}</Text>
              <Text style={s.title}>Flag Evidence Report</Text>
              <Text style={s.propertyLine}>
                {data.propertyName}
                {data.propertySubtitle ? ` — ${data.propertySubtitle}` : ''}
              </Text>
            </View>
            <View>
              <Text style={s.headerMeta}>Generated {generated}</Text>
              <Text style={s.headerMeta}>Report ID {data.reportId}</Text>
            </View>
          </View>
        </View>

        <Text style={s.sectionTitle}>Flag Summary</Text>
        {data.issueTitle ? (
          <Row label="Title">
            <Text>{data.issueTitle}</Text>
          </Row>
        ) : null}
        <Row label="Category">
          <Text>{data.categoryLabel}</Text>
        </Row>
        <Row label="Severity">
          <SeverityBadge value={data.severity} />
        </Row>
        <Row label="Status">
          <Text style={s.badge}>{data.statusLabel}</Text>
        </Row>
        <Row label="Responsibility">
          <Text>{data.chargeableLabel}</Text>
        </Row>
        <Row label="Raised">
          <Text>
            {data.raisedText} — by {data.raisedByName}
          </Text>
        </Row>
        {data.closedText ? (
          <Row label="Closed">
            <Text>{data.closedText}</Text>
          </Row>
        ) : null}
        <Row label="Description">
          {data.description ? (
            <Text>{data.description}</Text>
          ) : (
            <Text style={s.captionMuted}>No description provided.</Text>
          )}
        </Row>
        {data.noActionReason ? (
          <Row label="Close reason">
            <Text>{data.noActionReason}</Text>
          </Row>
        ) : null}

        <View style={s.evidenceHead}>
          <Text style={s.evidenceTitle}>Evidence</Text>
          <Text style={{ fontSize: 8, color: '#475569' }}>
            {data.photos.length} photo{data.photos.length === 1 ? '' : 's'}
          </Text>
        </View>

        {data.photos.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.captionMuted}>No evidence photos were attached to this flag.</Text>
          </View>
        ) : (
          data.photos.map((photo, idx) => (
            <View key={photo.id} style={s.photoItem} wrap={false}>
              <View style={s.photoHead}>
                <Text style={s.photoHeadTitle}>
                  {data.categoryLabel} — Photo {idx + 1} of {data.photos.length}
                </Text>
                <Text style={s.photoHeadDate}>{photo.capturedText}</Text>
              </View>
              {photo.dataUri ? (
                // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer <Image> is a PDF primitive, not a DOM <img>; it has no `alt` prop
                <Image style={s.photoImage} src={photo.dataUri} />
              ) : (
                <View style={s.placeholder}>
                  <Text style={s.captionMuted}>Image unavailable</Text>
                </View>
              )}
              <View style={s.photoMeta}>
                {photo.caption ? (
                  <Text style={s.caption}>{photo.caption}</Text>
                ) : (
                  <Text style={s.captionMuted}>No caption.</Text>
                )}
                <Text style={s.photoFoot}>
                  Captured {photo.capturedText} · Uploaded by {photo.uploaderName}
                </Text>
              </View>
            </View>
          ))
        )}

        <View style={s.footer}>
          <Text>Generated by STR Operations App</Text>
          <Text>
            {data.companyName} · {data.reportId}
          </Text>
        </View>
      </Page>
    </Document>
  )
}

export async function renderFlagReportPdf(data: FlagReportData): Promise<Buffer> {
  return renderToBuffer(<FlagReportDocument data={data} />)
}
