# TECHNICAL_ARCHITECTURE.md

## Plain-English overview

We are building a website that behaves like a phone app (a Progressive Web App, or PWA). The website is served from Vercel. The data and login system live in Supabase. Photos are stored in Supabase Storage. The code lives on GitHub and is edited in VS Code on the founder's computer.

Every company that uses the product is kept fully separate at the database level using a Postgres feature called **Row-Level Security (RLS)**. That means even if there's a bug in the app, the database itself refuses to show one company's data to another company's users.

The app must also work when the phone has no internet. So drafts are saved on the device first, then synced to the cloud later. Photos are also queued locally and uploaded when connectivity returns.

---

## Recommended stack — **founder-approved 2026-05-12**

| Layer                | Choice                            | Why                                                          |
| -------------------- | --------------------------------- | ------------------------------------------------------------ |
| Frontend framework   | Next.js 14+ (App Router)          | Strong PWA support, server components, large community.      |
| UI styling           | Tailwind CSS                      | Fast, consistent, mobile-first by default.                   |
| UI components        | shadcn/ui                         | Copy-paste components, no heavy dependency, accessible.      |
| Icons                | lucide-react                      | Clean, free, tree-shakeable.                                 |
| Local DB (offline)   | Dexie (IndexedDB wrapper)         | Reliable on iOS Safari, simple API.                          |
| Service worker / PWA | `@serwist/next` (or `next-pwa`)   | Manages offline caching and installability.                  |
| Auth                 | Supabase Auth                     | Email/password, magic links, RLS-aware.                      |
| Database             | Supabase Postgres                 | Full SQL, RLS, triggers, JSON support.                       |
| File storage         | Supabase Storage                  | Tied to RLS, simple signed URLs, good DX.                    |
| Server functions     | Supabase Edge Functions (Deno)    | For things that must run server-side (PDF gen later, etc.).  |
| Image processing     | Browser + Sharp (Edge Function)   | Compress on device; resize for thumbnails server-side later. |
| Deployment           | Vercel                            | Free tier generous, instant previews, GitHub integration.    |
| Source control       | GitHub                            | Standard.                                                    |
| Editor               | VS Code                           | Standard.                                                    |
| Package manager      | pnpm                              | Faster, disk-efficient.                                      |
| Type system          | TypeScript (strict)               | Prevents whole classes of bugs.                              |
| Form handling        | react-hook-form + zod             | Lightweight, validated.                                      |
| Data fetching        | TanStack Query                    | Handles caching, retries, offline-aware.                     |
| Error tracking       | Sentry (free tier)                | Catches production errors with stack traces.                 |
| Analytics (later)    | PostHog or Plausible              | Privacy-friendly.                                            |

### Stack we are NOT using in MVP

- React Native / Expo (later, only if PWA falls short)
- Cloudinary / Cloudflare R2 (later if Supabase Storage cost becomes a problem)
- Replit (only for disposable prototypes, never as production)
- Firebase (would duplicate Supabase)
- Prisma (Supabase has its own typed client; adding Prisma is unnecessary complexity for MVP)

---

## System diagram (described in words)

```
Phone / Browser  ─►  Next.js app (Vercel)  ─►  Supabase (Postgres + Auth + Storage)
       ▲                                                  ▲
       └── IndexedDB (Dexie) ── local drafts ─── sync ────┘
       └── Service Worker  ── offline cache, queued uploads
```

The Next.js app is the **only** thing the user's browser talks to directly (apart from Supabase Storage signed URLs for photos). All sensitive logic runs server-side in Next.js Route Handlers or in Supabase Edge Functions.

---

## Architecture principles

