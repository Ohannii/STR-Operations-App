# SESSION_9A_DRY_RUN_REPORT.md

**Type:** Read-only dry-run report (SQL/reporting only — no writes, no migration)
**Date:** 2026-06-21
**Run against:** the **staging** Supabase project only (`str-ops-staging`)
**Companion:** `docs/SESSION_9A_MIGRATION_READINESS_PLAN.md`
**Run status:** Completed read-only on **staging**, 2026-06-21 — results recorded in each section below; verdict in §10. Data dry-run is CLEAN; **not** yet approved for a write migration (PITR/restore + staging write rehearsal still pending).

> Every statement below is a `SELECT`. **Nothing here writes, updates, deletes, or migrates anything.** Run them in the Supabase **SQL editor** on the staging project (the SQL editor runs as the DB owner, so RLS does not scope the results — you see all staging rows). Copy each query, run it, and record the output in the "Result" box. The migration decision in §10 is made from these numbers.

**Legacy/deactivation categories** referenced throughout: `guest_damage`, `owner_chargeable`, `company_responsibility`, `follow_up_required`, `no_action_record`.

---

## 1. Current `flag_categories` rows

```sql
select key, display_label, severity_default, is_active
from public.flag_categories
where company_id is null
order by is_active desc, key;
```

Expect 11 system rows, all `is_active = true` today. **Look for:** any unexpected rows or any already-inactive system row.

_Result (staging, 2026-06-21): **11 rows, all `is_active = true`.** Matches expectation; no surprises._

## 2. Count of flags per current category

```sql
select fc.key,
       fc.display_label,
       count(f.id) filter (where f.deleted_at is null) as flags_total,
       count(f.id) filter (
         where f.deleted_at is null
           and f.status not in ('closed','no_action')
       ) as flags_open
from public.flag_categories fc
left join public.flags f on f.flag_category_id = fc.id
where fc.company_id is null
group by fc.key, fc.display_label
order by flags_total desc;
```

**Look for:** the overall distribution, and how many flags sit on the 5 legacy categories.

_Result (staging, 2026-06-21): **30 flags total.** Bulk on real issue types (maintenance_issue 15, inventory_damaged 8). Of the 5 legacy categories, only `guest_damage` has flags (3); the other four have 0._

## 3. Count of flags pointing at legacy/deactivation categories

```sql
select count(*) as affected_flags
from public.flags f
join public.flag_categories fc on fc.id = f.flag_category_id
where fc.company_id is null
  and fc.key in ('guest_damage','owner_chargeable','company_responsibility',
                 'follow_up_required','no_action_record')
  and f.deleted_at is null;
```

This is the **total number of flags the back-fill would touch.** On staging this should be small (test data).

_Result (staging, 2026-06-21): **affected_flags = 3.**_

## 4. List of affected legacy categories (which legacy categories actually have flags)

```sql
select fc.key, count(f.id) as flags
from public.flag_categories fc
join public.flags f
  on f.flag_category_id = fc.id and f.deleted_at is null
where fc.company_id is null
  and fc.key in ('guest_damage','owner_chargeable','company_responsibility',
                 'follow_up_required','no_action_record')
group by fc.key
order by flags desc;
```

**Look for:** which of the 5 are actually in use. A legacy category with 0 flags is trivial to deactivate.

_Result (staging, 2026-06-21): only **`guest_damage` (3 flags)** is in use; `owner_chargeable`, `company_responsibility`, `follow_up_required`, `no_action_record` all 0._

## 5. Proposed mapping per affected flag

```sql
select f.id as flag_id,
       fc.key as legacy_category,
       f.chargeable_party_decision as current_accountability,
       'legacy_uncategorised' as proposed_category,
       case fc.key
         when 'guest_damage'           then 'guest_damage'
         when 'owner_chargeable'       then 'owner_chargeable'
         when 'company_responsibility' then 'company_absorbed'
         else null  -- follow_up / no_action: accountability stays "needs triage"
       end as proposed_accountability,
       case fc.key
         when 'follow_up_required' then 'mark: follow_up'
         when 'no_action_record'   then 'status: no_action'
         else 'needs_action'
       end as proposed_disposition
from public.flags f
join public.flag_categories fc on fc.id = f.flag_category_id
where fc.company_id is null
  and fc.key in ('guest_damage','owner_chargeable','company_responsibility',
                 'follow_up_required','no_action_record')
  and f.deleted_at is null
order by fc.key, f.raised_at;
```

