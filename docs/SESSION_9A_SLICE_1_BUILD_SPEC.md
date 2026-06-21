# SESSION_9A_SLICE_1_BUILD_SPEC.md

**Type:** Build specification — Session 9A, Slice 1 (no code in this document)
**Date:** 2026-06-21
**Status:** Draft for review. Coding begins only after this spec is reviewed and the `FIVE_ADVISOR_SIGN_OFF` no-go gates are green.
**Source docs:** `docs/APP_AUDIT_2026-06.md`, `docs/PRE_9A_DECISION_MEMO.md`, `docs/FIVE_ADVISOR_SIGN_OFF_2026-06.md`, and the deep-research readiness report.

> Slice 1 = the foundational redesign: **"Report Issue"** wording, **split issue category from accountability**, demote Follow-up / Record-only to dispositions, and **re-derive photo retention from category + accountability + state**, delivered behind a reversible backfill. Nothing downstream (QC-fail report, maintenance/inventory UIs, readiness dashboard, Asana, owner portal) is in this slice.

---

## 1. Current problem

- **The category dropdown mixes two different things.** `flag_categories` contains both *issue types* (maintenance, cleaning, inventory, safety) and *accountability concepts* (`guest_damage`, `owner_chargeable`, `company_responsibility`). A user picking "Guest damage" is recording *who pays*, not *what is wrong* — and can only pick one, so information is lost.
- **Dispositions are masquerading as categories.** `follow_up_required` ("Follow-up") and `no_action_record` ("Record only") describe an *outcome/lifecycle state*, not an issue type. Left as categories they pollute reporting and retention.
- **Insider wording.** The user-facing action is "Raise a flag" — insider language; "Raise a ticket" is also wrong (most reports are not maintenance tickets).
- **Retention is coupled to the category key.** `src/lib/photos/retention.ts` derives the retention class purely from category, including `guest_damage` and `owner_chargeable`. If the taxonomy is split without re-deriving retention, **dispute and owner-chargeable evidence is mis-classified for legal retention** — the single most dangerous hidden failure in this slice.
- **No duplicate hint.** Nothing warns a user that an open report for the same problem already exists, risking duplicates (the flag-as-parent rule is locked, but detection is unbuilt).

## 2. Target model

Two independent dimensions plus a disposition, with retention derived from all of it:

- **Issue category (what is wrong)** — a clean, vertical-agnostic taxonomy. Required, single-select, plain language.
- **Preliminary accountability (who may bear cost/responsibility)** — a parallel, optional field defaulting to **"Not sure / needs triage."** Field staff are not forced to decide; managers refine in triage. Editable later; never set as *final* by an inspector or cleaner.
- **Disposition / status (what happens next)** — Needs action (default), Follow-up (recheck next visit), Record only (no action). Not a category.
- **Retention class** — derived from **category + accountability + open/dispute state**, promote-only (routine → dispute), recomputed when accountability changes.

Truth chain stays intact: a user **reports an issue** → the app creates the parent **flag** (internal evidence/control record, table unchanged) → triage refines accountability → downstream **ticket/task/request** is created later (out of scope here).

## 3. Final terminology

| Layer | Term | Notes |
|---|---|---|
| User-facing action | **Report issue** | Replaces "Raise a flag" / "Raise a ticket" everywhere in the UI |
| Internal parent record | **Flag** | `flags` table is **not renamed** in Slice 1 |
| Downstream action | **Ticket / task / request** | Maintenance job, inventory movement, cleaner callback, owner request — created later, not in this slice |
| Who-pays dimension | **Accountability** | Default "Not sure / needs triage" |
| Outcome dimension | **Disposition** | Needs action / Follow-up / Record only |

## 4. Issue category mapping table

**Target issue-category list (the Report-Issue dropdown / tiles):**

1. Maintenance
2. Item missing
3. Item damaged
4. Cleaning / housekeeping
5. Linen / towels
6. Safety
7. Access / keys / lock
8. Appliance / furniture
9. Guest incident
10. Observation / note — a genuine observation worth recording (e.g. a condition note); **not** a catch-all "other" bucket

There is deliberately **no "General / other" field-user category.** An "Other" bucket becomes a lazy default and re-pollutes reporting and retention. Genuine observations use **Observation / note**; messy legacy rows go to a backfill-only review state (below), not into a field category. If a generic bucket is ever needed, it must be **admin-configurable, off by default, and never the encouraged field choice.**

