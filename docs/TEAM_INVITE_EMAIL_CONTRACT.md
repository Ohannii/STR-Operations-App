# Team Invite Email — SSR Acceptance Contract

**Status:** deployment prerequisite for PR-A team invitations. Do **not** rely on
the hosted Supabase invite template already being correct — it must be set
explicitly to match the source-controlled local template.

## Why this exists

The auto-invite email is the only step in the invitation flow that lives
partly outside source control (the hosted Supabase email template). If that
template routes the recipient through the default implicit-flow
`{{ .ConfirmationURL }}`, the app's server-side set-password flow
(`/auth/confirm` → `verifyOtp({ type: 'invite', token_hash })`) may not run and
acceptance silently breaks. This document pins the exact hosted configuration
so the SSR flow is guaranteed.

Reference: https://supabase.com/docs/guides/auth/auth-email-templates

## Code side (already implemented)

- `inviteUserByEmail(email, { redirectTo })` is called with `redirectTo`
  derived **only** from `trustedAppUrl('/auth/confirm')`
  (`src/lib/team/app-url.ts`), which reads `NEXT_PUBLIC_SITE_URL`. It is never
  derived from `request.url`, `Host`, or `x-forwarded-*` headers.
- If `NEXT_PUBLIC_SITE_URL` is missing or invalid, the action fails closed with
  code `site_url_missing`: the invitation is saved and marked failed, no email
  is sent, and the admin is told to use **Share link** or fix the config.
- The share-link path (`resendInvitation`) already builds
  `/auth/confirm?token_hash=…&type=invite` via the same trusted origin.

## Local side (source-controlled)

- `supabase/config.toml` → `[auth.email.template.invite]` points at
  `./supabase/templates/invite.html`.
- `supabase/templates/invite.html` links to:
  `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite`

  Use `{{ .RedirectTo }}` (the per-call `redirectTo` supplied by the action),
  **not** `{{ .SiteURL }}` (ignores the per-call redirect) and **not**
  `{{ .ConfirmationURL }}` (implicit flow). Because `redirectTo` already ends in
  `/auth/confirm`, the template appends only the query string — never a second
  `/auth/confirm`.
  Reference: https://supabase.com/docs/guides/auth/redirect-urls#email-templates-when-using-redirectto

## Hosted Supabase configuration required BEFORE enabling auto-invite in an environment

Apply in the Supabase dashboard for **each** environment (staging, then
production):

1. **Authentication → URL Configuration**
   - **Site URL**: exactly the environment's app origin, e.g.
     `https://staging.drop-inn.example` (staging) /
     `https://app.drop-inn.example` (production). No trailing slash.
   - **Redirect URLs (allow-list)**: add the exact confirm URL:
     `https://<env-origin>/auth/confirm`
     (Add both bare origin and the `/auth/confirm` path if the project requires
     exact-match entries.)

2. **Authentication → Email Templates → "Invite user"**
   - **Subject**: `You've been invited to Drop-Inn`
   - **Message body**: identical to `supabase/templates/invite.html`, i.e. the
     action link MUST be:
     ```html
     <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite">
       Accept the invitation and set your password
     </a>
     ```
   - Use `{{ .RedirectTo }}` — do **not** use `{{ .SiteURL }}` or
     `{{ .ConfirmationURL }}`, and do **not** append a second `/auth/confirm`
     (it is already in the per-call `redirectTo`).

3. **Environment variable**
   - `NEXT_PUBLIC_SITE_URL` on the deployment (Vercel) must equal the Site URL
     above. If unset, invite emails are intentionally blocked
     (`site_url_missing`) and only Share-link invitations work.

## Verification after configuring

- Send a real invite to a fresh address; confirm the email link points at
  `/auth/confirm?token_hash=…&type=invite`.
- Following the link lands on the set-password page and creates the membership.
- With `NEXT_PUBLIC_SITE_URL` unset, an invite returns `site_url_missing` and
  sends no email (fail-closed check).
