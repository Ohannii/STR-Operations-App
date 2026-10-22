'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { trustedAppUrl } from '@/lib/team/app-url'

/**
 * Password-reset request (PR-A rev 3).
 *
 * NEUTRAL by design: it ALWAYS redirects to the same "if an account exists"
 * confirmation, regardless of whether the email is registered or whether the
 * SDK call errored - so this endpoint never reveals which emails have accounts.
 *
 * The reset redirect origin comes ONLY from the configured application URL
 * (trustedAppUrl / NEXT_PUBLIC_SITE_URL), never from request headers, and points
 * at /auth/recover - a prefetch-safe interstitial (a scanner GET of the reset
 * email link cannot consume the recovery token).
 */
export async function requestPasswordResetAction(formData: FormData) {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()

  const neutral = () => redirect('/forgot-password?sent=1')

  // Basic shape check only; we still respond neutrally on anything invalid.
  if (email && email.includes('@')) {
    const redirectTo = trustedAppUrl('/auth/recover')
    if (redirectTo) {
      const supabase = await createClient()
      // Result intentionally ignored: success and "no such user" look identical,
      // and we must not leak either way.
      await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    }
  }

  neutral()
}
