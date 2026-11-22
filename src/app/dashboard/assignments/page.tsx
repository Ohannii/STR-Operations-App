import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { getUserContext } from '@/lib/auth/get-user-context'
import { canInspect, canCoordinateInspections } from '@/lib/inspections/workboard'
import { loadInspectionWorkspace } from '@/lib/inspections/load-workspace'
import { AssignmentManager } from './assignment-manager'

export default async function AssignmentsPage() {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')
  if (!canInspect(ctx.membership?.role_key)) redirect('/dashboard')
  const workspace = await loadInspectionWorkspace(ctx.company.id)
  return <AppShell companyName={ctx.company.name} userName={ctx.profile?.full_name ?? 'Account'} userEmail={ctx.user.email ?? ''}>
    <Link href="/dashboard/work" className="text-sm text-slate-600">← Inspection work</Link>
    <h1 className="mt-5 text-2xl font-semibold">Inspector allocations</h1>
    <p className="mt-2 mb-6 text-sm text-slate-600">Choose each apartment’s regular inspector. Every pack still records the person who actually starts and submits it.</p>
    {workspace.data ? <AssignmentManager workspace={workspace.data} manager={canCoordinateInspections(ctx.membership?.role_key)} />
      : <p role="alert" className="rounded-xl bg-amber-50 p-5 text-amber-900">{workspace.error}</p>}
  </AppShell>
}
