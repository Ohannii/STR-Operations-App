import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { canManageTesting } from '@/lib/testing/test-mode'
import { loadActiveTestSession } from '@/lib/testing/load-test-mode'
import { TestingTools } from './testing-tools'

/**
 * GET /dashboard/testing — operations managers only.
 * Test mode for yourself, and which apartments are test apartments. Issues
 * from either go to the BETA Asana project and are labelled Test in the app.
 */
export default async function TestingPage() {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')
  if (!canManageTesting(ctx.membership?.role_key)) redirect('/dashboard')
  const supabase = await createClient()
  const [session, properties] = await Promise.all([
    loadActiveTestSession(supabase, ctx.company.id, ctx.user.id),
    supabase.from('properties').select('id, name, address, unit_reference, is_test')
      .eq('company_id', ctx.company.id).is('deleted_at', null).order('name')
      .returns<Array<{ id: string; name: string; address: string | null; unit_reference: string | null; is_test: boolean }>>(),
  ])
  return <AppShell companyName={ctx.company.name} userName={ctx.profile?.full_name ?? 'Account'} userEmail={ctx.user.email ?? ''}>
    <Link href="/dashboard" className="text-sm text-slate-600">← Dashboard</Link>
    <h1 className="mt-4 text-2xl font-semibold">Testing</h1>
    <p className="mt-2 max-w-2xl text-sm text-slate-600">Test issues go to the test Asana project and are labelled Test in the app. They never reach the team’s Incidents &amp; Damages board. Existing tasks are not changed.</p>
    {properties.error
      ? <p role="alert" className="mt-6 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Testing tools are not switched on yet (database update pending).</p>
      : <TestingTools session={session} properties={properties.data ?? []} />}
  </AppShell>
}
