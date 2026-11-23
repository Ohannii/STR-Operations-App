import { FlaskConical } from 'lucide-react'
import { getUserContext } from '@/lib/auth/get-user-context'
import { createClient } from '@/lib/supabase/server'
import { loadActiveTestSession } from '@/lib/testing/load-test-mode'
import { canManageTesting, testSessionEndLabel } from '@/lib/testing/test-mode'
import { EndTestModeButton } from './end-test-mode-button'

/**
 * Shown on every signed-in page while the CURRENT person has test mode on.
 * Nothing renders, and nothing is read, for everyone else.
 */
export async function TestModeBanner() {
  const ctx = await getUserContext()
  // Only managers can be in test mode (enforced in SQL), so everyone else
  // skips the read entirely: no extra round trip on inspectors' pages.
  if (!ctx?.company || !canManageTesting(ctx.membership?.role_key)) return null
  const session = await loadActiveTestSession(await createClient(), ctx.company.id, ctx.user.id)
  if (!session) return null
  return <div role="status" className="border-b border-amber-300 bg-amber-100">
    <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6">
      <p className="flex items-center gap-2 text-sm font-medium text-amber-950">
        <FlaskConical size={16} aria-hidden className="shrink-0" />
        <span>
          Test mode on <strong>{session.propertyName}</strong> until {testSessionEndLabel(session.endsAt)}.
          {' '}Issues you report there go to the test Asana project. Issues on other apartments go to the team as normal.
        </span>
      </p>
      <EndTestModeButton />
    </div>
  </div>
}
