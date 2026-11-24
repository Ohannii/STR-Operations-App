# PR #78 production release runbook — v1 (24 Nov 2026)

**Status:** for the lead's independent review. Nothing in this runbook has been run against production, except that `release_1_preflight_readonly.sql` was run once, read-only, to record the expected values below.

**Approvals:** every step marked **[APPROVAL]** needs Anni's explicit approval at the time, naming the step, file and commit.

## 0. What is being released

| Item | Value |
|---|---|
| PR | #78 `fix/test-activity-isolation` → `main` (draft) |
| App change | test apartments; manager test mode for one apartment; database classification; BETA routing for test issues; live-Asana veto; 2-minute reconciliation; manager Asana-health warning |
| Database change | `supabase/migrations/20261123120000_test_activity_isolation.sql`, SHA-256 `422bc93d9dede32ceb9f5944173c770083f27c5cdb79ede7621b0c99e7c7381a` (LF) |
| Data change | `supabase/ops/test-activity-isolation/01_mark_test_apartments.sql`, SHA-256 `dc68c65639f49e8b7e248349c928f46baf47fc8289f95ade2b22afaa2ccb7853`: marks exactly the active **Test 1** and **Test 2**, and writes 2 audit rows |
| Release SQL | `release_1_preflight_readonly.sql`, `release_2_apply_PROPOSED.sql`, `release_3_postflight_readonly.sql` in the same folder |

## 1. Evidence already in hand

**Unit, build and integration (Claude):**
- At `34225fe`: Vitest 89 files / 1752 tests; `tsc` at the 8-error test-only baseline; eslint clean; `next build --webpack` passed (Google Fonts mocked).
- Database suite: 113 assertions; 29 mutations tried and 28 caught.

**Isolated Supabase branch (lead, 24 Nov), final run on `mdedexeajksnfeehpdkb`:**
- the 34 historical migrations replayed;
- migration and marking applied in **one** transaction;
- the unchanged acceptance script printed `TEST ACTIVITY ISOLATION: ALL PASSED`;
- 0 flags and 0 outbox rows were left behind;
- the branch was deleted.

**Migration-history repair (lead, approved by Anni, 24 Nov):**
- `20261119090000` and `20261119110000` now hold their full SQL, hashes verified;
- no schema or data change;
- PR #78's migration is still absent.

**This runbook's release SQL (Claude, local PostgreSQL with production-shaped schema and 34 history rows):**
- preflight → apply → postflight all matched;
- with "Test 2" renamed, apply **refused and changed nothing**;
- a second apply **refused**;
- the acceptance suite passed on the released database.

**Not yet proven:**
- a run against the real production database;
- a real Vercel cron run;
- live Asana end to end;
- real devices.

## 2. Expected live values (read-only preflight, 24 Nov 2026)

| Check | Value |
|---|---|
| `history_rows` / `history_latest` | 34 / `20261122191844` |
| `pr78_history_rows` / `placeholder_rows` | 0 / 0 |
| `history_fingerprint` | `a7dd154116a9b381d2d5e1cc4c369e3612e7b640ab4433982786a54382fe8e56` (after the 24 Nov repair) |
| `pr78_objects_absent` / `pr78_columns_absent` | true / true |
| `active_test_apartments` | 2 |
| `asana_enabled` | true |
| `asana_jobs_in_flight` | 0 |
| `live_jobs_in_flight_for_test_apartments` | 0 |

If **any** value differs at release time, stop and report. Don't improvise.

## 3. Order of release (recommended: PR #78 first, on its own)

**Step A. Freeze testing.** Nobody raises issues on Test 1 or Test 2, or tests on a real apartment, from step B until step G is complete.

**Step B. Vercel checks (read-only, lead or Anni).** In the Production environment:
- `ASANA_WORKER_DRY_RUN=false`;
- `CRON_SECRET` set;
- note the values of `ASANA_LIVE_INCIDENTS_ENABLED` and `ASANA_LIVE_INCIDENTS_TEST`, and don't change them;
- note the current production deployment, which is the Instant Rollback target.

**Step C. Preflight.** Run `release_1_preflight_readonly.sql`. It must equal §2.

