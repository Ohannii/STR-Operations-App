import { redirect } from 'next/navigation'
import { AuthShell } from '@/components/auth-shell'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { getUserContext } from '@/lib/auth/get-user-context'
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

      <div className="mt-6 pt-5 border-t border-slate-200">
        <p className="text-xs text-slate-500 leading-relaxed">
          You&rsquo;ll be the company admin. The South African default approval
          policy ships pre-configured (R1,000 single inventory &middot; R2,000
          single maintenance &middot; R2,000 monthly owner charges &middot;
          R60,000 annual). You can edit it any time.
        </p>
      </div>
    </AuthShell>
  )
}