**Legacy → target mapping (drives the backfill):**

| Legacy key (label) | Target category | Implied accountability | Implied disposition | Edge case? |
|---|---|---|---|---|
| `maintenance_issue` (Maintenance) | Maintenance | — | — | clean |
| `cleaning_issue` (Cleaning) | Cleaning / housekeeping | — | — | clean |
| `inventory_missing` (Item missing) | Item missing | — | — | clean |
| `inventory_damaged` (Item damaged) | Item damaged | — | — | clean |
| `safety_urgent` (Safety) | Safety | — | — | clean |
| `condition_note` (Note) | Observation / note | Unknown | Record only | clean |
| `guest_damage` (Guest damage) | **Legacy uncategorised — needs review** | **Guest damage** | Needs action | **review** |
| `owner_chargeable` (Owner-chargeable) | **Legacy uncategorised — needs review** | **Owner — chargeable** | Needs action | **review** |
| `company_responsibility` (Company-absorbed) | **Legacy uncategorised — needs review** | **Company absorbed** | Needs action | **review** |
| `follow_up_required` (Follow-up) | **Legacy uncategorised — needs review** | Unknown | **Follow-up** | **review** |
| `no_action_record` (Record only) | **Legacy uncategorised — needs review** | Unknown | **Record only** (status `no_action`) | **review** |

The five **review** rows are lossy on category (the legacy row never recorded the underlying issue type). They are mapped to a **backfill/review-only state — "Legacy uncategorised — needs review"** — which is **not** a selectable Report-Issue category for field users. The dry-run lists every such flag so ops assign a real category before the state is retired. Their implied accountability/disposition (shown above) is carried across so retention is not weakened while they await re-categorisation.

## 5. Accountability mapping table

**Target accountability list** (free-text column today → expand the allowed values in code; default first):

1. Not sure / needs triage (default)
2. Guest damage
3. Owner — wear & tear
4. Owner — chargeable
5. Company absorbed
6. Contractor / maintenance fault
7. Cleaning team
8. HOA / building
9. Internal operations

**Legacy `chargeable_party_decision` → target accountability:**

| Legacy value | Target accountability |
|---|---|
| `guest` | Guest damage |
| `owner` | Owner — chargeable (ops may refine to wear & tear) |
| `company` | Company absorbed |
| `contractor` | Contractor / maintenance fault |
| `pending_decision` / null | Not sure / needs triage |

**Precedence during backfill:** if a flag's legacy *category* implied accountability (guest_damage / owner_chargeable / company_responsibility) **and** it also has a `chargeable_party_decision`, the explicit `chargeable_party_decision` wins; otherwise the category-implied value is applied. All conflicts are listed in the dry-run for ops review.

## 6. Retention matrix

Replaces the category-only logic in `retention.ts` with derivation from **category + accountability + state**, evaluated in precedence order (first match wins). Promote-only: retention may upgrade toward dispute-grade, **never** downgrade.

| Precedence | Condition | Retention class | Rationale |
|---|---|---|---|
| 1 | Linked to an open/unresolved guest-recovery task, accountability record, claim, or dispute | `dispute_evidence` | Active dispute — must survive routine purge |
| 2 | Accountability = Guest damage | `dispute_evidence` | Feeds OTA/guest dispute pipeline |
| 3 | Accountability = Owner — chargeable | `owner_chargeable_evidence` | Owner billing defence |
| 4 | Category = Safety | `dispute_evidence` | Insurance / legal / safety track |
| 5 | Category = Access / keys / lock | `security_access_evidence` *(new class)* | Security/access events (key handovers, lock changes) — **never** routine |
| 6 | Category = Maintenance **or** Appliance / furniture | `maintenance_before_after` | **Asset & maintenance evidence** — a broken couch, stained headboard, or appliance fault is an asset record, not a routine note |
| 7 | Category = Item missing / Item damaged | `inventory_evidence` | Inventory accountability |
| 8 | Capture context = pre-arrival pack | `routine_pre_arrival` | Readiness proof (durable, ≥6-week floor) |
| 9 | Everything else (Cleaning / housekeeping, Linen / towels, Observation / note; accountability not dispute-grade) | `routine_post_stay` | Operational window only |

