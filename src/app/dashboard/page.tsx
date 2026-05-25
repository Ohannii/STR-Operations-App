import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /dashboard
 *
 * The current company's property list. Empty-state encourages adding
 * the first property. RLS scopes the SELECT to the user's company —
 * we don't pass company_id to the query for that reason.
 *
 * This is the v1.0 dashboard SHELL. The full Apartment Action Centre
 * lands in Session 3.
 */
export default async function DashboardPage() {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const supabase = await createClient()
  const { data: properties, error } = await supabase
    .from('properties')
    .select('id, name, address, status, bedrooms')
    .is('deleted_at', null)
    .order('name', { ascending: true })

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Company</p>
            <h1 className="text-lg font-semibold text-gray-900 truncate">{ctx.company.name}</h1>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <span className="text-sm text-gray-700 hidden sm:inline">
              {ctx.profile?.full_name ?? ctx.user.email}
            </span>
            <form action="/auth/signout" method="POST">
              <button
                type="submit"
                className="text-sm text-gray-600 underline hover:text-gray-900"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Properties</h2>
          <Link
            href="/properties/new"
            className="bg-gray-900 text-white rounded px-4 py-2 text-sm font-medium hover:bg-gray-800"
          >
            + Add property
          </Link>
        </div>

        {error ? (
          <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">
            Could not load properties: {error.message}
          </div>
        ) : null}

        {!properties || properties.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-700 mb-2 font-medium">No properties yet</p>
            <p className="text-sm text-gray-600 mb-4">
              Add your first apartment to get started.
            </p>
            <Link
              href="/properties/new"
              className="inline-block bg-gray-900 text-white rounded px-4 py-2 text-sm font-medium hover:bg-gray-800"
            >
              Add your first property
            </Link>
          </div>
        ) : (
          <ul className="space-y-2">
            {properties.map((p) => (
              <li
                key={p.id}
                className="bg-white border border-gray-200 rounded-lg p-4 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 truncate">{p.name}</p>
                  {p.address ? (
                    <p className="text-sm text-gray-600 truncate">{p.address}</p>
                  ) : null}
                  {p.bedrooms != null ? (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {p.bedrooms} {p.bedrooms === 1 ? 'bedroom' : 'bedrooms'}
                    </p>
                  ) : null}
                </div>
                <span className="text-xs uppercase tracking-wide text-gray-600 bg-gray-100 px-2 py-1 rounded shrink-0">
                  {p.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
