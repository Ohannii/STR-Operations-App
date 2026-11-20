'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { canManageProperties, parsePropertyFields, type PropertyFormState } from '@/lib/properties/property-management'

export async function createPropertyAction(_state: PropertyFormState, form: FormData): Promise<PropertyFormState> {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')
  if (!canManageProperties(ctx.membership?.role_key)) return { error: 'Only property managers can add properties.' }
  const parsed = parsePropertyFields(form)
  if (!parsed.ok) return { error: parsed.error }
  const supabase = await createClient()
  const { error } = await supabase.from('properties').insert({ company_id: ctx.company.id, ...parsed.fields })
  if (error) return { error: 'Could not add the property. Your entries are kept; please try again.' }
  revalidatePath('/dashboard')
  redirect('/dashboard')
}
