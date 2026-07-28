import { redirect } from 'next/navigation'
import { AuthShell } from '@/components/auth-shell'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { getUserContext } from '@/lib/auth/get-user-context'
import { setInvitePasswordAction } from './actions'

/**
 * /invite/set-password (PR-A rev 2). The confirmation route lands newly
 * claimed invitees here with an authenticated session; they choose their own
 * password before reaching the dashboard. Existing confirmed users who were
 * direct-added never pass through this page.
 *
 * Password minimum here is 8 characters — documented as deliberately
 * stricter than the legacy signup minimum (6), since these are field
 * accounts created for other people.
 */
export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')

  const { error } = await searchParams

  return (
    <AuthShell
      title="Set your password"
      subtitle="Choose the password you'll use to sign in to Drop-Inn."
    >
      {error ? (
        <div className="mb-4">
          <Alert tone="error">{decodeURIComponent(error)}</Alert>
        </div>
      ) : null}
      <form action={setInvitePasswordAction} className="space-y-4">
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
        <Button type="submit" fullWidth>
          Save password and continue
        </Button>
      </form>
    </AuthShell>
  )
}
