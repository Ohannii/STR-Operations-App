# Password Recovery - SSR + Prefetch-safe Contract

Companion to `docs/TEAM_INVITE_EMAIL_CONTRACT.md`. Covers the "Forgot password"
flow. Like the invite link, a Supabase **recovery** email is a GET one-time
link, so it must route through a GET-inert interstitial or an email scanner
prefetch will consume the token.

Reference: https://supabase.com/docs/guides/auth/passwords

## Flow (code)

1. `/login` -> "Forgot password?" -> `/forgot-password`.
2. `/forgot-password` action calls `resetPasswordForEmail(email, { redirectTo })`
   where `redirectTo = trustedAppUrl('/auth/recover')` (config-derived only).
   It always returns the same neutral "if an account exists" response.
3. The email links to `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`.
4. `GET /auth/recover` renders a prefetch-safe interstitial (consumes nothing).
5. `POST /auth/recover` (human click) runs `verifyOtp({ type: 'recovery' })` to
   establish the recovery session, then redirects to `/reset-password`.
6. `/reset-password` sets the new password (and optionally a real name). It does
   **not** claim any invitation. A pending-invite user then hits `/dashboard`,
   which forwards no-company users to `/onboard`, where the existing claim logic
   completes membership.

## Local (source-controlled)

- `supabase/templates/recovery.html` - the recovery email body.
- `supabase/config.toml` -> `[auth.email.template.recovery]` points at it.

## Hosted Supabase configuration required BEFORE relying on recovery

Per environment (the single `str-ops-staging` project currently serves both
Preview and Production):

1. **Authentication -> URL Configuration -> Redirect URLs (allow-list):** add the
   recover callback for every origin invites/resets are used from, using the
   exact origins from Vercel (do not hard-code an ephemeral branch alias here):
   - `https://<preview-branch-alias>.vercel.app/auth/recover`
   - `https://<production-origin>/auth/recover`
   (Keep the existing `/auth/confirm` entries. Do not change Site URL.)

2. **Authentication -> Email Templates -> "Reset Password":**
   - Subject: `Let's get you back in 🔑`
   - Body: identical to `supabase/templates/recovery.html`. The action button
     link MUST be:
     ```html
     <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">
       Choose a new password
     </a>
     ```
   - Do **not** use `{{ .ConfirmationURL }}` or `{{ .SiteURL }}`.

No environment variable changes are required beyond the `NEXT_PUBLIC_SITE_URL`
values already set for Preview and Production.

## Live verification (real Supabase - what a mock cannot prove)

1. From `/login`, use "Forgot password?" with a real inbox; confirm the neutral
   message shows regardless of whether the address exists.
2. Confirm the email link points at `/auth/recover?token_hash=...&type=recovery`.
3. Opening the link shows the interstitial; only clicking Continue proceeds
   (verify a prefetch/`curl` GET does NOT consume it - a second real click still
   works).
4. Set a password (and a name); confirm you land on the dashboard, and that a
   pending-invite account becomes an active member via onboarding.
5. Re-using the same link fails closed and prompts to request another reset.