Rules: (a) the class is **recomputed when accountability changes** and may only **promote**, never demote; (b) durability floor — `routine_*` retained at least 6 weeks post-checkout, dispute-grade retained until the dispute/claim/audit/owner query resolves; (c) the purge job (future) is retain-by-default and must never delete a pack tied to an unresolved dispute/claim/audit/accountability record; (d) **asset and access evidence is deliberately kept above routine** — Appliance / furniture maps to maintenance/asset evidence and Access / keys / lock to a dedicated security class, so neither falls into the routine window merely because accountability is still unknown.

> `security_access_evidence` is a **new retention class** added to the `RetentionClass` enum. This is **code-only** — `photos.retention_class` is unconstrained `text` (confirmed against the schema), so no migration is needed to introduce it.

## 7. Backfill / dry-run plan (reversible)

Execution is a **data migration requiring explicit founder approval and PITR confidence** before it runs — this spec only describes it.

1. **Snapshot.** Capture the current category distribution; export a human-readable sample of recent flags incl. evidence references. Confirm PITR enabled + a restore rehearsal done (no-go gate).
2. **Ratify the mapping** (sections 4–6) with ops.
3. **Seed new categories + accountability vocabulary** in code; keep legacy `flag_categories` rows **readable** through cutover (do not delete).
4. **Dry-run backfill report (no writes).** For every affected flag: current → proposed category, accountability, disposition, and **resulting retention class**. Highlight the five lossy "review" rows and any category-vs-`chargeable_party_decision` conflicts.
5. **Ops review** of edge cases; record per-flag manual overrides.
6. **Execute** only after PITR/restore confidence. Write changes + an `audit_events` row per flag (append-only history preserved; no evidence altered).
7. **Cutover** the Report-Issue UI + triage/report/retention logic.
8. **Retire** legacy category values only after retention/report queries verify expected output.

**Rollback point:** the pre-backfill PITR snapshot **plus** the reversible mapping (legacy keys retained until step 8). If the dry-run or post-execute checks look wrong, revert via mapping and/or PITR restore on staging before touching production.

## 8. UX definition — the Report Issue screen

Binds to Decision 9 ("Powerful system, simple surface"). The screen must be usable on a phone, under pressure, with no training.

- **Entry:** the Action Centre quick-add tiles (one tap = common category, prefilled) and a primary **"Report issue"** button. Page title: "Report an issue."
- **Progressive disclosure, top to bottom:**
  1. **What's the issue?** — category (tiles or a simple list), plain language, prefilled if arriving from a tile.
  2. **Describe it + photos** — short text + the existing evidence capture. Severity (Low / Medium / High) with a sensible default seeded from the category.
  3. **Who might be responsible?** *(optional, low-prominence)* — accountability, defaulting to **"Not sure / needs triage."** Explicitly skippable; inspectors/cleaners may leave it; managers set it in triage. **Hidden entirely for the cleaner role.**
- **Mobile rules:** 16px form controls (global rule in place); the category select uses `appearance-none` + chevron (already shipped, prevents the iOS slide); tap targets ≥ 44px; minimal typing; **no sideways overflow at 320px**; exactly one brightest primary button ("Report issue") = the next action.
- **Plain language only** — no enum names, no "flag", no "accountability cascade" jargon on the field screen.
- **Role variants:** cleaner sees the simplest path (category + photo + describe; no accountability, no severity decisioning beyond default); inspector sees the full report form; manager-only refinements live in triage, not here.

## 9. Duplicate-prevention rules

- **At report time**, once category + property are known, check for **open** flags on the same property with the same category within a recent window (default **14 days**). If any exist, show a **non-blocking hint**: "There may already be an open report for this — [view]. Add to it, or continue with a new one?"
- **Manual resolution only (v1):** the user may **link/relate** the new report to the existing flag (preserving the locked flag-as-parent rule — child records hang off the parent) or continue creating a separate report. **No automatic merge.**
- **Never suppress Safety.** Safety reports always proceed regardless of duplicates.
- **Cover the add-from-Action-Centre path** too (per the KNOWN_ISSUES dedup risk), so a coordinator and an inspector reporting the same problem see the hint.
- Detection is a hint, not a gate — it must never block a legitimate new report.

## 10. Tests required before merge

