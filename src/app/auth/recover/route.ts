import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { trustedAppUrl } from '@/lib/team/app-url'

/**
 * SSR password-recovery confirmation (PR-A rev 3 - prefetch-safe).
 *
 * Mirrors /auth/confirm. A Supabase reset email is ALSO a GET one-time link,
 * so email scanners (work-mail SafeLinks) would consume the recovery token on
 * prefetch. Same fix:
 *  - GET renders a GET-inert interstitial (no verifyOtp, no updateUser);
 *  - only an explicit human POST verifies the token (type=recovery) and
 *    establishes the recovery session, then sends the user to /reset-password.
 *
 * Redirect origins come only from the configured application URL.
 */

function redirectTo(path: string) {
  const url = trustedAppUrl(path)
  if (!url) {
    return new NextResponse('Server misconfiguration: site URL not set.', { status: 500 })
  }
  return NextResponse.redirect(url)
}

const failLogin = (message: string) =>
  redirectTo(`/login?error=${encodeURIComponent(message)}`)

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** GET - prefetch-safe interstitial. Consumes NOTHING. */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash') ?? ''
  const type = searchParams.get('type') ?? ''

  if (!tokenHash || type !== 'recovery') {
    return failLogin('Invalid or expired password-reset link.')
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Reset your password</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  main{max-width:420px;padding:32px;text-align:center}
  h1{font-size:20px;margin:0 0 8px}
  p{color:#9ca3af;margin:0 0 24px;line-height:1.5}
  button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:15px;cursor:pointer;width:100%}
</style>
</head>
<body>
<main>
  <h1>Reset your Drop-Inn password</h1>
  <p>Click continue to set a new password. This confirms it&#39;s really you and not an automated email scanner.</p>
  <form method="POST" action="/auth/recover">
    <input type="hidden" name="token_hash" value="${escapeHtml(tokenHash)}" />
    <input type="hidden" name="type" value="recovery" />
    <button type="submit">Continue</button>
  </form>
</main>
</body>
</html>`

  return new NextResponse(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** POST - explicit human action. Verify (recovery session only), then setup. */
export async function POST(request: NextRequest) {
  const form = await request.formData()
  const tokenHash = String(form.get('token_hash') ?? '')
  const type = String(form.get('type') ?? '')

  if (!tokenHash || type !== 'recovery') {
    return failLogin('Invalid or expired password-reset link.')
  }

  const supabase = await createClient()
  const { error: otpError } = await supabase.auth.verifyOtp({
    type: 'recovery',
    token_hash: tokenHash,
  })
  if (otpError) {
    return failLogin('This password-reset link is invalid or has expired. Please request another.')
  }

  return redirectTo('/reset-password')
}
