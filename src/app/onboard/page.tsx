import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createCompanyAction } from './actions'

/**
 * GET /onboard
 *
 * Single-field form that creates the user's company on submit.
 * Skipped (redirect to /dashboard) if the user already has a company.
 *
 * The form posts to a SECURITY DEFINER RPC, so RLS isn't blocking the
 * inserts here — see actions.ts for the rationale.
 */
export default async function OnboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (ctx.company) redirect('/dashboard')

  const { error } = await searchParams
  const displayName = ctx.profile?.full_name ?? ctx.user.email ?? 'there'

  // Show the error banner whenever the URL has an `?error=` key, even if
  // the value is empty. Previously a truthy check hid empty messages,
  // which is exactly when something silent goes wrong on the server.
  const hasError = error !== undefined

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">
          Welcome, {displayName}
        </h1>
        <p className="text-sm text-gray-600 mb-6">
          What&rsquo;s your company called? We&rsquo;ll set you up as the
          administrator. You can add team members later.
        </p>

        {hasError ? (
          <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">
            {decodeURIComponent(error ?? '') || '(no message provided — check the terminal running pnpm dev)'}
          </div>
        ) : null}

        <form action={createCompanyAction} className="space-y-4">
          <div>
            <label htmlFor="company_name" className="block text-sm font-medium text-gray-700 mb-1">
              Company name
            </label>
            <input
              id="company_name"
              name="company_name"
              type="text"
              required
              minLength={2}
              autoFocus
              placeholder="e.g. Dropinn Property Management"
              className="w-full border border-gray-300 rounded px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>
          <button
            type="submit"
            className="w-full bg-gray-900 text-white rounded px-4 py-2 font-medium hover:bg-gray-800"
          >
            Create company
          </button>
        </form>

        <p className="mt-4 text-xs text-gray-500 text-center">
          Default approval limits (R1,000 / R2,000 / R2,000-month / R60,000-year)
          will be applied. You can edit these later.
        </p>
      </div>
    </div>
  )
}
