# supabase/manual-verification

These SQL scripts are **manual / staging verification** scripts. They are
deliberately kept **out of `supabase/tests/`** so that `supabase test db` (which
auto-discovers and pg_prove-runs everything in `supabase/tests/`) does not try to
run them as automated pgTAP tests.

## Why they are not automated pgTAP tests

None of these emit a pgTAP plan (`plan()` / `finish()`), and several depend on
data or objects that only exist in a specific (hosted/seeded) database:

| File | Nature | Why it is manual, not an isolated test |
|------|--------|----------------------------------------|
| `migration_state_audit.sql` | migration audit | Reports state; no pgTAP plan. |
| `prearrival_preflight.sql` | preflight check | Diagnostic output; no pgTAP plan. |
| `prearrival_rehearsal.sql` | rehearsal | Creates objects (e.g. `photo_upload_intents`) the migrations already create; meant to run against a non-migrated/rehearsal DB. |
| `prearrival_cancellation_test.sql` | staging test | Aborts unless a specific seeded test company exists. |
| `prearrival_intents_verification.sql` | staging verification | Hard-codes company `1669c464-8d26-40fc-9956-9f8955fd27c7`. |
| `prearrival_intents_verification_body.sql` | staging verification | Same hard-coded company dependency. |
| `team_invitations_manual_verification.sql` | comprehensive staging check | Full invitation-lifecycle walk-through using a custom `pg_temp.chk` harness + a hard-coded seed company; re-declares migration objects to run standalone. Superseded for CI by the isolated pgTAP test in `supabase/tests/team_invitations_test.sql`, but preserved here because its end-to-end coverage is broader. |

## How to run them (manually, against the intended environment)

```bash
# Example: run a single manual script against a linked/seeded DB
pnpm.cmd exec supabase db query --linked -f supabase/manual-verification/<file>.sql
# or via psql against the environment that has the required seed data
psql "<connection-string>" -f supabase/manual-verification/<file>.sql
```

Do **not** point these at production. Their purpose (audit / preflight /
rehearsal / staging lifecycle verification) is preserved unchanged from when they
lived in `supabase/tests/`; only their location moved so the automated gate is
clean.
