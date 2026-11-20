import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { PropertyForm } from '@/components/properties/property-form'
import { getUserContext } from '@/lib/auth/get-user-context'
import { canManageProperties } from '@/lib/properties/property-management'
import { createClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/photos/finalize-helpers'
import { updatePropertyAction } from './actions'

export default async function EditPropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')
  if (!canManageProperties(ctx.membership?.role_key)) redirect('/dashboard')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const supabase = await createClient()
  const { data: property, error } = await supabase.from('properties')
    .select('id, name, address, unit_reference, bedrooms, notes, updated_at')
    .eq('id', id).eq('company_id', ctx.company.id).is('deleted_at', null).maybeSingle()
  if (error) throw new Error('Could not load property details. Please try again.')
  if (!property) notFound()
  const save = updatePropertyAction.bind(null, id, property.updated_at)
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        <Link href={`/properties/${id}`} className="mb-6 inline-flex items-center gap-1.5 text-sm text-slate-600">
          <ArrowLeft size={14} aria-hidden /> Back to apartment
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Edit property</h1>
        <p className="mb-6 mt-1 text-sm text-slate-600">{property.name}</p>
        <Card><div className="p-5 sm:p-7"><PropertyForm action={save} initial={property} cancelHref={`/properties/${id}`} editing /></div></Card>
      </div>
    </main>
  )
}
