# NON_TECHNICAL_USER_GUIDE.md

## What this project is

You are building a mobile-first app for short-term rental property management companies. It helps teams do apartment inspections, capture photo evidence, track damage and maintenance, and produce trustworthy monthly reports for property owners.

**You are non-technical, and that's fine.** This document is your operator's manual for working with Claude on this project safely.

---

## The one big rule

**Do not start coding yet.**

The current phase is **planning** (now in refinement). The plan must be complete and approved before any code is written. Once we start coding, we go file-by-file, in small reversible steps, with documentation updated after each session.

---

## What's in this project folder

There are two important folders:

- **`docs/`** — the project's memory. These markdown files explain *what* the product is, *how* it works, and *what was last decided*. Claude reads these at the start of every session so it doesn't lose context.
- **`prompts/`** — copy-paste prompts for Claude. Each one tells Claude what kind of session you're running (starting, resuming, fixing a bug, reviewing architecture, deploying, closing).

The `CLAUDE_PROJECT_SKILLSET.md` file at the top level is Claude's instruction manual for how to behave on this specific project.

---

## You are the first customer

Your own short-term rental management operation is the first paying customer of this product. That has consequences:

- **You will be doing real work in this app.** Real inspections, real photos, real owner reports.
- **Real data goes in production. Test data goes in staging.** They are different Supabase projects with different photo buckets. They never mix.
- **Don't use staging for live operations.** Even one real inspection accidentally created in staging breaks the rule. If it happens, archive it and re-do the inspection in production.
- **Don't use production for experiments.** If you want to "see what happens if I…", that's a staging activity.
- **The first deploy to production is a small event.** It happens after v1.0 has run cleanly in staging for at least two days with real-shaped test data.

This pattern protects both your operation and your future external customers from a chaotic shared environment.

---

## How to work with Claude (the safe way)

### 1. Always start a session with a saved prompt

Don't just type "let's keep building." Open the right prompt from the `prompts/` folder and paste it.

- Starting fresh? → `prompts/SESSION_START.md`
- Coming back to something? → `prompts/SESSION_RESUME.md`
- Fixing a bug? → `prompts/BUG_FIX_PROMPT.md`
- Reviewing the design? → `prompts/ARCHITECTURE_REVIEW_PROMPT.md`
- About to deploy? → `prompts/PRE_DEPLOYMENT_PROMPT.md`
- After deploy? → `prompts/POST_DEPLOYMENT_VALIDATION_PROMPT.md`
- Ending a session? → `prompts/SESSION_CLOSE.md`
- Handing off to next session? → `prompts/SESSION_HANDOFF.md`

These prompts ask Claude to read the right files first and follow the right rules.

### 2. Let Claude read the docs before doing anything

Whenever you start a session, Claude's first job is to read the docs and summarise the current state. If Claude jumps straight into making changes without reading first, **stop it** and ask it to read the docs.

### 3. Don't accept "let me just refactor this" detours

If Claude proposes changing something unrelated to what you asked, ask **"why does this need to change now?"**. If the answer isn't strong, push back.

### 4. Update docs at the end of every meaningful session

Before you close the chat, paste `prompts/SESSION_CLOSE.md`. This makes Claude update:
- `docs/TASK_LOG.md` — what's next
- `docs/CHANGELOG.md` — what changed
- `docs/KNOWN_ISSUES.md` — what's broken
- `docs/TESTING_CHECKLIST.md` — what's tested

Then save those files. The project's memory is only as good as what's written down.

### 5. When you hit a usage limit

If Claude runs out of usage mid-session:
- Don't panic.
- Wait until you have usage again.
- Open a new chat and paste `prompts/SESSION_RESUME.md`.
- Claude will read the docs and pick up where things left off.

This is exactly what the docs are designed for. We have already proven this works on this project (the planning blueprint itself was completed across two sessions after one usage cap).

### 6. Claude will never ask for your production secrets

If at any point Claude asks you to paste a production `SUPABASE_SERVICE_ROLE_KEY`, password, or any secret labelled "private" or "secret" into the chat: the answer is no.

There is no legitimate reason. Claude can help you configure where the key goes without ever seeing the value. If you see Claude ask, treat it as a red flag, copy the message into a note, and report it.

---

## What you actually need to do (in order)

### Step A — Right now: planning and refinement

- [x] Save the starter files into your project folder.
- [x] Upload the relevant files into a Claude Project.
- [x] Run `PROMPT_0_CLAUDE_PREP.md` — the full planning blueprint is now drafted.
- [x] Run the founder review session — six decisions locked in, blueprint refined, v1 staged into v1.0 → v1.3.
- [ ] **You** read through the refined docs. Especially the new "First customer" section in `PROJECT_BRIEF.md`, the staged v1 plan in `PRODUCT_REQUIREMENTS.md`, and the print-quality requirements in `REPORTING_REQUIREMENTS.md`.
- [ ] Where any assumption still feels wrong, note it and tell Claude in a follow-up session.

### Step B — Soon: tooling setup (no code yet)

When you're ready to move from planning to building, you'll need:

