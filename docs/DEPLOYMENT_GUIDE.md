# DEPLOYMENT_GUIDE.md

## Plain-English overview

Deployment means: making the app available to real people on the internet.

For a non-technical founder, the safe deployment pattern is:

1. **Local** — only you, on your computer.
2. **Preview** — a private URL that you and a few testers can visit, with **fake** test data.
3. **Production** — the real app with **real** customer data.

We never test on production. We never deploy something untested to production. Every deployment must be reversible.

---

## Current status

**Do not deploy yet.** Nothing has been built. This document is the plan for *when we get there*, so it's familiar by the time we need it.

---

## Tools you'll use

| Tool | What it does | Cost |
|---|---|---|
| GitHub | Stores the code safely with history. | Free |
| Vercel | Runs the website on the internet. | Free for MVP scale |
| Supabase | Holds the data, login, and photos. | Free tier covers MVP; paid tier ~$25/mo when needed |
| VS Code | The editor on your computer. | Free |
| Node.js + pnpm | Runs the code locally. | Free |
| Sentry | Tells us about errors. | Free tier |

Total expected monthly cost for MVP with light real use: **$0–$25** until photo storage or users grow.

---

## The three environments

| Environment | URL pattern | Database | Who can see it | Purpose |
|---|---|---|---|---|
| Local | `http://localhost:3000` | A "dev" Supabase project | Only you | Building and testing on your laptop. |
| Preview | `https://<branch>-<project>.vercel.app` | A "staging" Supabase project | You + invited testers | Trying things safely with fake data. |
| Production | `https://app.<your-domain>` | A "production" Supabase project | Real customers | Real use. |

Each environment has its own database. Bugs in dev or staging can never touch real customer data.

**Important for this project:** the founder's own STR operation is the first customer, which means production data is the founder's real apartment data. Treat the staging/production line as sacred. Staging is for experiments; production is for the real operation. The two never mix.

---

## Required before the first deployment

We will not click "Deploy" until **all** of the following are true. This is your safety checklist.

- [ ] Code is in a GitHub repository (private).
- [ ] `.env.example` exists in the repo with every variable name. **No real keys in the repo.**
- [ ] `.env.local` is in `.gitignore`.
- [ ] Supabase staging project created.
- [ ] Supabase production project created.
- [ ] All migrations have run successfully on staging.
- [ ] RLS policies tested with at least two test users in two different companies.
- [ ] At least one inspection can be created, photos uploaded, and submitted in staging on a real iPhone.
- [ ] Offline draft test passes (airplane mode for 5 minutes, then reconnect).
- [ ] Login flows tested (sign in, password reset, invite acceptance).
- [ ] Sentry connected with separate DSNs per environment.
- [ ] `docs/CHANGELOG.md` reflects what's in the release.
- [ ] `docs/TESTING_CHECKLIST.md` has its boxes ticked for this release.
- [ ] `docs/KNOWN_ISSUES.md` has been read and contains no blocking entries.
- [ ] A rollback plan exists (the previous deploy can be re-promoted in Vercel; database changes are documented).

---

## Step-by-step: first preview deployment (when the time comes)

> Don't run these yet. They are the plan for later.

### Step 1 — Make sure your code is on GitHub

In VS Code:
- Open the project folder.
- Use the Source Control tab.
- Confirm there are no uncommitted changes.
- Confirm the latest commit is pushed to GitHub.

### Step 2 — Connect Vercel to GitHub (one-time)

- Go to vercel.com.
- Sign in with GitHub.
- Click **"Add New Project"**.
- Pick the repo.
- Framework should auto-detect as **Next.js**. If not, pick it.
- Don't change build settings.

### Step 3 — Add environment variables to Vercel (one-time)

For the **Preview** environment, add:
- `NEXT_PUBLIC_SUPABASE_URL` — from your staging Supabase project.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from your staging Supabase project.
- `SUPABASE_SERVICE_ROLE_KEY` — from your staging Supabase project (server-only).
- `SENTRY_DSN` — preview DSN.
- `APP_URL` — `https://<your-preview-branch>.vercel.app` (Vercel can also auto-fill this).

For **Production**, add the same variables but with **production** Supabase values. **Never reuse staging keys in production or vice versa.**

### Step 4 — First deploy

- Push the `main` branch (or a feature branch) to GitHub.
- Vercel automatically builds and deploys.
- Visit the URL Vercel gives you.
- Sign in with your test account.
- Walk through the app end-to-end.

### Step 5 — If something is wrong