1. **Multi-tenant from day one.** `company_id` on every business table, RLS enforced.
2. **Least privilege.** Service-role key never reaches the browser.
3. **Offline-first.** Drafts and photo queues live in IndexedDB before they ever touch the network.
4. **Explicit sync state.** The user always sees whether something is saved locally only, syncing, or fully synced.
5. **Photo metadata is separate from photo bytes.** Postgres holds the metadata; Supabase Storage holds the bytes.
6. **Audit everything that matters.** Any change to status, accountability, or chargeable flags writes to `audit_events`.
7. **No business logic in the UI alone.** Database constraints + server checks enforce the rules.
8. **Reversible deployments.** Every release can be rolled back via Vercel + Supabase migration history.
9. **Adapter pattern for integrations.** No third-party SDKs touching core tables; we go through an adapter layer.
10. **Beginner-safe operations.** Migrations are scripted, env vars are documented, every action has a documented rollback.

---

## Folder structure (planned)

```
strop-app/                  # the application repo (not yet created)
├── app/                    # Next.js App Router routes
│   ├── (auth)/             # login, signup, reset
│   ├── (app)/              # logged-in app shell
│   │   ├── inspections/
│   │   ├── properties/
│   │   ├── issues/
│   │   ├── maintenance/
│   │   ├── reports/
│   │   └── settings/
│   └── api/                # Route Handlers (server-only)
├── components/             # shared UI
├── lib/
│   ├── supabase/           # server + browser clients
│   ├── db/                 # Dexie schema
│   ├── sync/               # offline sync engine
│   ├── permissions/        # role-check helpers
│   └── audit/              # audit-write helpers
├── public/                 # static assets, manifest.json, icons
├── supabase/
│   ├── migrations/         # SQL migrations
│   ├── policies/           # RLS policies (also in migrations)
│   └── functions/          # Edge Functions
└── docs/                   # planning docs (this folder)
```

---

## Environment variables (planned)

| Name                              | Where used     | Notes                                          |
| --------------------------------- | -------------- | ---------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`        | Browser + server | Safe to expose.                              |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`   | Browser + server | Safe to expose; protected by RLS.            |
| `SUPABASE_SERVICE_ROLE_KEY`       | Server only    | **Never** in client code. Vercel server envs. |
| `SUPABASE_JWT_SECRET`             | Server only    | For verifying tokens server-side if needed.   |
| `SENTRY_DSN`                      | Server + client | Different DSNs per environment.              |
| `APP_URL`                         | Server         | For absolute URLs in emails/reports.          |

A `.env.example` file will be checked into git. Real `.env.local` is gitignored.

---

## Deployment topology

| Environment | Where it runs                | Database                            | Purpose                                |
| ----------- | ---------------------------- | ----------------------------------- | -------------------------------------- |
| Local       | Founder's laptop             | Supabase local OR a "dev" project   | Day-to-day development.                |
| Preview     | Vercel preview per PR/branch | Supabase "staging" project          | Test changes safely before production. |
| Production  | Vercel production            | Supabase "production" project       | Real customers.                        |

We never test on production. Production migrations only run after they've succeeded on staging.

Note on first-customer profile: because the founder's own STR operation is the first customer, the founder must be especially disciplined about the staging/production boundary. Staging is for development; production is for the live operation. The two environments use different Supabase projects and different photo storage buckets so there is no risk of accidental crossover.

---

## Open decisions — resolved (founder-approved 2026-05-12)

