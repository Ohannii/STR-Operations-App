import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { PropertyForm } from '@/components/properties/property-form'
import { getUserContext } from '@/lib/auth/get-user-context'
import { canManageProperties } from '@/lib/properties/property-management'
import { createPropertyAction } from './actions'

export default async function NewPropertyPage() {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')
  if (!canManageProperties(ctx.membership?.role_key)) redirect('/dashboard')
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        <Link href="/dashboard" className="mb-6 inline-flex items-center gap-1.5 text-sm text-slate-600">
          <ArrowLeft size={14} aria-hidden /> Back to dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Add a property</h1>
        <p className="mb-6 mt-1 text-sm text-slate-600">Enter the apartment details for your team.</p>
        <Card><div className="p-5 sm:p-7"><PropertyForm action={createPropertyAction} cancelHref="/dashboard" /></div></Card>
      </div>
    </main>
  )
}
