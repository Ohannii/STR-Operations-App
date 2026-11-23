# Test activity isolation (draft PR report, revision 4)

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

**28 of 29 deliberate mutations are caught** by the database suite (revision 4 added 7, all caught). The one not caught: deleting the `entity_id` check from `enqueue_asana_handoff`'s input validation.

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

## Recovery and rollback (revision 4: guards are never removed)

**Normal rollback = app rollback only.** Redeploy the previous production build in Vercel ("Instant Rollback"). Leave the migration in place. Every protection stays on:

- new Test 1/Test 2 issues are still stamped as test issues;
- classifications and `asana_handoff_expected` stay immutable;
- the database still refuses any live Asana job for a test issue. The old app's live attempt is refused; the issue is kept and goes to BETA once the new app is back.

What is lost while rolled back: the Testing page, test mode, the 2-minute reconciliation and the Asana health check.

**Optional safe levers** — `supabase/ops/test-activity-isolation/02_safe_recovery.sql`, each lever needing approval. They are for a problem in the new automation itself:

- A. Stop automatic re-sending: revoke the two worker functions. Managers then see "the automatic Asana check ran but failed".
- B. Stop new test mode and end any running test mode, with audit.

They never disable a trigger, and never drop, delete or rewrite anything.

*Proof:* the database acceptance test runs the levers verbatim (section 14), and a contract test fails if the script and the test ever differ. It shows:

- both guards are still enabled;
- no classification changed;
- a new test-apartment issue is still a test issue, still expected and still immutable;
- a live job for it is still refused, which is exactly the old app's behaviour;
- test mode cannot start;
- reconciliation is refused;
- after RESTORE, the waiting test issue is picked up again.

**Hazardous emergency only, not a rollback** — `03_emergency_disable_classification.sql`. Use it only if the classification trigger itself blocks real issue reporting.

- It states its hazards: test issues can reach live Asana, failed sends are not retried or reported, and classifications are not locked.
- It requires all testing to stop and `ASANA_LIVE_INCIDENTS_ENABLED` to be switched off first.
- It refuses to run without an explicit acknowledgement setting (section 15 and the contract test).
- It disables only the classification trigger. The live-job veto stays on.

## Asana handoff health (revision 4: manager early warning)

The database function `asana_handoff_health(company)` is for operations managers only; other roles and other companies get 42501. For **real** issues only (never test issues) that were expected in Asana and are not there, it reports:

- **missing:** no Asana job for more than **10 minutes**, which is 5 worker runs, so ordinary 2-minute latency is never reported. It includes issues older than 14 days that are no longer retried automatically (`missing_beyond_retry`).
- **stopped:** the create job ended without a task (dead, manual review, or done without a link). Reconciliation never retries these.
- **stuck:** the create job has been waiting or running for more than **30 minutes**.
- **Worker heartbeat:** each cron run records when the reconciliation check ran and whether it worked. The record holds timestamps only and is service-role only. A healthy empty queue (recent successful check, no problems) is therefore distinct from a broken worker (no check for more than 15 minutes, or a failed check).
- **Examples:** up to 10, showing apartment, time and problem only. No descriptions, reporter or guest data (tested).

Where managers see it:

- The **dashboard** shows an amber box **only when something needs attention**. It streams in, so it never delays the page. Inspectors see nothing and do nothing new.
- The **Testing page** always shows the status.

Each problem comes with plain recovery guidance:

- The app keeps retrying.
- If it is the worker, ask the developer to check the Vercel cron job.
- For issues that are no longer retried, create the task in Asana by hand or have it re-sent. Nothing is lost.

**Failure paths reviewed:**

| Path | Before | Now |
|---|---|---|
| Enqueue never happened, under 14 days | auto-retried; visible only per issue | auto-retried; manager alert after 10 minutes |
| Enqueue never happened, over 14 days | per issue only ("needs attention") | **manager alert, labelled "no longer retried"** |
| Job died or went to manual review | per issue only | **manager alert ("Sending stopped")** |
| Job waiting for hours (e.g. company not allow-listed for the worker) | per issue "Sending to Asana" | **manager alert after 30 minutes** |
| Worker or cron not running | invisible | **manager alert after 15 minutes**; also shown when the check runs but fails |
| Asana switched off for the company | — | not an alarm (shown as off on the Testing page) |
| Job soft-deleted on purpose | — | not reported (deliberate removal) |
| Test issue failing to reach BETA | — | not reported (not operational work) |

## Test evidence

**On `main` `da595a4` + this change**

- Vitest: 88 files, 1736 tests, all passing.
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

- `supabase/tests/test_activity_isolation_test.sql`: 112 assertions in one rolled-back transaction.
- It passed on `main`'s migrations, and on `main` + PR #74's migrations, which matches the shared database's migration history.
- 29 mutations were tried and 28 caught (see point 4).

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
- An issue that fails to enqueue permanently is retried every run until it is 14 days old. Managers are alerted after 10 minutes and the issue stays listed, labelled "no longer retried", after 14 days.
- The health alert is shown in the app only (no email or push), as requested: no new external alert service.
