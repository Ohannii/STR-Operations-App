import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { trustedAppUrl } from '@/lib/team/app-url'

/**
 * SSR invite confirmation (PR-A rev 2).
 *
 * Security properties (review-driven):
 *  - EVERY redirect origin comes from the CONFIGURED application URL
 *    (trustedAppUrl / NEXT_PUBLIC_SITE_URL) — request.url, Host and
 *    forwarded-host are never consulted for origins;
 *  - token_hash + type=invite are verified via verifyOtp (session cookies
 *    set server-side);
 *  - claim_pending_invitation's DATA AND ERROR are both inspected; only
 *    'claimed' / 'already_member' proceed — no_invitation, expired,
 *    revoked, conflict and RPC errors all FAIL CLOSED to /login;
 *  - there is NO `next` parameter at all: destinations are fixed
 *    ('claimed' -> password setup; 'already_member' -> dashboard), which is
 *    strictly stronger than validating arbitrary next values.
 */
export async function GET(request: NextRequest) {
  const to = (path: string) => {
    const url = trustedAppUrl(path)
    if (!url) {
      // Misconfigured NEXT_PUBLIC_SITE_URL: refuse rather than guess.
      return new NextResponse('Server misconfiguration: site URL not set.', { status: 500 })
    }
    return NextResponse.redirect(url)
  }
  const fail = (message: string) => to(`/login?error=${encodeURIComponent(message)}`)

  const { searchParams } = new URL(request.url) // used ONLY to read params
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type')

  if (!tokenHash || type !== 'invite') {
    return fail('Invalid or expired invitation link.')
  }

  const supabase = await createClient()
  const { error: otpError } = await supabase.auth.verifyOtp({
    type: 'invite',
    token_hash: tokenHash,
  })
  if (otpError) {
    return fail('This invitation link is invalid or has expired. Ask your admin to resend it.')
  }

  const { data: claim, error: claimError } = await supabase.rpc('claim_pending_invitation')
  if (claimError) {
    return fail('Your invitation could not be completed. Ask your admin to retry it.')
  }
  switch (claim) {
    case 'claimed':
      // Brand-new account: set a password before anything else.
      return to('/invite/set-password')
    case 'already_member':
      return to('/dashboard')
    case 'expired':
      return fail('This invitation has expired. Ask your admin to renew it.')
    case 'revoked':
      return fail('This invitation was revoked.')
    case 'conflict':
      return fail(
        'This account is already active in another company. Ask your admin about a transfer.',
      )
    default: // 'no_invitation' and anything unexpected
      return fail('No matching invitation was found for this account.')
  }
}
