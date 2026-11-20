export function canManageProperties(role: string | null | undefined): boolean {
  return ['company_admin', 'gm', 'ops_manager', 'maintenance_coordinator'].includes(role ?? '')
}

export type PropertyFields = {
  name: string
  address: string | null
  unit_reference: string | null
  bedrooms: number | null
  notes: string | null
}
export type PropertyFormState = { error?: string }

export function parsePropertyFields(form: FormData):
  | { ok: true; fields: PropertyFields }
  | { ok: false; error: string } {
  const name = String(form.get('name') ?? '').trim()
  const address = String(form.get('address') ?? '').trim() || null
  const unit_reference = String(form.get('unit_reference') ?? '').trim() || null
  const notes = String(form.get('notes') ?? '').trim() || null
  const rawBedrooms = String(form.get('bedrooms') ?? '').trim()
  const bedrooms = rawBedrooms ? Number(rawBedrooms) : null
  if (!name) return { ok: false, error: 'Enter a property name.' }
  if (name.length > 200) return { ok: false, error: 'Property name must be 200 characters or fewer.' }
  if ((address?.length ?? 0) > 500) return { ok: false, error: 'Address must be 500 characters or fewer.' }
  if ((unit_reference?.length ?? 0) > 100) return { ok: false, error: 'Unit reference must be 100 characters or fewer.' }
  if ((notes?.length ?? 0) > 5000) return { ok: false, error: 'Notes must be 5,000 characters or fewer.' }
  if (bedrooms !== null && (!/^\d+$/.test(rawBedrooms) || !Number.isInteger(bedrooms) || bedrooms > 50)) {
    return { ok: false, error: 'Bedrooms must be a whole number from 0 to 50.' }
  }
  return { ok: true, fields: { name, address, unit_reference, bedrooms, notes } }
}
