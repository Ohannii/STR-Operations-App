import { redirect } from 'next/navigation'
import { AuthShell } from '@/components/auth-shell'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { createCompanyAction } from './actions'

/**
 * GET /onboard
 *
 * Single-field form that creates the user's company on submit.
 * Skipped (redirect to /dashboard) if the user already has one.
 * The form posts to create_company_with_admin() — SECURITY DEFINER
 * RPC that atomically sets up the company, the admin membership,
 * and the default approval policy.
 */
export default async function OnboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const ctx = await getUserContext()
  if (!ctx) redirect('/login')
  if (ctx.company) redirect('/dashboard')

  // A normal sign-in/reset can land an invitee here without the invite URL.
  // Route them back to setup BEFORE showing a company form. This read-only
  // check grants no membership; activation remains in the setup action.
  const supabase = await createClient()
  const { data: invitation, error: invitationError } = await supabase.rpc('get_my_invitation_setup_status')
  if (!invitationError && invitation === 'pending') redirect('/invite/set-password')
  if (invitationError || invitation !== 'none') {
    const message = invitationError || !['expired', 'revoked', 'accepted'].includes(invitation)
      ? 'We could not check your team invitation. Please refresh this page and try again.'
      : invitation === 'expired'
        ? 'Your team invitation has expired. Ask your company admin to renew it.'
        : invitation === 'revoked'
          ? 'Your team invitation is no longer active. Please contact your company admin.'
          : 'Your team access is not active. Please contact your company admin.'
    return (
      <AuthShell title="Join your team" subtitle="Finish joining your existing team to continue.">
        <Alert tone="error">{message}</Alert>
        <form action="/auth/signout" method="post" className="mt-5">
          <Button type="submit" variant="secondary" fullWidth>Sign out</Button>
        </form>
      </AuthShell>
    )
  }
  const { error } = await searchParams
  const hasError = error !== undefined
  const displayName = ctx.profile?.full_name ?? ctx.user.email ?? 'there'
  const firstName = displayName.split(' ')[0]

  return (
    <AuthShell
      title={`Welcome, ${firstName}`}
      subtitle="Set up your company to start managing properties."
    >
      {hasError ? (
        <div className="mb-4">
          <Alert tone="error">
            {decodeURIComponent(error ?? '') ||
              '(no message — check the pnpm dev terminal for diagnostic output)'}
          </Alert>
        </div>
      ) : null}

      <form action={createCompanyAction} className="space-y-4">
        <Field
          label="Company name"
          required
          htmlFor="company_name"
          hint="Shown across the app and on owner-facing reports."
        >
          <Input
            id="company_name"
            name="company_name"
            type="text"
            required
            minLength={2}
            autoFocus
            placeholder="e.g. Dropinn Property Management"
          />
        </Field>
        <Button type="submit" fullWidth>
          Create company
        </Button>
      </form>

    </AuthShell>
  )
}
