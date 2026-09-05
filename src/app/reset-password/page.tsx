import { redirect } from 'next/navigation'
import { AuthShell } from '@/components/auth-shell'
import { Alert } from '@/components/ui/alert'
import { SubmitButton } from '@/components/ui/submit-button'
import { Field, Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/server'
import { setRecoveryPasswordAction } from './actions'

/**
 * /reset-password - reached only with an active recovery session (from
 * POST /auth/recover). The user sets a new password; the name is optional
 * (blank keeps the existing one). No invitation is claimed here.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { error } = await searchParams

  return (
    <AuthShell
      title="Set a new password"
      subtitle="Choose a new password for your Drop-Inn account."
    >
      {error ? (
        <div className="mb-4">
          <Alert tone="error">{decodeURIComponent(error)}</Alert>
        </div>
      ) : null}

      <form action={setRecoveryPasswordAction} className="space-y-4">
        <Field label="Your name (optional)" htmlFor="full_name">
          <Input
            id="full_name"
            name="full_name"
            type="text"
            autoComplete="name"
            maxLength={120}
            placeholder="Leave blank to keep your current name"
          />
        </Field>
        <Field label="New password" required htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
          />
        </Field>
        <Field label="Confirm password" required htmlFor="confirm">
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
          />
        </Field>
        <SubmitButton fullWidth pendingLabel="Saving…">
          Save password and continue
        </SubmitButton>
      </form>
    </AuthShell>
  )
}