- **Build + lint pass** on the founder's machine (cannot run in the agent sandbox).
- **Retention matrix unit tests:** every (category × accountability × state) resolves to the expected class; promote-only invariant holds; dispute-grade is never demoted; accountability change re-derives correctly.
- **Backfill dry-run reviewed:** output matches the ratified mapping; the five lossy rows and all conflicts are surfaced; counts reconcile with the snapshot.
- **Reversibility rehearsed:** legacy keys retained; rollback (mapping revert and/or PITR restore) tested on staging.
- **Cross-tenant isolation test** (negative cases) green — release gate; **no `service_role`** in any pathway; RLS still scopes all new reads/writes.
- **Audit coverage:** every category/accountability/disposition change writes an `audit_events` row.
- **Copy audit:** no "Raise a flag" or "ticket" left in user-facing surfaces; "Report issue" everywhere; no enum names leaked to users.
- **UX checklist** on real devices (smaller iPhone + current iPhone + Android Chrome) across login, Action Centre, Report Issue, evidence capture, report/PDF/share: no sideways overflow / no 2-D scroll at 320px, ≥24×24px targets, accountability optional + defaulted, dropdown does not slide, progressive disclosure working.
- **Retention-at-capture check:** photos written during/after Slice 1 receive the correct `retention_class` under the new derivation.

## 11. Out of scope (explicitly NOT in Slice 1)

- QC-fail / cleaner-callback report.
- Maintenance ticket UI; inventory replacement UI.
- Owner portal and owner-role enforcement (defined in the memo; not built here).
- "Today's inspections" / apartment readiness dashboard.
- Any Asana work (even test projects); PMS adapters; the `external_task_links` model.
- Storage re-platform (R2/S3), immutable prefixes, and SHA-256 hashing / server `received_at` (define-only; not coded in Slice 1).
- Full inspections-engine UI migration — pre-arrival stays on `evidence_packs` for now (durable, unchanged).
- Image annotations / markup overlays.
- Offline capture queue.
- A full disposition-management workflow. **Confirmed: Follow-up and Record-only are NOT categories.** Slice 1 only (a) removes them from the Report-Issue category dropdown and (b) maps legacy rows safely in the backfill — **Record only → existing `status = 'no_action'`**; **Follow-up → a `flag_operational_marks` row with `kind = 'follow_up'`** (no schema change). The richer disposition UI and any new status values remain **deferred**.

---

### Schema impact — confirmed against the repo (Amendment 3)

Verified against the current migrations, **not assumed**:

| Slice 1 field | Stored in (existing column) | Change needed |
|---|---|---|
| **Issue category** | `flags.flag_category_id` → FK to `flag_categories.id` | **No structural change.** Re-seed `flag_categories`: insert the new category keys, set legacy keys `is_active = false` (the `is_active` column already exists, so legacy stays readable and nothing is deleted). This is a **data migration.** |
| **Preliminary accountability** | `flags.chargeable_party_decision` — `text`, **no CHECK constraint** (confirmed) | **No structural change, no migration.** Expanding the allowed values is **code-only** (values governed in app code). |
| **Disposition** | `flags.status` (`text`, no CHECK constraint) and/or `flag_operational_marks` | **No structural change.** Record only = existing `status = 'no_action'`. Follow-up = a `flag_operational_marks` row with `kind = 'follow_up'` (free-text `kind`) — recommended; or a new `status` value (also code-only, as `status` is unconstrained). |
| **Retention class** | `photos.retention_class` — `text`, **no CHECK constraint** (confirmed) | **No structural change, no migration.** Adding `security_access_evidence` and changing the derivation is **code-only.** |

**Is a migration required?** No *structural* migration and **no new columns** — every Slice 1 field maps to an existing column, and `status`, `chargeable_party_decision`, and `retention_class` are all unconstrained `text`, so new values are code-only. The **only** migrations are **data migrations**: (1) re-seed `flag_categories` (add new, deactivate legacy via `is_active`), and (2) the reversible flag back-fill. **Both require explicit founder approval and PITR/restore confidence before execution**, per the hard rules and the no-go gates.

**Code-only work (no migration):** rename the user action to "Report issue"; expand the accountability vocabulary; rewrite `retention.ts` to derive from category + accountability + state (including the new `security_access_evidence` class); add the optional, defaulted accountability field + progressive disclosure to the Report-Issue page; add the duplicate-hint query; handle Follow-up via a `flag_operational_marks` kind.

> Correction to earlier phrasing: the prior "No structural schema change is required" is **true but was too absolute** — it holds only because the relevant columns already exist and are unconstrained `text`. Confirmed above. There *are* two data migrations (category re-seed + back-fill), gated on approval and PITR confidence.
