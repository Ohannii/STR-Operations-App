import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createPropertyAction } from './actions'

/**
 * GET /properties/new
 *
 * Minimal property creation form. Required: name. Optional: address,
 * unit reference, bedrooms. Status defaults to 'idle' (per the
 * properties table default in core_schema.sql).
 */
export default async function NewPropertyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (!ctx.company) redirect('/onboard')

  const { error } = await searchParams

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-6">
      <div className="max-w-xl mx-auto">
        <Link href="/dashboard" className="text-sm text-gray-600 hover:text-gray-900">
          ← Back to dashboard
        </Link>

        <div className="mt-4 bg-white border border-gray-200 rounded-lg p-6">
          <h1 className="text-xl font-semibold text-gray-900 mb-1">Add a property</h1>
          <p className="text-sm text-gray-600 mb-6">
            Adds an apartment to {ctx.company.name}.
          </p>

          {error ? (
            <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">
              {decodeURIComponent(error)}
            </div>
          ) : null}

          <form action={createPropertyAction} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                Property name <span className="text-red-600">*</span>
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                autoFocus
                placeholder="e.g. Sea Point Apt 12"
                className="w-full border border-gray-300 rounded px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>
            <div>
              <label htmlFor="address" className="block text-sm font-medium text-gray-700 mb-1">
                Address
              </label>
              <input
                id="address"
                name="address"
                type="text"
                placeholder="Street, suburb, city"
                className="w-full border border-gray-300 rounded px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="unit_reference" className="block text-sm font-medium text-gray-700 mb-1">
                  Unit reference
                </label>
                <input
                  id="unit_reference"
                  name="unit_reference"
                  type="text"
                  placeholder="Apt 12"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>
              <div>
                <label htmlFor="bedrooms" className="block text-sm font-medium text-gray-700 mb-1">
                  Bedrooms
                </label>
                <input
                  id="bedrooms"
                  name="bedrooms"
                  type="number"
                  min={0}
                  max={50}
                  step={1}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
              </div>
            </div>
            <button
              type="submit"
              className="w-full bg-gray-900 text-white rounded px-4 py-2 font-medium hover:bg-gray-800"
            >
              Add property
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
