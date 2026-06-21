# SESSION_9A_MIGRATION_READINESS_PLAN.md

**Type:** Migration readiness plan (planning document — no migration created or run)
**Date:** 2026-06-21
**Companion:** `docs/SESSION_9A_SLICE_1_BUILD_SPEC.md` (the target model), `docs/PRE_9A_DECISION_MEMO.md`, `docs/FIVE_ADVISOR_SIGN_OFF_2026-06.md`
**Status:** For operator review. **Nothing in this plan has been executed.** No migration files exist, no data was changed.

> Purpose: before any `flag_categories` re-seed, legacy-category deactivation, or flag back-fill, lay out exactly what would change, how evidence retention is protected, the dry-run + rollback approach, and the hard no-go conditions. Slice 1 **code** is already live; this plan covers only the **data migration** that Slice 1 deferred.

---

## 0. Summary in one paragraph

Slice 1 shipped as **code only** — the Report Issue UI, the category/accountability split in the app layer, and the retention re-derivation. The category dropdown already hides accountability/disposition items at the UI layer, and retention already protects legacy categories in code. What remains is a **data migration in two parts**: (1) re-seed `flag_categories` (add the genuinely-new categories, relabel `condition_note`, and **deactivate** — never delete — the legacy accountability/disposition categories), and (2) **back-fill** existing flags that point at the deactivated categories, mapping each to a clean category + a preliminary accountability value. The single biggest risk is mis-retaining dispute evidence; the plan below shows why that risk is already largely contained and how the dry-run + PITR gate fully close it.

---

## 1. What data would be affected

- **`public.flag_categories`** — the 11 system rows (`company_id IS NULL`). Some get a new `is_active = false`; new rows get added; one display label updated. **No rows deleted.**
- **`public.flags`** — only existing flags whose `flag_category_id` points at one of the 5 legacy categories being deactivated. Their `flag_category_id` and/or `chargeable_party_decision` would be updated. **No flags deleted; evidence untouched.**
- **`public.photos`** — **not modified.** `retention_class` is written once at capture and is intentionally not recomputed by the back-fill (see §7).
- **`public.audit_events`** — one new audit row written per flag changed (append-only history).
- **Nothing else.** No `inspections`, `evidence_packs`, `issues`, `inventory_*`, `accountability_records`, RLS, roles, or storage objects are touched.

## 2. Which current `flag_categories` rows exist (system seed, `company_id = NULL`)

| key | DB display_label | severity_default | Disposition in new model |
|---|---|---|---|
| `condition_note` | "Just a note" | low | **Keep** → relabel to "Observation / note" |
| `cleaning_issue` | "Cleaning needed" | low | **Keep** (Cleaning / housekeeping) |
| `maintenance_issue` | "Broken thing" | med | **Keep** (Maintenance) |
| `inventory_missing` | "Item missing" | med | **Keep** (Item missing) |
| `inventory_damaged` | "Item damaged" | med | **Keep** (Item damaged) |
| `safety_urgent` | "Safety!" | high | **Keep** (Safety) |
| `guest_damage` | "Guest broke it" | high | **Deactivate** → accountability "Guest damage" |
| `owner_chargeable` | "Owner pays" | low | **Deactivate** → accountability "Owner — chargeable" |
| `company_responsibility` | "Company pays" | low | **Deactivate** → accountability "Company absorbed" |
| `follow_up_required` | "Check next time" | low | **Deactivate** → disposition "Follow-up" |
| `no_action_record` | "Just noting it" | low | **Deactivate** → disposition "Record only" |

(Note: the app shows the labels from `src/lib/ui/flag-category.ts`, not these DB `display_label`s, so re-labelling is cosmetic in the DB — but worth aligning during the re-seed.)

## 3. Which rows would be ADDED

Four genuinely-new categories (active, field-selectable), plus one inactive holding row:

