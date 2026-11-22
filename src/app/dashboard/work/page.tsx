import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { getUserContext } from '@/lib/auth/get-user-context'
import { loadInspectionJobs, loadInspectionWorkspace } from '@/lib/inspections/load-workspace'
import { canCoordinateInspections, canInspect, sastDay, validId, workQueryValue } from '@/lib/inspections/workboard'
import { Workboard } from './workboard'

export default async function WorkPage({ searchParams }: { searchParams: Promise<{ scope?: string | string[]; property?: string | string[] }> }) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')
  if (!canInspect(ctx.membership?.role_key)) redirect('/dashboard')
  const manager = canCoordinateInspections(ctx.membership?.role_key)
  const raw = await searchParams
  const query = { scope: workQueryValue(raw.scope), property: workQueryValue(raw.property) }
  const all = manager && query.scope === 'all'
  const propertyId = validId(query.property) ? query.property : null
  const [workspace, jobs] = await Promise.all([
    loadInspectionWorkspace(ctx.company.id), loadInspectionJobs(ctx.company.id, all, propertyId),
  ])
  return <AppShell companyName={ctx.company.name} userName={ctx.profile?.full_name ?? 'Account'} userEmail={ctx.user.email ?? ''}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold">{propertyId ? 'Apartment inspections' : all ? 'Team inspections' : 'My inspections'}</h1><p className="mt-2 text-sm text-slate-600">Scheduled work and the packs you started or submitted.</p></div>
      <Link href="/dashboard/assignments" className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4 text-sm">Inspector allocations</Link>
    </div>
    {propertyId && <Link href="/dashboard/work" className="mt-3 inline-flex min-h-11 items-center text-sm underline">All my inspections</Link>}
    {manager && <nav aria-label="Inspection scope" className="my-5 flex gap-2">
      <Link href="/dashboard/work" aria-current={!all ? 'page' : undefined} className={`rounded-full px-4 py-3 text-sm ${!all ? 'bg-slate-900 text-white' : 'bg-white'}`}>My work</Link>
      <Link href="/dashboard/work?scope=all" aria-current={all ? 'page' : undefined} className={`rounded-full px-4 py-3 text-sm ${all ? 'bg-slate-900 text-white' : 'bg-white'}`}>All staff &amp; unassigned</Link>
    </nav>}
    <p className="my-5 rounded-xl border border-sky-100 bg-sky-50 p-4 text-sm text-sky-950">Hostaway bookings are not connected yet. Manual schedules are for tests and exceptions. Pack submission records the inspection; guest readiness and outstanding issues remain separate.</p>
    {workspace.data && jobs.data ? <Workboard workspace={workspace.data} jobs={jobs.data} manager={manager} all={all} userId={ctx.user.id} today={sastDay()} initialProperty={query.property ?? ''} />
      : <p role="alert" className="rounded-xl bg-amber-50 p-5 text-amber-900">{workspace.error ?? jobs.error}</p>}
  </AppShell>
}
