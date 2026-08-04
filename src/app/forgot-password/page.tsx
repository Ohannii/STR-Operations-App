import Link from 'next/link'
import { AuthShell } from '@/components/auth-shell'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { requestPasswordResetAction } from './actions'

/**
 * GET /forgot-password
 *
 * Requests a password-reset email. The response is always the same neutral
 * confirmation (see actions.ts) so account existence is never revealed.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>
}) {
  const { sent } = await searchParams

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We'll email you a link to set a new password."
      footer={
        <>
          Remembered it?{' '}
          <Link href="/login" className="font-medium text-slate-900 hover:underline">
            Back to sign in
          </Link>
        </>
      }
    >
      {sent ? (
        <div className="mb-4">
          <Alert tone="success">
            If an account exists for that email, a password-reset link is on its way.
            Check your inbox (and spam).
          </Alert>
        </div>
      ) : null}

      <form action={requestPasswordResetAction} className="space-y-4">
        <Field label="Email" required htmlFor="email">
          <Input id="email" name="email" type="email" required autoComplete="email" />
        </Field>
        <Button type="submit" fullWidth>
          Send reset link
        </Button>
      </form>
    </AuthShell>
  )
}
