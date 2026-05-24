# COST_TRACKER.md

## Purpose

Track what the project is spending per month on infrastructure and services so there are no surprise bills.

Updated whenever a service is added, removed, or its plan tier changes. The discipline is: every line is reviewed at the end of each month.

---

## Current services

| Service | Plan | Status | Monthly cost | Notes |
|---|---|---|---|---|
| Supabase | Free | **Live — staging** | $0 | `str-ops-staging`, eu-west-2 (London). Upgrade to Pro before any production data is stored (~$25/month, PITR + daily backups). |
| Vercel | Hobby | Planned | $0 | May need Pro ($20/month) if team grows beyond 1 user. |
| GitHub | Free | **Live** | $0 | Private repo active. Free unlimited private repos. |
| Domain name | n/a | Deferred | $0 | Vercel preview URLs sufficient until v1.0 production cutover. |
| Sentry | Free | Planned | $0 | Free tier covers small projects. |
| Resend (email) | Free | Planned | $0 | Free tier: 3,000 emails/month. Used for password reset only in v1.0. |
| Cloudflare R2 | n/a | Not used | $0 | Considered for v1.5+ if Supabase egress hurts. |

**Total monthly cost: $0** (v1.0 build phase — staging only).

---

## Connected services

### Supabase — staging (live 2026-05-24)

| Detail | Value |
|---|---|
| Project name | `str-ops-staging` |
| Region | eu-west-2 — West Europe (London) |
| Plan | Free tier |
| Purpose | Staging only — schema development, v1.0 build, field tests |
| Connection verified | 2026-05-24 — health check passed (`/api/health` route, Next.js skeleton) |
| Production project | **Not created.** Created only after the v1.0 staging field test passes. Same region. |

**Cost rule — applies to all services:** No paid upgrade, plan change, billing method change, add-on, or production project without explicit founder approval. Every action that could incur cost requires a deliberate decision — never a casual click in a dashboard.

**Upgrade trigger (Supabase Free → Pro):** Before writing any real owner, guest, or financial data to the production project. PITR and 7-day backups are the reason. Staging stays on Free for the entire build phase.

---

## Expected cost progression

| Phase | Estimated monthly cost | Driver |
|---|---|---|
| ~~Pre-build~~ | ~~$0~~ | ~~Free tiers everywhere.~~ *(complete)* |
| **v1.0 build — staging (now)** | $0 | Supabase staging live. Still free tier on everything. |
| v1.0 production cutover | $25–45 | Supabase Pro + Vercel Pro if 2+ team members. |
| v1.3 in production | $40–80 | Supabase storage + bandwidth start adding $5–25. |
| v1.5+ at 1 paying customer | $60–120 | Email volume up; possible Cloudflare R2 for photo cost control. |
| 10 paying customers | $150–300 | Mostly Supabase + bandwidth. Photos scale with use. |

These are estimates. Actuals are tracked monthly when real bills arrive.

---

## Photo storage cost projection

Already in `PHOTO_RETENTION_POLICY.md`. Summary:

- ~3,800 photos/month from inspections (turnover + annual audit, estimated; was higher before turnover combined two flows into one).
- ~300KB per compressed photo = ~1.1GB/month raw.
- At Supabase storage rates (~$0.021/GB/month hot), this is under $1/month in storage even before snapshotting.
- Bandwidth is the larger cost vector when reports are opened repeatedly.
- Snapshotting routine inspections at 90 days (v1.5) reduces hot storage by roughly 60%.

These projections are based on **estimated** photo volumes. Actuals will be tracked monthly once real use begins.

---

## When to upgrade plans

Triggers:

- **Supabase Free → Pro:** before any production data exists. PITR and 7-day backups matter once real owners' records live in the database.
- **Vercel Hobby → Pro:** when a second team member needs access to the project, OR when production traffic exceeds free limits.
- **Resend Free → paid:** when transactional email volume exceeds 3000/month.
- **Cloudflare R2 migration:** only if Supabase storage cost exceeds ~$30/month sustained, AND the team has bandwidth to migrate photos.

---

## What goes into this doc

Each row when added: service name, plan, what it does, status (planned / live / deprecated), current monthly cost, notes.

Each month-end review: confirm actual bill matches the row, update if changed, flag anomalies (sudden spike, unexpected charge) in `KNOWN_ISSUES.md` if unresolved.

---

## What does NOT go into this doc

- Hourly developer time (this is a founder-built product).
- One-off setup costs (e.g., domain registration).
- Future "if we add X" speculation beyond the rough trajectory above.

Those belong in `PROJECT_BRIEF.md` or as decisions in `CHANGELOG.md`.

---

## First real review

Scheduled for the end of the month in which v1.0 is first deployed to production. Until then, the cost is $0 and the value of this document is purely "we have a place to write things down before they're a problem."