| key (proposed) | display_label | severity_default | active? |
|---|---|---|---|
| `linen_towels` | "Linen / towels" | low | yes |
| `access_keys_lock` | "Access / keys / lock" | med | yes |
| `appliance_furniture` | "Appliance / furniture" | med | yes |
| `guest_incident` | "Guest incident" | med | yes |
| `legacy_uncategorised` | "Legacy uncategorised — needs review" | low | **no** (review-only holding bucket; not field-selectable) |

The `access_keys_lock` and `appliance_furniture` keys are **already referenced by the live retention logic** (`deriveRetentionClass`), so seeding these keys activates retention rules that are otherwise dormant. The app's reportable-category list (`REPORTABLE_CATEGORY_KEYS`) would also need these four keys added in code to surface them in the form — a small **code** change paired with this seed.

## 4. Which legacy rows would be DEACTIVATED (not deleted)

`UPDATE public.flag_categories SET is_active = false WHERE company_id IS NULL AND key IN ('guest_damage','owner_chargeable','company_responsibility','follow_up_required','no_action_record');`

- Rows are **kept** so existing flags' `flag_category_id` foreign keys stay valid and historical display still resolves.
- `is_active = false` removes them from any future "active categories" listing; the app already excludes them from the field picker in code (`REPORTABLE_CATEGORY_KEYS`).
- Fully reversible: set `is_active = true` to restore.

**Display invariant (critical): `is_active = false` filters field PICKERS only — never display.** Inactive categories must still render their label and icon on existing flags, the Action Centre, reports, and history; otherwise back-filled and historical flags would show a blank/missing category. In this app, display goes through `getFlagCategoryDisplay(key)` in `src/lib/ui/flag-category.ts`, which resolves by key **regardless of `is_active`** — only the field picker filters (via `REPORTABLE_CATEGORY_KEYS`). Three requirements follow:

- No display/report/history/Action-Centre query may filter categories by `is_active`. **Only** the Report Issue field picker may.
- The paired code change must add **display entries** (label + icon) for the 4 new keys **and** for `legacy_uncategorised` to `flag-category.ts`, so back-filled flags render "Legacy uncategorised — needs review" rather than a generic fallback.
- `legacy_uncategorised` is added to the DB (inactive) and to the display map, but **NOT** to `REPORTABLE_CATEGORY_KEYS` — display-only, never field-selectable.

## 5. Which existing flags would need review / back-fill

Only flags whose `flag_category_id` resolves to one of the 5 deactivated keys. For each:

| Legacy category | New category (proposed) | Accountability set | Disposition |
|---|---|---|---|
| `guest_damage` | `legacy_uncategorised` (review) | Guest damage | Needs action |
| `owner_chargeable` | `legacy_uncategorised` (review) | Owner — chargeable | Needs action |
| `company_responsibility` | `legacy_uncategorised` (review) | Company absorbed | Needs action |
| `follow_up_required` | `legacy_uncategorised` (review) | Not sure / needs triage | Follow-up (mark) |
| `no_action_record` | `legacy_uncategorised` (review) | Not sure / needs triage | Record only (`status='no_action'`) |

For accountability, if a flag already has an explicit `chargeable_party_decision` it **wins** over the category-implied value (conflicts listed in the dry-run). Disposition "Follow-up" = a `flag_operational_marks` row `kind='follow_up'`; "Record only" = existing `status='no_action'`.

**Volume note:** the affected count is whatever exists today — on staging this is small (test data). The dry-run produces the exact number before anything runs.

## 6. Which rows are lossy / need human review