**Step D. [APPROVAL] Database.** Run `release_2_apply_PROPOSED.sql` through the Supabase connector (role `postgres`). It is one transaction: SHA-256 guards, migration, marking, history recorded with the **full SQL**, and postconditions (2 test apartments, 2 audit rows, 3 enabled guard triggers, heartbeat row, exact function and table grants). Any failure means nothing changed.
- If it aborts with `lock timeout` (staff activity), retry a few minutes later.
- **Between D and F the current app keeps running.** It never references the new objects. A new Test 1 or Test 2 issue raised by mistake is stamped as a test issue, so the old app's live attempt is refused by the database veto. The issue is saved and waits until reconciliation sends it to BETA after F. Nothing can reach live Asana.

**Step E. Postflight.** Run `release_3_postflight_readonly.sql`:
- 35 rows, latest `20261123120000`;
- `pr78_history_statement = 1:422bc93d…7381a`;
- `earlier_history_fingerprint` = the preflight `history_fingerprint`;
- Test 1 and Test 2 both true;
- `all_test_apartments = 2`, `reclassified_existing_flags = 0`, `test_sessions = 0`;
- `heartbeat_waiting_for_first_run = true`;
- jobs in flight equal to preflight.

**Step F. [APPROVAL] Merge PR #78 → `main`**, which deploys production on Vercel.
- Before merging, re-run the unit tests and build on the exact merge candidate (PR #78 head rebased or merged onto the then-current `main`).
- Vercel production deploys from `main`; cron jobs run only there.

**Step G. Post-deploy checks:**
1. Within about 5 minutes, `integration_worker_heartbeats.last_run_at` is set with `last_ok = true` (read-only query). The manager's Testing page shows "All issues reached Asana".
2. **[APPROVAL] Controlled functional checks.** These create **real** Asana tasks, so only run them with approval, and close the tasks afterwards:
   - an issue on **Test 1** gets a BETA job (`asana.create_task_for_flag`) and a BETA task;
   - a manager in test mode on **Unit 13** raises an issue: BETA;
   - the same manager raises an issue on **Unit 14** (or an ordinary inspector raises one): `asana.live.create_task_for_flag`, one live task in Incidents & Damages, no duplicate.
3. Lift the testing freeze.

## 4. Recovery

| Situation | Action | Effect |
|---|---|---|
| App problem after F | Vercel **Instant Rollback** to the deployment noted in step B | The database keeps classification, immutable stamps and the live veto. Lost until redeployed: Testing page, test mode, reconciliation and health warning. The previous worker drains its queue as before; test issues still never go live. |
| New automation misbehaves (e.g. reconciliation) | **[APPROVAL]** `02_safe_recovery.sql` levers | Revokes the reconciliation functions and/or stops test mode, with audit. No trigger is ever disabled. |
| The database step itself must be undone | **Do not** drop objects ad hoc. Write a reviewed, guarded down-migration first. | Until then the app rollback above is safe. |
| Classification trigger blocks real issue reporting | `03_emergency_disable_classification.sql` only, with its listed preconditions and approval | **Hazardous**, never routine. |

## 5. PR #74 after PR #78

The two PRs overlap in **3 files**:
- `src/app/dashboard/page.tsx`
- `src/app/properties/[id]/page.tsx`
- `src/components/app-shell.tsx`

**Proof (Claude, 24 Nov).** A trial merge of PR #78 (`7f0ca2a`) into PR #74 (`6be0dee`), as local commit `1e4d54a` (not pushed):
- Git's three-way merge resolved all 3 files **automatically**. In each merged file, the diff against PR #74 is **additions only**: no PR #74 line is removed. The 44 px navigation, workboard and inspection views are intact.
- Vitest: 102 files / 1891 tests. `tsc` at the 8-error baseline. eslint is clean on the 3 files. `next build --webpack` produced 21 pages.
- Database: the PR #78 acceptance suite **ALL PASSED** on the combined schema. PR #74's `scripts/tests/inspection-database.mjs` passed with 35 runner checks and 52 SQL assertions.
- The earlier note of "one conflicting hunk" was a `git apply` limitation, not a real conflict.

**Plan:** after PR #78 is merged, update PR #74 by merging the new `main` into it (the same merge as proven above). Then re-run its tests and its own acceptance plan. PR #74 is **not** release-ready: Hostaway mapped turnovers, Android, offline and cross-user device checks are still pending.

## 6. Open, acknowledged risks

- Test issues still count in the dashboard totals and reports.
- Marking Test 1 ends the `ASANA_LIVE_INCIDENTS_TEST` preview on Test 1.
- The health warning is in the app only (no email or push).
- The company id is hard-coded (`LIVE_TEST_SCOPE`).
- Live external systems (Asana, Vercel cron) are not yet verified end to end. Real-device checks are still pending.
