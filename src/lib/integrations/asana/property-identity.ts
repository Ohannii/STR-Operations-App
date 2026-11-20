import type { SupabaseClient } from '@supabase/supabase-js'

type PropertyParts = { name: string; address: string | null; unit_reference: string | null }
type Estate = 'ballito_life' | 'ballito_village'

function unitNumber(value: string | null, estate: Estate): string | null {
  const text = (value ?? '').trim()
  const prefixed = text.match(/^(BL|BV)\s*[-#]?\s*(\d+)$/i)
  if (prefixed) {
    if ((prefixed[1].toUpperCase() === 'BL') !== (estate === 'ballito_life')) return null
    return prefixed[2].replace(/^0+(?=\d)/, '')
  }
  const m = text.match(/^(?:(?:unit|apt|apartment)\s*#?\s*)?0*(\d+)$/i)
  if (!m) return null
  // String normalization avoids rounding long identifiers through Number().
  return m[1].replace(/^0+(?=\d)/, '')
}

/** Estate AND physical unit are required; contradictory or vague text fails closed. */
export function propertyIdentityParts(p: PropertyParts): { estate: Estate; unit: string } | null {
  const text = [p.name, p.address, p.unit_reference].join(' ').toLowerCase().replace(/[^a-z0-9]/g, '')
  const life = text.includes('ballitolife'), village = text.includes('ballitovillage')
  if (life === village) return null
  const estate: Estate = life ? 'ballito_life' : 'ballito_village'
  const reference = unitNumber(p.unit_reference, estate), name = unitNumber(p.name, estate)
  if (/^(BL|BV)\s*[-#]?\s*\d+$/i.test(p.name.trim()) && !name) return null
  if (p.unit_reference?.trim() && !reference) return null
  if (reference && name && reference !== name) return null
  const unit = reference ?? name
  return unit === null ? null : { estate, unit }
}

export type PropertyIdentityResult =
  | { kind: 'mapped'; unitOptionGid: string; unitNumber: string }
  | { kind: 'unmapped' | 'unavailable' | 'invalid' }

type IdentityRow = {
  property_id?: unknown; company_id?: unknown; estate_key?: unknown
  unit_number?: unknown; unit_option_gid?: unknown; investor_task_gid?: unknown
  properties?: unknown
}

/** The FK and fresh embedded property read keep a verified mapping scoped to its current apartment. */
export function validatePropertyIdentity(row: IdentityRow, companyId: string, propertyId: string): PropertyIdentityResult {
  const raw = row.properties
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'invalid' }
  const p = raw as Record<string, unknown>
  if (row.company_id !== companyId || row.property_id !== propertyId || p.id !== propertyId ||
      p.company_id !== companyId || p.deleted_at !== null || typeof p.name !== 'string' ||
      !(p.address === null || typeof p.address === 'string') ||
      !(p.unit_reference === null || typeof p.unit_reference === 'string')) return { kind: 'invalid' }
  const current = propertyIdentityParts({ name: p.name, address: p.address, unit_reference: p.unit_reference })
  if (!current || current.estate !== row.estate_key || current.unit !== row.unit_number ||
      typeof row.unit_option_gid !== 'string' || !/^\d+$/.test(row.unit_option_gid) ||
      typeof row.investor_task_gid !== 'string' || !/^\d+$/.test(row.investor_task_gid)) return { kind: 'invalid' }
  return { kind: 'mapped', unitOptionGid: row.unit_option_gid, unitNumber: current.unit }
}

export async function loadPropertyIdentity(supabase: SupabaseClient, companyId: string, propertyId: string): Promise<PropertyIdentityResult> {
  try {
    const { data, error } = await supabase.from('property_asana_identities')
      .select('property_id, company_id, estate_key, unit_number, unit_option_gid, investor_task_gid, properties!inner(id, company_id, name, address, unit_reference, deleted_at)')
      .eq('company_id', companyId).eq('property_id', propertyId).maybeSingle()
    if (error) return { kind: 'unavailable' }
    if (!data) return { kind: 'unmapped' }
    return validatePropertyIdentity(data as IdentityRow, companyId, propertyId)
  } catch {
    return { kind: 'unavailable' }
  }
}