| Question                                       | Decision                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| PWA or native?                                 | **PWA for MVP.** Reassess after 6 months of real use.                                                                                  |
| Supabase or roll our own backend?              | **Supabase.** Cuts months of work; RLS gives strong tenant isolation; cost is predictable.                                            |
| One Supabase project per company?              | **No — one project, one shared database**, with `company_id` on every row and RLS enforcing isolation. Cheaper, simpler, scales fine. |
| Photo storage — Supabase or Cloudflare R2?     | **Supabase Storage for MVP.** Migrate to R2 only if cost becomes painful (>~$200/month storage).                                       |
| Where does image compression happen?           | **Client-side before upload** (long edge ≤ 2000px, JPEG ~80% quality). Server-side thumbnail generation in an Edge Function.          |
| Dexie or raw IndexedDB?                        | **Dexie.** Simpler, well-maintained, ~24KB.                                                                                            |
| TanStack Query or SWR?                         | **TanStack Query.** Better offline story, mutation queueing.                                                                          |
| App Router or Pages Router?                    | **App Router.** Modern, server components, future-proof.                                                                              |
| Realtime updates needed in MVP?                | **No.** Polling on dashboards is fine; Supabase Realtime can be added later.                                                          |
| Push notifications in MVP?                     | **No.** iOS web push is limited and adds complexity. Email + in-app banner for v1.                                                    |
| Background sync on iOS?                        | **Not reliable on iOS Safari.** We don't promise it. Sync happens when the user opens the app; UI must make this obvious.             |
| What about full-text search?                   | Use Postgres `tsvector` later. Not needed for v1.                                                                                     |
| Monorepo or single repo?                       | **Single repo.** A monorepo can come if a marketing site or native app is added later.                                                |
| Currency for MVP?                              | **ZAR (single currency).** Multi-currency is post-MVP.                                                                                |
| Custom domain in build phase?                  | **No.** Vercel's preview URLs are sufficient until v1.0 is ready for production cutover.                                              |
| PDF reports in v1?                             | **No.** HTML reports must be print-quality. Native PDF arrives in v1.5.                                                               |

---

## Security model (high level)

- **Authentication** is handled by Supabase Auth (email/password, magic link as backup).
- **Authorisation** is enforced by **Row-Level Security policies** on every table. A user can only `SELECT`, `INSERT`, `UPDATE`, `DELETE` rows where `company_id` matches the company they belong to AND their role permits the action.
- **Service role key** is used **only** in server-side code that needs to bypass RLS (e.g., creating a new company on signup, sending invitation emails, generating reports). It is never bundled into client code.
- **Photos** in Supabase Storage are stored in per-company folders. RLS policies on `storage.objects` mirror the database policies.
- **Audit log** is append-only. Even Company Admins cannot delete rows from `audit_events`.
- **Soft delete** is used for all business records. Hard delete is reserved for Super Admin and is itself audited.

Detailed permission matrix lives in `USER_ROLES_AND_PERMISSIONS.md`. Detailed table-level RLS rules will be defined alongside the migration that creates each table.

---

## Performance budgets

| Surface                                | Target on a mid-range Android over 3G | Notes                              |
| -------------------------------------- | ------------------------------------- | ---------------------------------- |
| First load (home / login)              | < 3.0s                                | Aggressively code-split.           |
| Subsequent route navigation            | < 500ms                               | Prefetch + RSC.                    |
| Inspection screen interaction          | < 100ms tap response                  | No blocking syncs on tap.          |
| Photo capture → preview                | < 1.5s                                | Compress async after capture.      |
| Offline draft save                     | < 200ms                               | IndexedDB write only.              |
| Photo upload (compressed, 1 photo)     | < 5s on 4G                            | Retry with backoff.                |

---

## Observability and logging

- **Sentry** for client + server error tracking.
- **Vercel logs** for serverless function output.
- **Supabase logs** for database queries and auth events.
- **Audit events table** for business-level change history (this is product data, not infra logging).

We never log photo bytes, passwords, or signed-URL contents. Personally identifying info (PII) in logs is minimised.

---

## Things that will need a future architecture review

These are intentionally deferred. When they're ready, we will run `prompts/ARCHITECTURE_REVIEW_PROMPT.md`.

- Multi-region database (only if we sell outside ZA/UK/EU and latency hurts).
- A native mobile wrapper (only if PWA limitations bite in real use).
- Switching photo storage to Cloudflare R2 or Cloudinary (cost-driven).
- Replacing TanStack Query with something else (unlikely).
- Adding a separate analytics warehouse.
- Adding Supabase Realtime for live dashboards.
- Multi-company membership per user (one user, two companies).
