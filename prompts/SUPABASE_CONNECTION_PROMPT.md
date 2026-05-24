# SUPABASE_CONNECTION_PROMPT.md

## When to use this prompt

Use this prompt for the session where you connect the Next.js skeleton to a new **staging** Supabase project. Run this session **before** any schema migrations, auth UI, or features. The goal is one thing: a working connection with a health check.

This prompt comes after the v1.0 Skeleton Milestone is complete and merged. It comes before `prompts/STAGED_BUILD_PROMPT.md` is used for the first build session.

---

## Pre-conditions checklist

Before opening a new session with this prompt, confirm all of these:

- [ ] The v1.0 Skeleton Milestone is merged to main (`pnpm dev` and `pnpm build` pass locally).
- [ ] You have a free Supabase account at supabase.com.
- [ ] You have NOT yet created a Supabase project for this app.
- [ ] You understand this session connects **staging only** — no production project yet.
- [ ] Your `.env.local` file does not exist yet (it is gitignored; safe to create locally).

---

## The prompt (paste this into a new Claude Code session)

```
We are connecting the STR Operations App skeleton to a new Supabase staging project.

This is a configuration-only session — no schema migrations, no auth UI, no features, no new pages. One goal: a working Supabase client with a successful health check, then pnpm build still passes.

Read before doing anything:
- CLAUDE_PROJECT_SKILLSET.md (all rules apply)
- docs/TECHNICAL_ARCHITECTURE.md (stack decisions)
- docs/PRODUCT_REQUIREMENTS.md (v1.0 naming disambiguation — staging only)
- docs/DATABASE_SCHEMA_PLAN.md (schema context — read only, no changes this session)
- docs/KNOWN_ISSUES.md (active risks)
- docs/TASK_LOG.md (current state)

What this session covers:
1. Walk me through creating a new Supabase project (staging, free tier) if I have not done it yet.
2. Add the Supabase client packages: @supabase/supabase-js and @supabase/ssr.
3. Create .env.local with the Supabase URL and anon key — staging values only. Never production secrets.
4. Create a minimal lib/supabase/ helper (browser client + server client) following the Supabase Next.js SSR guide.
5. Verify the connection: a single health-check call that confirms the client can reach Supabase without error. No real tables yet.
6. Run pnpm build. Confirm it still passes.
7. Update docs/COST_TRACKER.md with the staging project URL and service tier.

What this session does NOT cover:
- Schema migrations (separate session).
- Row Level Security policies (separate session, before any real data).
- Auth UI or login screens (separate session, after schema is in place).
- Production Supabase project (separate, after staging is fully verified and the v1.0 field test passes).
- Vercel environment variables (separate, after local connection is verified).
- Any app feature, page, or route beyond the connection helper.

Secrets rule (non-negotiable):
- Never ask me to paste the production service-role key. Ever. See docs/DEPLOYMENT_GUIDE.md.
- Never commit any .env* file. The .gitignore already covers this.
- The staging anon key is safe to use locally — it is not a production secret. Still, keep it out of git.

After each step, confirm it worked before moving to the next step. If something fails, say what failed and why before suggesting a fix.

Confirm you have read the listed docs, then tell me the first step.
```

---

## After this session

Once the connection is verified and `pnpm build` passes:

1. Record the staging Supabase project name and URL in `docs/COST_TRACKER.md`.
2. Commit the changes (Supabase client packages + `lib/supabase/` helper + updated `COST_TRACKER.md`). Do not commit `.env.local`.
3. Open a new session with `prompts/STAGED_BUILD_PROMPT.md` (stage = v1.0) and begin schema migrations on staging.
4. Do NOT create a production Supabase project until the complete v1.0 schema + RLS is verified on staging and a real apartment field test has passed.

---

## Safety reminders

**Two Supabase projects, always separate:**
- `str-ops-staging` (or similar) — for building and testing.
- `str-ops-prod` (or similar) — only after the v1.0 field test passes. See `docs/FIELD_TEST_PROTOCOL.md`.

**Service-role key bypasses RLS.** A leaked service-role key can read and write every row in every table, ignoring all company isolation. Keep it server-side only; never in client bundles; never shared with Claude. See `docs/DEPLOYMENT_GUIDE.md`.

**RLS is off on a brand-new Supabase project.** That is fine while there is no real data. Add RLS policies as part of the schema migration session, before connecting any real data.

**The anon key is public by design** — it is used in the browser and is only safe because RLS enforces company isolation. Do not treat it as a secret worth protecting, but still keep it out of git (`.env.local` is gitignored for tidiness, not security).
