# PROJECT_BRIEF.md

## Vision

Build a **mobile-first, evidence-first operations system** for short-term rental (STR) property management companies.

Inspectors, cleaners, maintenance staff, managers, finance, and owners all interact with the same evidence — photos, inspections, issues, and accountability records — through one source of truth.

The product replaces scattered tools (WhatsApp, spreadsheets, manual photo folders, paper checklists, email reports) with a single auditable system that works on a phone, even when offline.

## Core problem

STR operations today rely on improvised workflows:

- Photos live in WhatsApp threads, lost within weeks.
- Inspection checklists are paper, Google Forms, or memory.
- Damage and inventory loss have no consistent evidence trail.
- Owner monthly reports are hand-built in Word or Excel.
- Maintenance tickets live in chat messages that never close.
- No clear record of *who said what, when*, with photo proof.

This creates real losses:

- Disputes with OTAs (Airbnb, Booking.com) lost for lack of evidence.
- Damages absorbed by the company because the chain of custody is missing.
- Owner trust eroded because monthly reports look improvised.
- Inspector and cleaner performance impossible to measure.
- Recurring maintenance issues never traced to root cause.

## Primary users

- Super Admin / SaaS Owner (you, across all client companies later)
- Company Admin
- General Manager (GM)
- Operations Manager
- Property Manager
- Inspector
- Cleaner / Housekeeping User
- Maintenance Coordinator
- Maintenance Technician / Contractor
- Inventory Manager
- Finance/Admin User
- Property Owner Viewer
- Read-only Auditor

## Product position

This is an **evidence-first operations system**.

It is **not**:

- A full Property Management System (PMS) replacement.
- A channel manager.
- An accounting or invoicing platform.
- An AI automation platform.

It complements existing PMS tools (Hostaway, Guesty, etc.) by handling the operational layer they handle poorly: physical evidence, inspections, accountability, and owner-facing operational reports.

## Required device support

The app must work well on:

- iPhone / iOS (Safari)
- Android (Chrome)
- Mac (any modern browser)
- Windows (any modern browser)
- Modern mobile browsers in general

The fact that the founder is on Windows does **not** limit the app to Windows. The app is web-based and platform-agnostic.

## First customer

The first paying customer is **the founder's own short-term rental management operation**.

This is a deliberate choice. It means:

- We control the test environment end-to-end.
- We learn what is actually painful in real apartments, not in interviews.
- The line between "test data" and "real data" must be drawn carefully — we never use the staging environment for live operations, and we never use the production environment for experimental features. See the test/prod boundary rules in `NON_TECHNICAL_USER_GUIDE.md`.
- After the founder's operation is running on the product daily, we pursue 2–3 friendly external customers, then open up.

## MVP success outcome

A real-world test: an inspector walking into a Durban apartment after a guest checkout should be able to:

1. Open the app on their phone (works offline).
2. Pick the property and the inspection type.
3. Walk through a guided checklist, one section at a time.
4. Take photos that automatically attach to the right line item.
5. Mark items as damaged, missing, or needing maintenance.
6. Submit the inspection.
7. See sync status confirming evidence is uploaded.
8. Have a manager view the inspection within minutes.
9. Generate an owner monthly summary at month-end from collected data — no manual compilation.
10. Produce an OTA evidence pack (photos + timeline + notes) for a damage claim.

If those 10 steps work reliably on a real iPhone in a real apartment with weak signal, the MVP has succeeded.

## Non-goals for MVP

- Full PMS replacement.
- Native iOS or Android app (PWA only for MVP).
- Invoice generation or accounting.
- Live OTA channel integrations.
- AI-driven accountability or financial decisions.
- Multi-language UI (English MVP, translation later).

## Active assumptions (locked in founder review 2026-05-12)

- **MVP delivery format:** mobile-first Progressive Web App (PWA).
- **Backend:** Supabase (Postgres, Auth, Storage, Edge Functions, Row-Level Security). **Founder-approved.**
- **Frontend:** Next.js (App Router) deployed on Vercel. **Founder-approved.**
- **Source control:** GitHub.
- **Editor:** VS Code.
- **Package manager:** pnpm.
- **Type system:** TypeScript (strict).
- **AI features:** **none in v1.** Optional and deferred to v1.5+. **Founder-confirmed.**
- **Multi-company SaaS:** designed in from day one, not retrofitted.
- **Founder profile:** non-technical, requires step-by-step beginner guidance.
- **Currency:** **ZAR (South African Rand)**, single currency per company in MVP. **Founder-confirmed.**
- **First customer:** **founder's own STR operation** (see above). **Founder-confirmed.**
- **Domain name:** **not yet acquired** — not needed until v1.0 is deploying to production. Vercel's free preview URLs are fine for build phase. **Founder-confirmed deferred.**
- **MVP reports:** **HTML only**, must render clean, professional, printable, structured. PDF deferred to v1.5. **Founder-confirmed.**
- **Build pace:** v1 ships in 4 staged sub-releases (v1.0 → v1.3) rather than one push. See `PRODUCT_REQUIREMENTS.md`.

## Constraints to respect

- **Cost:** Photo storage and AI inference are the two big cost vectors. Both must be controlled.
- **Connectivity:** Inspectors work in apartments where Wi-Fi may be off and cellular may be weak. Offline-first is mandatory.
- **iOS Safari limits:** PWAs on iPhone have real restrictions (background sync, push notifications, storage quotas). The app design must respect these.
- **Trust:** Owner-chargeable and guest-chargeable decisions must always have a human approver. No AI blame.

## What "good" looks like in 12 months

- The founder's own STR operation runs entirely on the product, daily, on real iPhones in real apartments.
- 2–5 external STR companies have been onboarded as paying customers.
- Tens of thousands of inspection photos stored with full metadata.
- Monthly owner reports generated automatically from real data.
- Zero tenant data leaks (a company never sees another company's data).
- A clean audit trail for every accountability decision.
- A non-technical founder still able to operate the project safely with Claude's help.
