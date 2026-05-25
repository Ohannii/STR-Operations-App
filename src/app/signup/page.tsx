import Link from 'next/link'
import { signupAction } from './actions'

/**
 * GET /signup
 *
 * Email + password + full name. handle_new_user() trigger reads
 * full_name from raw_user_meta_data to populate profiles.full_name.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">Create account</h1>
        <p className="text-sm text-gray-600 mb-6">STR Operations</p>

        {error ? (
          <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">
            {decodeURIComponent(error)}
          </div>
        ) : null}

        <form action={signupAction} className="space-y-4">
          <div>
            <label htmlFor="full_name" className="block text-sm font-medium text-gray-700 mb-1">
              Full name
            </label>
            <input
              id="full_name"
              name="full_name"
              type="text"
              required
              autoComplete="name"
              className="w-full border border-gray-300 rounded px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="w-full border border-gray-300 rounded px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="new-password"
              minLength={6}
              className="w-full border border-gray-300 rounded px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <p className="mt-1 text-xs text-gray-500">At least 6 characters.</p>
          </div>
          <button
            type="submit"
            className="w-full bg-gray-900 text-white rounded px-4 py-2 font-medium hover:bg-gray-800"
          >
            Create account
          </button>
        </form>

        <p className="mt-4 text-sm text-gray-600 text-center">
          Already have an account?{' '}
          <Link href="/login" className="text-gray-900 underline">
            Log in
          </Link>
        </p>
      </div>
    </div>
  )
}
