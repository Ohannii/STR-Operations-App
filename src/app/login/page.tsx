import Link from 'next/link'
import { AuthShell } from '@/components/auth-shell'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { loginAction } from './actions'

/**
 * GET /login
 *
 * Email/password login. Errors and informational messages come back
 * via query string so this stays a pure server component.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>
}) {
  const { error, message } = await searchParams

  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back to your operations dashboard."
      footer={
        <>
          New here?{' '}
          <Link href="/signup" className="font-medium text-slate-900 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      {message ? (
        <div className="mb-4">
          <Alert tone="success">{decodeURIComponent(message)}</Alert>
        </div>
      ) : null}
      {error ? (
        <div className="mb-4">
          <Alert tone="error">{decodeURIComponent(error)}</Alert>
        </div>
      ) : null}

      <form action={loginAction} className="space-y-4">
        <Field label="Email" required htmlFor="email">
          <Input id="email" name="email" type="email" required autoComplete="email" />
        </Field>
        <Field label="Password" required htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={6}
            autoComplete="current-password"
          />
        </Field>
        <div className="text-right">
          <Link
            href="/forgot-password"
            className="text-sm font-medium text-slate-600 hover:underline"
          >
            Forgot password?
          </Link>
        </div>
        <Button type="submit" fullWidth>
          Sign in
        </Button>
      </form>
    </AuthShell>
  )
}