- A GitHub account (free).
- VS Code installed on your laptop (free).
- Node.js installed (free; we'll use it via `pnpm`).
- A Supabase account (free tier).
- A Vercel account (free tier).

You won't set these up alone. Open a Claude session and ask: **"I'm ready to set up the tools. Walk me through it one step at a time."**

### Step C — Building v1.0 first (the inspection loop)

We will build in small slices. Each slice has its own session. Each session ends with documentation updated and a clear "next step" written down. We do not do everything at once.

v1.0 alone is roughly:

1. Project skeleton (empty Next.js app, deployed to Vercel preview).
2. Auth + companies + users.
3. Properties.
4. One default inspection template (post-stay).
5. Inspection workflow on mobile.
6. Photos with sync.
7. Offline drafts.
8. HTML inspection report (print-quality).
9. Audit trail.
10. Real-apartment field test on your iPhone.

Only after v1.0 is solid do we begin v1.1 (issues + maintenance), then v1.2 (inventory accountability), then v1.3 (owner monthly report).

### Step D — Going live

When v1.0 is built and tested in staging, use `prompts/PRE_DEPLOYMENT_PROMPT.md` to walk through the safety checks before flipping production on.

---

## Glossary (plain English)

| Term | What it means |
|---|---|
| **MVP** | "Minimum Viable Product" — the smallest version of the app that's useful. |
| **v1.0 / v1.1 / v1.3** | Staged sub-releases of the MVP. v1.0 is the smallest first deploy; cumulative through v1.3 equals the full MVP. |
| **PWA** | "Progressive Web App" — a website that behaves like a phone app. Lives at a URL but installs to the home screen. |
| **SaaS** | "Software as a Service" — many companies use the same app, each in their own little walled garden. |
| **Multi-tenant** | One app serves many companies, keeping each company's data fully separate. |
| **RLS** | "Row-Level Security" — a database feature that makes sure one company's users can't see another company's data, even if there's a bug. |
| **Frontend** | The bit that runs in the browser — what users see and click. |
| **Backend** | The bit that runs on a server — handles data, login, file storage. |
| **Migration** | A file that changes the shape of the database (e.g. adds a table). |
| **Deploy** | "Push the latest code to a server so users can use it." |
| **Rollback** | "Go back to the previous deploy because the new one is broken." |
| **Preview deployment** | A test version of the app at a temporary URL. Real customers don't see it. |
| **Production** | The real app that real customers use. |
| **Audit trail** | A list of every important change, who did it, and when. We never delete from this list. |
| **Offline-first** | The app works without internet; it syncs when internet comes back. |
| **Service role key** | A master key for the database. **Never share it. Never paste it anywhere.** |
| **Environment variable** | A setting (like a URL or a key) that lives outside the code. Different per environment. |

---

## What to do when something feels wrong

- **The deploy "succeeded" but the page is broken** → Don't redeploy. Open `prompts/BUG_FIX_PROMPT.md`.
- **Claude is about to do something big** → Ask: "What files will this change? Can it be undone?"
- **You're about to click something you don't understand** → Stop. Open a Claude session and ask: "Is it safe for me to click X?"
- **You've lost track of where things are** → Open `prompts/SESSION_RESUME.md`. Claude will rebuild the picture.
- **Something is on fire on production** → Open Vercel → Deployments → pick the previous good one → "Promote to Production". Then ask Claude what happened.
- **Claude asked you to paste a production secret** → Don't. Save the message. Report it.
- **You accidentally created real data in staging** (or test data in production) → Don't try to "fix it" silently. Archive the wrong record, re-do the real one in the correct environment, and write what happened into `KNOWN_ISSUES.md` so the lesson sticks.

---

## Founder commitments

For this project to work safely, you commit to:

1. **Not coding directly** in production without a Claude session guiding you.
2. **Updating the docs** at the end of every session.
3. **Not deploying** something untested.
4. **Saying "stop"** when something doesn't feel right.
5. **Saving every important file** to GitHub before turning off your computer.
6. **Keeping staging and production strictly separate.** No real data in staging. No experiments in production.
7. **Never pasting a production secret into a chat.**
8. **Asking dumb questions** — they are not actually dumb.

That's the system. It is slow at first and fast later, because the docs make every future session smarter.

---

## Current next step

The planning blueprint has been drafted (17 files) and refined once (11 files updated in the founder review). All six founder open questions are now resolved. v1 has been staged into v1.0 → v1.3 for safer delivery.

**The next safe action is:**

1. Save the 11 updated files into the project folder, replacing the previous versions.
2. Read through the updated planning files at least once, especially:
   - `PROJECT_BRIEF.md` (new "First customer" section)
   - `PRODUCT_REQUIREMENTS.md` (staged v1.0 → v1.3)
   - `REPORTING_REQUIREMENTS.md` (HTML report quality bar)
   - `DEPLOYMENT_GUIDE.md` (secret-asking red flag rule)
3. Decide whether the recommended "other improvements" from the review session should be applied (they are not applied automatically).
4. Once everything is settled, ask Claude in a new session: *"I'm ready for the tooling setup for v1.0. Walk me through it step by step."*

**Do not code yet. Do not deploy yet. Read first, decide, then act.**
