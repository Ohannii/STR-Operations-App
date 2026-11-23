# Test activity isolation (draft PR report, revision 3)

Purpose: test work never creates live Asana work, and a real issue never silently misses Asana. The change keeps live Incidents & Damages intake for genuine issues and adds no steps for inspectors.

**Status:** draft for review.

- Nothing merged or deployed.
- No migration applied, no release step run, no environment or live data changed.
- The only database access was two read-only `select` queries on the shared database (the ids of Test 1 and Test 2, and the company's Asana setting).

## What it does

1. **Test apartments** (`properties.is_test`).
   - Every issue on Test 1 or Test 2 is a test issue, for everyone.
   - Changed only by managers, through an audited function, on the in-app Testing page. The page uses an in-app confirmation with a reason.
2. **Test mode on one apartment.**
   - A manager picks a real apartment (for example Unit 13) and a duration of up to 4 hours.
   - Only issues *that manager* raises *on that apartment* are test issues. Their issues elsewhere, and everyone else's, stay live.
   - Every start and end is audited.
   - A banner shows the apartment and end time.
   - The test mode stops applying when the manager loses the manager role.
3. **Classification is decided by the database at creation and cannot change afterwards.**
   - `flags.is_test` and `flags.test_reason` are set by a trigger; client values are ignored.
   - Test issues go to the BETA Asana project.
4. **Three independent protections against live Asana work for test issues:**
   - app routing;
   - the worker's live gate;
   - a database trigger that refuses any live outbox job for a test issue. It checks inserts and any update of `provider`, `entity_type`, `event_type`, `entity_id`, `deleted_at` or `company_id`.
5. **No silent Asana loss.**
   - When the app cannot read the classification, it enqueues nothing; it does not guess.
   - At creation the database stamps `flags.asana_handoff_expected` (true when the company has Asana switched on). The stamp ignores client input and is immutable.
   - Every 2 minutes the cron worker reconciles expected issues that have no Asana job, and enqueues them from the stored classification.
   - While it waits, the issue shows "Sending to Asana".

## Lead's verification points

### 1. Reconciliation can never send historical, unrouted or already-processed issues

An issue is reconciled **only if every one of these holds**. All are checked by `asana_flags_awaiting_handoff`, and checked again by `enqueue_asana_handoff` inside the insert transaction.

- **It was created after the migration.** `asana_handoff_expected` is false for every existing row: it is a column default with no backfill. Only the insert trigger sets it, and no one can change it afterwards (42501).
  - *Tested:* historical normal and historical test issues are never awaited, and enqueueing them returns `not_expected` (11a–11c).
  - *Verified on a production-shaped database:* applying the migration on top of an existing Test 1 issue leaves it `is_test = false`, `expected = false` and not awaited.
- **It is not deleted, and is 2 minutes to 14 days old.** The 2-minute guard means the app's own enqueue is never raced.
- **Its company still has Asana switched on.**
- **It has no Asana job of any kind**, including soft-deleted ones, so a deliberately removed job is never recreated.
- **It has no saved Asana task link and no task-link record**, active or removed. This exclusion was added in this revision.
  - *Tested:* 11d–11g. Nothing is written for these issues.

### 2. No duplicates and no rerouting

- **Insert-only.** Reconciliation never updates or deletes a job. *Tested:* existing jobs are unchanged (11h).
- **Re-checks before inserting.** Immediately before inserting, the enqueue function checks again for any job, task link or task-link record. If one exists, it returns `already_has_job` and does nothing.
- **Database backstops:**
  - the existing unique indexes allow one create job and one attach job per issue;
  - the one-destination trigger refuses a job for the other destination (23505);
  - the function treats a 23505 from a concurrent writer as `already_has_job`.

  *Tested:* repeat, lost response and other-destination attempts (10u, 10v, 10x).
- **Destination rule.** The destination comes from the stored classification, using the same function the app uses (`chooseDestinationForNewFlag`). A test issue goes to BETA. A live job for a test issue is refused by the enqueue function and again by the trigger (10p).

### 3. Test 1 / Test 2 during the migration-to-deployment transition

- **Apply the migration and `supabase/ops/test-activity-isolation/01_mark_test_apartments.sql` in ONE transaction.** Then there is no moment in which isolation exists but Test 1/Test 2 are unmarked. This was verified locally on a production-shaped schema: both apartments marked, 2 audit rows written, and a re-run is a no-op.
- **From that commit until the new code is deployed:**
  - The current production code keeps working; it never references the new objects.
  - A new Test 1/Test 2 issue is stamped as a test issue. The old code would try live, and the database refuses it. The issue is saved with no job, and stays "expected".
  - After deploy, reconciliation sends it to **BETA** within about 2–4 minutes.
  - **No path to live Asana exists in this window.**
- **Remaining windows:**
  - (a) Until the migration is applied — that is, **today**: Test 1/Test 2 issues go live, exactly as now.
  - (b) A manager testing on Unit 13 with the **old** code deployed: test mode cannot be switched on until the new code is live, so those issues still go live, exactly as now.

  Recommendation: pause testing on Test 1, Test 2 and Unit 13 from now until the new code is deployed.

### 4. The one mutation the tests do not catch

**21 of 22 deliberate mutations are caught** by the database suite. The one not caught: deleting the `entity_id` check from `enqueue_asana_handoff`'s input validation.

It cannot cause a real failure. The function's `INSERT` never reads `entity_id` or `company_id` from the input; it always writes the function's own `p_flag_id` and that flag's company. A wrong `entity_id` therefore can never reach the outbox. The check is defence in depth only. This is documented in a comment inside the function.

### 5. Bounded, idempotent, company-scoped, safe when integrations are down

| Property | How it is guaranteed |
|---|---|
| Bounded | 10 issues per cron run (SQL caps any call at 50); the 14-day window; at most one pass every 2 minutes. |
| Idempotent | See point 2. A failure leaves the issue waiting for the next run; a repeat is a no-op. |
| Company-scoped | Every row carries its issue's own company, and Asana must be enabled for that company. The enqueue function refuses jobs whose company or flag differs from the issue's (10k, 10o). |
| Asana unavailable | Reconciliation never calls the Asana API; it only writes outbox rows. If Asana is down, those jobs wait in the existing worker queue with its existing retry. If Asana is switched off for a company, nothing is reconciled for it (10g, 10za). |
| Hostaway unavailable | No dependency. Reconciliation does not read or call Hostaway. |
| Database errors | `reconcileAsanaHandoffs` never throws. A failed lookup returns `ok: false`, and one bad issue does not stop the others (unit tests). |
| Least privilege | No new table grants. The worker uses two `service_role`-only security-definer functions; clients cannot call them (10b, 10j). |

### 6. No credentials or sensitive release data

- The diff contains no tokens, keys, passwords, emails, phone numbers or guest data. A regex scan of the full diff was clean.
- Every UUID added already appears on `main`: the company id, the Test 1 id and the fixture ids.
- The release step finds Test 1 and Test 2 by name within the company, so Test 2's id is not published.
- No `.env` files were touched.

## Release sequence (each step needs its own approval)

1. Review and approve this draft PR.
2. Optional: run `supabase/tests/test_activity_isolation_test.sql` against a Supabase branch.
3. Pause testing on Test 1, Test 2 and Unit 13.
4. In one transaction, apply the migration and then `01_mark_test_apartments.sql`.
5. Merge and deploy.
6. Verify:
   - a Test 1 issue goes to BETA;
   - a Unit 13 issue in test mode goes to BETA, while a Unit 14 issue by the same manager goes live;
   - an ordinary inspector issue goes live.

## Rollback (non-destructive)

- **App problem:** redeploy the previous build. The migration stays, and the previous code works with it.
- **Database behaviour problem:** run the PAUSE section of `supabase/ops/test-activity-isolation/02_pause_resume.sql`. It:
  - disables the two triggers;
  - revokes the worker functions and session start;
  - ends open sessions, with audit.

  It drops and deletes **nothing**: classifications, sessions, test apartments, audit rows and outbox rows are all kept. RESUME restores the behaviour. This was verified locally: while paused, a Test 1 issue is stamped normal; after resume, it is a test issue again.

## Test evidence

**On `main` `da595a4` + this change**

- Vitest: 86 files, 1714 tests, all passing.
- `tsc`: 8 errors, the pre-existing baseline in test files only.
- `eslint`: clean on all changed files.
- `git diff --check`: clean.

**On PR #74 head `6be0dee` + this change** (one hunk resolved by hand)

- Vitest: 99 files, 1853 tests, all passing.
- `tsc`: the same 8-error baseline.

**Build**

- `next build --webpack` compiled, type-checked and generated all 19 pages, including `/dashboard/testing`. Google Fonts were mocked, because they cannot be fetched from the sandbox.
- **Not run:** the Turbopack build.

**Database**

- `supabase/tests/test_activity_isolation_test.sql`: 91 assertions in one rolled-back transaction.
- It passed on `main`'s migrations, and on `main` + PR #74's migrations, which matches the shared database's migration history.
- 22 mutations were tried and 21 caught (see point 4).

**End to end:** rows from the real TypeScript builders were inserted through the real `enqueue_asana_handoff`. A normal issue got live jobs with the live pin; a test issue got BETA jobs.

**Not verified:**

- the shared database or a Supabase branch;
- real Supabase auth;
- a Vercel cron run;
- phones and real devices;
- the Turbopack build;
- PR #76's Hostaway migration.

## PR #74 overlap

- One conflict: `src/app/properties/[id]/page.tsx`, at the parallel-read `Promise.all`.
- Resolution: keep PR #74's `loadInspectionJobs(...)` entry, then add the two `testFlagsPromise` lines after the `])`.
- No other file overlaps.

## Remaining risks

- Test issues still count in the dashboard's open-issue totals and in reports. Excluding them is a small follow-up.
- Marking Test 1 as a test apartment ends the `ASANA_LIVE_INCIDENTS_TEST` preview on Test 1.
- The live company id is still hard-coded. Long term: a separate staging project, plus per-company live-routing settings.
- An issue that fails to enqueue permanently is retried every run until it is 14 days old. After that it shows "Asana sync needs attention". There are no alerts yet; the result is in the cron log.
