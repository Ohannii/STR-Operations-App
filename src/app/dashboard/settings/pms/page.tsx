import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { getUserContext } from '@/lib/auth/get-user-context'
import { pmsFailure, readPmsSetup } from '@/lib/pms/setup-server'
import { PmsSetupForm } from './setup-form'

export default async function PmsSetupPage() {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')
  if (ctx.membership?.role_key !== 'company_admin') redirect('/dashboard')
  let initial
  try { initial = { ok: true as const, data: await readPmsSetup(ctx.company.id) } }
  catch (error) { initial = pmsFailure<Awaited<ReturnType<typeof readPmsSetup>>>(error) }
  return <AppShell companyName={ctx.company.name} userName={ctx.profile?.full_name ?? 'Account'} userEmail={ctx.user.email ?? ''}>
    <Link href="/dashboard" className="inline-flex min-h-11 items-center text-sm text-teal-800 underline">Back to dashboard</Link>
    <h1 className="mt-3 text-2xl font-semibold">Connect your booking system</h1>
    <p className="mt-2 max-w-2xl text-base text-slate-600">Connect this company’s Hostaway account, then match each physical apartment to its existing record. Booking changes will stay in Hostaway.</p>
    <PmsSetupForm initial={initial} />
  </AppShell>
}