All five deactivated categories are **lossy on issue type** — the original row recorded *who pays* or *an outcome*, never *what was wrong* (e.g. a `guest_damage` flag doesn't tell us if it was a broken appliance, a missing item, or a stain). So every affected flag lands in the **`legacy_uncategorised` review bucket** with its accountability/disposition preserved, and **ops manually assigns a real issue category** afterwards. The dry-run lists each flag with its original category, description, and evidence reference to make that human review fast. No automated guess of the issue type is made.

## 7. How retention class is protected

This is the highest-stakes concern, and it is **already largely contained**:

- **Existing photos are not touched.** `photos.retention_class` is written once at capture. Photos already attached to a `guest_damage` flag were captured as `dispute_evidence` (the live `deriveRetentionClass` maps both the legacy `guest_damage` category key and the `guest_damage` accountability value to `dispute_evidence`), `owner_chargeable` → `owner_chargeable_evidence`, `safety` → `dispute_evidence`. The back-fill does **not** lower any existing class.
- **The back-fill preserves accountability**, so even after a flag moves to `legacy_uncategorised`, its accountability (Guest damage / Owner-chargeable / etc.) still drives dispute-grade retention for any **future** photos on that flag.
- **Promote-only, never demote.** If ops sets a stronger accountability during review, retention upgrades; it never downgrades.
- **Optional hardening (recommended, not required):** the dry-run also reports, per affected flag, the retention class its photos *would* get under the new derivation, and flags any case where a photo's stored class is *weaker* than the new derivation would give — so ops can promote those few before retiring legacy keys. Promotion is a one-way `UPDATE photos SET retention_class = ...` only where it strictly increases protection.

Net: no dispute/owner/safety evidence can be under-retained by this migration.

## 8. PITR / backup confidence required before running

Mandatory before **any** write to production:

1. **PITR confirmed enabled** on the production Supabase project (it is a paid-tier add-on), with the retention window documented.
2. **A restore rehearsal performed** on staging or a duplicated project — a backup never restored is only a theory. Confirm the restore brings back `flags` + `flag_categories` + `photos` consistently.
3. **A fresh logical export** of the affected tables (`flag_categories`, and `flags` columns `id, flag_category_id, chargeable_party_decision, status`) taken immediately before execution, stored off the production project.

If any of the three is not green, **do not run on production.**

## 8b. Execution identity & path (how this actually runs)

Be precise, because a real data migration does **not** run as an app user:

- **Dry-run (read-only):** a `SELECT`-only query. Safe to run on **staging** via the Supabase SQL editor or the `supabase` CLI (or even as an RLS-scoped authenticated read) — it writes nothing. This is the only thing run until ops signs off.
- **The write migration (seed + back-fill):** a **versioned SQL migration file** in `supabase/migrations`, applied with **Supabase migration tooling** (`supabase migration new …`, then `supabase db push`). It executes as the **database migration / owner role** — the privileged Postgres role the CLI uses over a direct DB connection — **not** through an app action and **not** as an authenticated app user. RLS does not apply to a migration by design; that is normal and expected for DDL/DML migrations.
- **This is NOT the app's `service_role` secret key.** The project rule "no `service_role`" means the *application* never uses the service_role API key at runtime and Claude never asks for it. It does **not** forbid a normal schema/data migration from running as the migration role. These are two different mechanisms: a direct-DB migration/owner role (CLI) vs. a REST-API secret key (app). The migration uses the former.
- **Who runs it:** the founder, via the Supabase CLI / dashboard, **after explicit approval** — gated by the project hard rules ("do not run `supabase db push` / create migrations unless explicitly approved"). Claude does not run it.
- **Fixed order:** read-only dry-run on staging → write + rollback rehearsal on staging → **production only after explicit approval**, with the pre-run export (§8.3) in hand.

> This supersedes the earlier loose phrase "RLS-scoped as a normal authenticated admin," which was imprecise for a migration-tool execution.

## 9. Dry-run approach (read-only, no writes)

1. Run a **report-only script** (a `SELECT`, no `UPDATE`) that, for every flag pointing at a deactivated category, outputs: flag id, property, original category, description (truncated), current `chargeable_party_decision`, **proposed** new category + accountability + disposition, and the **resulting retention class** for its photos.
2. Output totals: count per legacy category, count of accountability conflicts, count of photos whose class would change.
3. **Ops reviews** the report — especially the lossy rows and any conflict — and signs off the mapping or records per-flag overrides.
4. Re-run the dry-run after any mapping change until the report matches intent exactly.
5. The dry-run can be run **safely on staging today** (see §12) with zero risk, because it writes nothing.

## 10. Rollback approach

Layered, so a problem at any stage is recoverable:

- **Categories:** deactivation is `is_active = true` to restore; added rows can be set inactive or removed (they have no dependents yet). Legacy rows are never deleted, so foreign keys never break.
- **Flags:** every changed flag writes an `audit_events` row with `before`/`after` (`flag_category_id`, `chargeable_party_decision`, status/mark). A reverse script can restore each flag from its audit `before` values.
- **Photos:** only ever promoted (one-way, optional) — and only when it strictly increases retention, so there is nothing harmful to roll back; if needed, the pre-run export holds the original classes.
- **Last resort:** PITR restore to the pre-migration timestamp recorded in §8.

**Defined rollback point:** the pre-execution PITR timestamp + the logical export from §8, plus the audit-trail reverse script.

## 11. Exact no-go conditions (do not run if ANY is true)

- PITR is not confirmed enabled, or no restore rehearsal has been done.
- The pre-run export (§8.3) was not taken.
- The dry-run shows an unexpected affected count, unresolved conflicts, or any photo whose class would *decrease*.
- Ops has not signed off the mapping for the lossy rows.
- Running directly against production **without** a successful staging rehearsal of the same scripts first.
- The write migration would be attempted as anything other than a **Supabase migration/owner-role** execution via the CLI after approval (see §8b) — e.g. through an app action, or using the app's `service_role` **secret API key** (which must never be used at runtime). Any `DELETE` is also a no-go (this migration deletes nothing).
- The re-seed code change (adding the 4 new keys to `REPORTABLE_CATEGORY_KEYS`) is not yet merged, which would leave new categories seeded-but-unselectable.

## 12. What can be tested safely BEFORE any migration

- **The dry-run report** itself — read-only, run on staging now, zero risk.
- **Staging rehearsal:** run the full seed + back-fill scripts **on staging** (which already mirrors the schema and has only test data), verify counts, verify the app still reads/writes, then practise the rollback. This is the dress rehearsal that de-risks production.
- **App behaviour with mixed data:** Slice 1 is already live and handles legacy categories + legacy accountability values gracefully (display, retention, validation all tolerate them), so you can confirm nothing is broken pre-migration.
- **Retention spot-check:** capture a photo on a legacy `guest_damage` flag on staging and confirm it still receives `dispute_evidence`.

## 13. Code-only vs data-migration

**Already done (code-only, live):** Report Issue wording; category/accountability split in the app layer; field picker excludes accountability/disposition categories; retention re-derivation (incl. legacy-key handling and `security_access_evidence`); optional accountability field; double-submit guard.

**Still code-only, pairs with the migration (small):** add the 4 new keys to `REPORTABLE_CATEGORY_KEYS` + their display entries in `flag-category.ts`, so the newly-seeded categories appear in the form.

**Requires data migration (this plan, gated on approval + PITR):**
1. Re-seed `flag_categories`: add `linen_towels`, `access_keys_lock`, `appliance_furniture`, `guest_incident`, `legacy_uncategorised`; relabel `condition_note`; set `is_active = false` on the 5 legacy keys.
2. Back-fill existing flags pointing at deactivated categories → `legacy_uncategorised` + accountability/disposition.
3. (Optional) promote-only retention class on affected photos where the new derivation is stronger.

**No structural schema change** is required — every field already exists and `flag_category_id`, `chargeable_party_decision`, `status`, `retention_class` are governed in code, not DB constraints.

---

## Recommended sequence (when you decide to proceed — not now)

1. Confirm PITR + restore rehearsal (§8).
2. Merge the small code change adding the 4 new keys to the reportable list.
3. Run the dry-run on staging; ops signs off the mapping.
4. Rehearse seed + back-fill + rollback on staging.
5. Only then: ask for explicit approval to create the migration file and run on production, with the pre-run export in hand.
