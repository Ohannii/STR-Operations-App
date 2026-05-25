import Link from 'next/link'
import { AuthShell } from '@/components/auth-shell'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { signupAction } from './actions'

/**
 * GET /signup
 *
 * Email + password + full name. handle_new_user() trigger reads
 * full_name from raw_user_meta_data and writes it to profiles.full_name.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <AuthShell
      title="Create your account"
      subtitle="Build your operational source of truth in minutes."
      footer={
        <>
          Already registered?{' '}
          <Link href="/login" className="font-medium text-slate-900 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {error ? (
        <div className="mb-4">
          <Alert tone="error">{decodeURIComponent(error)}</Alert>
        </div>
      ) : null}

      <form action={signupAction} className="space-y-4">
        <Field label="Full name" required htmlFor="full_name">
          <Input id="full_name" name="full_name" type="text" required autoComplete="name" />
        </Field>
        <Field label="Email" required htmlFor="email">
          <Input id="email" name="email" type="email" required autoComplete="email" />
        </Field>
        <Field
          label="Password"
          required
          htmlFor="password"
          hint="At least 6 characters."
        >
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
          />
        </Field>
        <Button type="submit" fullWidth>
          Create account
        </Button>
      </form>
    </AuthShell>
  )
}
