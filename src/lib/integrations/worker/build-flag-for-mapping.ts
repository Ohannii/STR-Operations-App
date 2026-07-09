/**
 * Pure DB-row → FlagForMapping shaper (Slice 7).
 *
 * Takes the authoritative values re-read from the database and produces
 * the mapping input. Keeping this pure makes the worker's "source of
 * truth is the DB, not the payload" guarantee unit-testable.
 */

import type { FlagForMapping } from '@/lib/integrations/asana/mapping'
import { chargeablePartyDisplay } from '@/lib/ui/flag-status'

export interface OutboxFlagRow {
  id: string
  description: string
  severity: 'low' | 'med' | 'high'
  status: string
  accountability: string | null
  raisedAtIso: string
  propertyId: string
  propertyName: string
  categoryKey: string
  categoryLabel: string
  reporterName: string | null
}

export function buildFlagForMapping(
  row: OutboxFlagRow,
  opts: { appBaseUrl: string; todayIso?: string },
): FlagForMapping {
  return {
    id: row.id,
    description: row.description,
    severity: row.severity,
    categoryKey: row.categoryKey,
    categoryLabel: row.categoryLabel,
    accountability: row.accountability,
    accountabilityLabel: chargeablePartyDisplay(row.accountability).label,
    propertyName: row.propertyName,
    propertyId: row.propertyId,
    reporterName: row.reporterName ?? 'Unknown',
    raisedAtIso: row.raisedAtIso,
    status: row.status,
    appBaseUrl: opts.appBaseUrl,
    todayIso: opts.todayIso,
  }
}