This is the exact per-flag proposal ops reviews. Every affected flag moves to the inactive `legacy_uncategorised` holding category, keeping the implied accountability/disposition until a human assigns a real issue category.

_Result (staging, 2026-06-21): **3 rows, all `guest_damage`.** Current accountability = `guest` / `pending_decision` / `null` → all map cleanly to proposed accountability `guest_damage` (none conflicting)._

## 6. Number of lossy rows needing human review

All five legacy categories are **lossy on issue type** (they recorded who-pays or an outcome, never what the issue was), so **every affected flag needs human re-categorisation.** This count therefore equals §3.

```sql
select count(*) as lossy_flags_needing_review
from public.flags f
join public.flag_categories fc on fc.id = f.flag_category_id
where fc.company_id is null
  and fc.key in ('guest_damage','owner_chargeable','company_responsibility',
                 'follow_up_required','no_action_record')
  and f.deleted_at is null;
```

_Result (staging, 2026-06-21): **3** (equals §3). All three are guest-damage flags with **no photos** — a trivial manual re-categorisation later._

## 7. Flags with existing `chargeable_party_decision` conflicts

A "conflict" = an affected flag that already has an explicit accountability that **differs** from what its legacy category implies. (The back-fill keeps the explicit value, but ops should eyeball these.)

```sql
select f.id as flag_id,
       fc.key as legacy_category,
       f.chargeable_party_decision as existing_accountability,
       case fc.key
         when 'guest_damage'           then 'guest_damage'
         when 'owner_chargeable'       then 'owner_chargeable'
         when 'company_responsibility' then 'company_absorbed'
       end as category_implied
from public.flags f
join public.flag_categories fc on fc.id = f.flag_category_id
where fc.company_id is null
  and fc.key in ('guest_damage','owner_chargeable','company_responsibility')
  and f.deleted_at is null
  and f.chargeable_party_decision is not null
  and f.chargeable_party_decision not in ('pending_decision','needs_triage')
  and f.chargeable_party_decision not in (
        case fc.key when 'guest_damage' then 'guest_damage'
                    when 'owner_chargeable' then 'owner_chargeable'
                    when 'company_responsibility' then 'company_absorbed' end,
        case fc.key when 'guest_damage' then 'guest'
                    when 'owner_chargeable' then 'owner'
                    when 'company_responsibility' then 'company' end
      )
order by fc.key;
```

**Ideal result: 0 rows.** Any rows = ops decides which value is correct before the back-fill.

_Result (staging, 2026-06-21): **0 conflict rows** ("Success. No rows returned")._

## 8. Photo retention classes attached to affected flags

```sql
select p.retention_class, count(*) as photos
from public.photos p
join public.flags f on f.id = p.flag_id
join public.flag_categories fc on fc.id = f.flag_category_id
where fc.company_id is null
  and fc.key in ('guest_damage','owner_chargeable','company_responsibility',
                 'follow_up_required','no_action_record')
  and f.deleted_at is null
  and p.deleted_at is null
group by p.retention_class
order by photos desc;
```

**Look for:** dispute-grade evidence already present (e.g. `dispute_evidence` on `guest_damage` flags) — this is the evidence the migration must not weaken.

_Result (staging, 2026-06-21): **0 rows — no photos are attached to any affected flag.** Nothing to weaken._

## 9. Photos whose STORED class is weaker than the new derivation (the critical safety check)

Compares each affected flag's photo's stored `retention_class` against the class the new (category + accountability) derivation would give, using a protection ranking. **Any rows returned = a photo would be under-retained → must be promoted before retiring legacy keys.**

