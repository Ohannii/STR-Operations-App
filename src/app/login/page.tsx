import Link from 'next/link'
import { loginAction } from './actions'

/**
 * GET /login
 *
 * Email/password login. Errors and informational messages are passed
 * back via query string so this page can stay a pure server component
 * (no useFormState needed).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>
}) {
  const { error, message } = await searchParams

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h1 className="text-2xl font-semibold text-gray-900 mb-1">Log in</h1>
        <p className="text-sm text-gray-600 mb-6">STR Operations</p>

        {message ? (
          <div className="mb-4 p-3 rounded bg-green-50 border border-green-200 text-sm text-green-800">
            {decodeURIComponent(message)}
          </div>
        ) : null}
        {error ? (
          <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">
            {decodeURIComponent(error)}
          </div>
        ) : null}

        <form action={loginAction} className="space-y-4">
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
              autoComplete="current-password"
              minLength={6}
              className="w-full border border-gray-300 rounded px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>
          <button
            type="submit"
            className="w-full bg-gray-900 text-white rounded px-4 py-2 font-medium hover:bg-gray-800"
          >
            Log in
          </button>
        </form>

        <p className="mt-4 text-sm text-gray-600 text-center">
          No account?{' '}
          <Link href="/signup" className="text-gray-900 underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  )
}
