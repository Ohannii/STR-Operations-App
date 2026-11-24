# Migration-history repair (PR #78 incident, 24 Nov 2026) — PROPOSED, NOT RUN

**Status:** for the lead's review. Nothing here has been run against the live project except `00_preflight_readonly.sql`, which is `SELECT` only.

## Problem

On 19 Nov, two migrations were applied to the live project through the SQL connector:
- `20261119090000_flag_issue_selections`
- `20261119110000_asana_one_destination_per_flag`

Their rows in `supabase_migrations.schema_migrations` were recorded with a **one-line reference comment** instead of the SQL. A Supabase branch replays `statements`, so the replay stops at `20261119100000` (whose grants need the table from `090000`). The live schema itself is correct.

## Files

| File | What it does |
|---|---|
| `00_preflight_readonly.sql` | Read-only. It reports the row count, latest version, whether PR #78's row exists, two fingerprints, the two target rows (exact text and all columns) and the live objects those migrations created. |
| `01_repair_PROPOSED.sql` | One `DO` block, so one transaction. It sets `statements` of the two rows to a one-element array holding the **exact file** (LF preserved), which is the same one-element form `apply_migration` stores. It executes no DDL and touches no application data: the file text is stored as data and never run. |
| `02_rollback_PROPOSED.sql` | One `DO` block. It restores exactly the two original comments and proves the whole table is byte-identical to the preflight. |

## Live preflight (24 Nov 2026, read-only)

- Rows: **34**. Latest: `20261122191844`. No `20261123120000` row (PR #78 is not applied).
- Full-table fingerprint: `e40293ef91f4cfa4d564d6e8e1369c00b7e719dcbecc1cf4af9dae21c1e64cf2`.
- Fingerprint of everything except the two target `statements`: `4582babebe0a3223de1b2da1204066fe17d16948a00793fba590f75c5f7b0da1`.
- **Target rows:** each holds one element, the reference comment. `created_by`, `idempotency_key` and `rollback` are all `null`, and are preserved.
- **Live objects present:** `public.flag_issue_selections`, the enabled trigger `trg_integration_outbox_single_destination`, and `public.asana_outbox_destination(text)`.
- **Executing identity:** the Supabase connector runs as role `postgres` (not superuser). `schema_migrations` has no triggers or RLS.

## Safety built into `01_repair_PROPOSED.sql`

1. **Lock:** `lock table … in share row exclusive mode`. It blocks concurrent writes to the history table only, not reads, for one short transaction. The app never writes to this table.
2. **Payload check:** each embedded file must hash to its reviewed SHA-256 (`extensions.digest`, the UTF-8 bytes of the text). These are the same hashes recorded in the comments and on `main`:
   - `e0a8191e0a809c52…`
   - `c78489b9b4765dcd…`
3. **Preconditions:**
   - exactly 34 rows;
   - the full-table fingerprint equals the preflight value, so **any** change since the preflight refuses.
4. **Two updates only.** Each requires `version`, `name` and the exact current comment, and must match **exactly one** row. A second run therefore refuses.
5. **Postconditions:**
   - still 34 rows;
   - the fingerprint of everything except the two target `statements` is unchanged;
   - the two rows hold exactly the files.
6. **All-or-nothing:** any failed check raises inside the single `DO` block, and nothing is changed.

**Delivery:** the scripts are run as-is through the Supabase connector's `execute_sql`, under the same identity as above. A transcription error cannot slip through, because checks 2 and 3 refuse. PR #78's migration is **not** included.

## Local proof (embedded PostgreSQL)

Tested on a 34-row replica with the same columns and the exact two comment rows. The local copies differ **only** in the two fingerprint literals.

| Test | Result |
|---|---|
| Rollback before repair | refused |
| Repair | both rows hold one element each, with the exact file hashes |
| Repair run a second time | refused |
| Rollback | whole table byte-identical to before |
| Another row changed, then repair | refused, nothing changed |
| Payload tampered by one character | refused |
| An extra (35th) row present | refused |
| Another row changed after the repair, then rollback | refused |

**Replay content:** the stored text is byte-identical to the repository files, which replay cleanly in every local migration run.

**Not proven here:** that a Supabase branch replays all 34 live rows. The later rows (`20261120120935` to `20261122191844`) are replayed from what the live table stores for them. Only the re-run branch test can prove that.

## Order (each step needs explicit approval)

1. The lead reviews this folder.
2. Anni approves **metadata repair only**.
3. Run `00_preflight_readonly.sql` again; the values must still match the table above.
4. Run `01_repair_PROPOSED.sql`.
5. Run `00_preflight_readonly.sql` again and record the new fingerprint.
6. Re-run the data-less branch test with synthetic fixtures. If any replay error appears, **stop and report**.
7. If the repair itself must be undone, run `02_rollback_PROPOSED.sql`.