```sql
with affected as (
  select f.id as flag_id,
         coalesce(
           nullif(f.chargeable_party_decision, 'pending_decision'),
           case fc.key
             when 'guest_damage'           then 'guest_damage'
             when 'owner_chargeable'       then 'owner_chargeable'
             when 'company_responsibility' then 'company_absorbed'
             else null
           end
         ) as final_accountability
  from public.flags f
  join public.flag_categories fc on fc.id = f.flag_category_id
  where fc.company_id is null
    and fc.key in ('guest_damage','owner_chargeable','company_responsibility',
                   'follow_up_required','no_action_record')
    and f.deleted_at is null
),
derived as (
  select flag_id,
    case
      when final_accountability in ('guest','guest_damage')   then 'dispute_evidence'
      when final_accountability in ('owner','owner_chargeable') then 'owner_chargeable_evidence'
      -- holding category legacy_uncategorised is not safety/maintenance/inventory/access
      else 'routine_post_stay'
    end as new_class
  from affected
),
cls_rank(cls, r) as (
  values ('dispute_evidence',7),
         ('owner_chargeable_evidence',6),
         ('annual_audit_evidence',5),
         ('security_access_evidence',4),
         ('maintenance_before_after',3),
         ('inventory_evidence',2),
         ('routine_pre_arrival',1),
         ('routine_post_stay',0)
)
select p.id as photo_id,
       d.flag_id,
       p.retention_class as stored_class,
       d.new_class       as new_derived_class
from public.photos p
join derived d   on d.flag_id = p.flag_id
join cls_rank rs on rs.cls = p.retention_class
join cls_rank rn on rn.cls = d.new_class
where p.deleted_at is null
  and rs.r < rn.r            -- stored is WEAKER (lower protection) than the new derivation
order by d.flag_id;
```

**Ideal result: 0 rows** — because the old category-based derivation already classed `guest_damage`→`dispute_evidence` and `owner_chargeable`→`owner_chargeable_evidence`, so existing photos should already match. This query empirically proves it rather than assuming. Any rows = list them; promote those photos (one-way) before proceeding.

_Result (staging, 2026-06-21): **0 under-retained photos** ("Success. No rows returned") — safety check passed._

## 10. Final summary — safe / not safe to proceed

Recorded from the staging run on 2026-06-21. **Proceed only if every box is satisfied.**

| # | Gate | Pass condition | Result (staging, 2026-06-21) |
|---|---|---|---|
| A | Under-retained photos (§9) | **0 rows** | ✅ 0 |
| B | Accountability conflicts (§7) | 0 rows, or all reviewed + resolved by ops | ✅ 0 |
| C | Affected flag count (§3) | Matches expectation; small on staging | ✅ 3 (tiny) |
| D | Lossy review plan (§6) | Ops has a plan to re-categorise the holding-bucket flags | ⏳ trivial — 3 guest-damage flags, no photos; needs a brief ops note |
| E | PITR + restore rehearsal (plan §8) | Confirmed enabled + rehearsed | ❌ not yet done |
| F | Staging rehearsal of write scripts | Done, with rollback rehearsed | ❌ not yet done |

**Recorded verdict (staging dry-run, 2026-06-21):** The **data dry-run is CLEAN** — gates A, B, C are green (0 under-retained photos, 0 conflicts, only 3 affected flags, all guest-damage, with no attached evidence). It is **NOT yet approved for a write migration**, because gates **E (PITR + restore rehearsal)** and **F (staging write + rollback rehearsal)** are still pending. Proceed only after E and F are green and explicit approval is given to author the migration file.

- **SAFE to proceed** only when A and E are green, B/D have an ops plan, and F has been done.
- **NOT SAFE** if §9 returns any rows (under-retention), if conflicts in §7 are unresolved, if PITR is unconfirmed, or if counts are unexpected.

> This report writes nothing. The next step after a clean run is a **staging rehearsal** of the actual seed + back-fill scripts (still not production) — which requires explicit approval to author the migration file.
