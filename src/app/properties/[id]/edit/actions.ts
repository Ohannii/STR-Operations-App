'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { canManageProperties, parsePropertyFields, type PropertyFormState } from '@/lib/properties/property-management'
import { isUuid } from '@/lib/photos/finalize-helpers'

export async function updatePropertyAction(id: string, updatedAt: string, _state: PropertyFormState, form: FormData): Promise<PropertyFormState> {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')
  if (!canManageProperties(ctx.membership?.role_key)) return { error: 'Only property managers can edit properties.' }
  if (!isUuid(id) || !updatedAt || Number.isNaN(Date.parse(updatedAt))) return { error: 'Reopen the property and try again.' }
  const parsed = parsePropertyFields(form)
  if (!parsed.ok) return { error: parsed.error }
  const supabase = await createClient()
  const { data, error } = await supabase.from('properties').update(parsed.fields)
    .eq('id', id).eq('company_id', ctx.company.id).eq('updated_at', updatedAt)
    .is('deleted_at', null).select('id').maybeSingle()
  if (error) return { error: 'Could not save the property. Your entries are kept; please try again.' }
  if (!data) return { error: 'This property changed or is no longer available. Your entries are kept. Open the property in a new tab to check the latest details before trying again.' }
  revalidatePath('/dashboard')
  revalidatePath(`/properties/${id}`)
  revalidatePath(`/properties/${id}/edit`)
  redirect(`/properties/${id}?property_updated=1`)
}
