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
    <h1 className="mb-3 text-2xl font-semibold">{propertyId ? 'Apartment inspections' : all ? 'Team inspections' : 'My inspections'}</h1>
    {propertyId && <Link href="/dashboard/work" className="mt-3 inline-flex min-h-11 items-center text-sm underline">All my inspections</Link>}
    {manager && <nav aria-label="Inspection scope" className="mb-3 flex gap-2">
      <Link href="/dashboard/work" aria-current={!all ? 'page' : undefined} className={`rounded-full px-4 py-3 text-sm ${!all ? 'bg-teal-700 text-white' : 'bg-white'}`}>My work</Link>
      <Link href="/dashboard/work?scope=all" aria-current={all ? 'page' : undefined} className={`rounded-full px-4 py-3 text-sm ${all ? 'bg-teal-700 text-white' : 'bg-white'}`}>All staff &amp; unassigned</Link>
    </nav>}
    {workspace.data && jobs.data ? <Workboard key={`${all}:${propertyId ?? ''}`} workspace={workspace.data} jobs={jobs.data} manager={manager} all={all} userId={ctx.user.id} today={sastDay()} initialProperty={query.property ?? ''} />
      : <p role="alert" className="rounded-xl bg-amber-50 p-5 text-amber-900">{workspace.error ?? jobs.error}</p>}
  </AppShell>
}