- **Don't panic.**
- Open the **Deployments** tab in Vercel.
- Click the previous successful deployment.
- Click **"Promote to Production"** (or just keep using the preview URL; production hasn't been touched yet).
- Open a Claude session with `prompts/BUG_FIX_PROMPT.md` and report the issue.

### Step 6 — Production cutover (only when preview is rock solid)

- Confirm all checklist items above.
- Confirm at least two days of stable preview use.
- In Vercel, set production branch (usually `main`).
- Push the approved code to `main`.
- Vercel builds and deploys to the production URL.
- Open the app, log in, do a smoke test (the v1.0 acceptance criteria in `PRODUCT_REQUIREMENTS.md`).
- Update `docs/CHANGELOG.md` with the production deployment.

---

## Database migrations — the special case

Code can be rolled back with one click in Vercel. Database changes are trickier.

**Rules:**

1. Every schema change is a migration file in `supabase/migrations/`.
2. Migrations are tested on **staging first**, always.
3. **Before any production migration, take a backup.** On Supabase paid tier, point-in-time recovery is on. Trigger a manual backup (or note the current timestamp for PITR) immediately before running a production migration. Document the backup point in `CHANGELOG.md` as part of the deploy entry.
4. Migrations are applied to production **manually**, after the matching code is already deployed to production successfully.
5. A migration that drops a column or table gets its own commit and an explicit "this is one-way" note in `CHANGELOG.md`.
6. To roll back a forward-only migration, we write a **new** migration that reverses it (we don't delete history).

If you ever feel uncertain about a migration: **stop**. Open a Claude session with `prompts/PRE_DEPLOYMENT_PROMPT.md` and walk through it.

---

## Rollback playbook

| Failure | First action | Recovery |
|---|---|---|
| App is broken after deploy | In Vercel, promote the previous deployment back to production. | Fix forward in a new commit; redeploy. |
| A migration broke something | Stop using production for writes; assess. | Write a reversing migration; deploy. If data lost, restore from Supabase point-in-time backup (taken before the migration). |
| A customer can see another company's data | Take the app offline (Vercel "Disable" or maintenance page). | Find the offending query/RLS gap; fix; re-enable. Notify affected customer; write incident note in `KNOWN_ISSUES.md`. |
| Photo uploads failing | Check Supabase Storage quotas, Vercel function logs, Sentry. | Increase quota or rotate keys; redeploy. |
| Auth not working | Check Supabase Auth status; check redirect URLs in env vars. | Update env vars; redeploy. |

---

## Backups

- Supabase paid tier provides **point-in-time recovery** for ~7 days. Move to paid tier before production.
- Photos in Supabase Storage are replicated by Supabase. We do not maintain our own backup of bytes in MVP.
- Weekly: export a CSV of every table (manual or scheduled function) and store in a separate secure location. Add to `TESTING_CHECKLIST.md` once production starts.

---

## Domains and SSL

- Vercel provides SSL automatically.
- A custom domain (`app.yourcompany.com`) is configured in the Vercel **Domains** tab.
- DNS changes can take up to 24 hours; do them during a quiet period.
- **Build phase:** Vercel's preview URLs are sufficient. Custom domain not required until v1.0 is ready for production cutover.

---

## Secrets hygiene (read this twice)

- Never paste a `SUPABASE_SERVICE_ROLE_KEY` into a chat, email, or GitHub commit.
- Never store secrets in code files.
- If a key is ever exposed (in chat, in a screenshot, in a commit), **rotate it immediately** in Supabase.
- The service-role key bypasses RLS. Treat it like a master key. Exposure of the staging key is annoying. Exposure of the production key is a serious incident.

### Red flag rule: Claude will never ask for your production service-role key

**If Claude or any AI tool asks you to paste your production service-role key into a chat, the answer is no.** Always.

There is no legitimate reason for Claude to read or hold your production service-role key in conversation. Claude can help you configure where the key goes (your Vercel environment variables, your local `.env.local`), but Claude does not need to see the value to do that.

If you ever see Claude ask for the production key, stop, copy the conversation to a saved note as evidence, and report it. The same applies to passwords, Supabase database passwords, OAuth client secrets, and any token labelled "secret" or "private."

Staging keys are a softer rule — there are limited cases where Claude might need to confirm a value is set correctly — but even there, default to "don't paste." Use the description ("starts with eyJ..., 220 chars long") instead.

---

## Open items deferred

- A staging-to-production diff tool (we use Supabase CLI for now).
- Automated end-to-end tests (manual checklist for MVP).
- Blue/green deployments (Vercel preview/production is enough for MVP scale).
- Region selection (Supabase region chosen once at project creation; revisit if non-African customers report latency).

---

## When to call for help (in plain terms)

Stop and ask, never guess, in these situations:

- A migration on production shows an error.
- You see real customer data in a place you didn't expect.
- A test account can see another company's anything.
- The deploy "succeeded" but the site shows an error page.
- You're about to delete something and you're not 100% sure.
- Anything (Claude included) asks for a production secret.

For any of these, open a Claude session with `prompts/BUG_FIX_PROMPT.md` (or `PRE_DEPLOYMENT_PROMPT.md` if it's a planned change), describe what you see, and wait for guidance before clicking anything else.
