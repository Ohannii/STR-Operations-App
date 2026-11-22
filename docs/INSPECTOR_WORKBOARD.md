# Inspector allocations and inspection work

Product decisions: 22 November 2026. This increment implements the allocation
and manual workboard foundation. It is separate from the guided inspection
template engine, Hostaway sync and inventory placement.

## User flow

- Dashboard → inspection work → inspector allocations. Search by estate, unit
  or inspector; filter unassigned apartments; select one or several and save.
- The default allows inspectors and operations managers to reassign apartments.
  Operations managers may enable manager-only reassignment. No approval or
  acceptance step is introduced. Every actual change records old/new inspector,
  actor and time in append-only history; identical saves add no event.
- Managers enter a manual inspection date and optional checkout/next arrival
  times. These are explicitly manual schedules, never inferred live bookings.
- My work shows the current user's allocated-unit jobs and packs they actually
  started or submitted. Managers can see all staff and unassigned work. Opening
  an apartment's scheduled-inspections link lets another inspector cover that
  apartment without changing its permanent allocation.
- The inspector taps Start inspection to open an ordinary pre-arrival photo
  pack. Scheduling alone never starts it. Continue reopens that same pack.
  The normal Save captions and submit pack action completes both the pack and
  its linked scheduled inspection, displayed as **Inspection complete** in the
  Completed list. No second completion button or manager sign-off is required.
  Guest readiness and outstanding issues remain separate.
- A permanent allocation is not a due inspection. Each manually scheduled
  turnover has its own job ID and optional pack ID, even for repeated visits to
  the same apartment. Never infer completion from unit number or calendar date.

## Data and authorization

- Reuse `property_assignments`, with `role_at_property='primary_inspector'`.
  One active primary allocation per property; other assignment kinds remain
  intact. `properties.primary_inspector_revision` rejects stale edits, including
  A → B → A. Bulk changes are atomic and limited to 200 apartments per request.
- `inspection_settings`: per-company manager-only policy, default false.
- `turnover_jobs`: explicit manual schedule and unique pack association.
  A stable client UUID prevents retry duplicates; identical checkout slots are
  unique. Separate same-day checkouts may have separate jobs. Without checkout
  times, one manual job per apartment/day is allowed; cancel a mistaken schedule
  before replacing it. Date-only inspection schedules use South Africa time.
- Existing `evidence_packs.started_by` and `.submitted_by` record actual authors.
  No allocation rewrite occurs on Start or Submit. No new client field can
  impersonate a starter, submitter or audit actor.
- Manager roles: `company_admin`, `gm`, `ops_manager`,
  `maintenance_coordinator`. Inspectors additionally qualify for normal work and
  default open reassignment. Other roles receive no new mutation privileges.
- Only active, appropriate members of the same company may be allocated.
  Unavailable existing assignees remain visible and are flagged for reassignment.
- RPCs authenticate against current membership. Company scope comes from auth
  in server actions and is checked again in SQL. Table writes and public execute
  grants are revoked. Definer functions have a fixed empty search path.
- The existing manager property form's INSERT privilege is narrowed to its
  actual input columns so callers cannot forge the new internal revision.
- All unfinished work is retained; submitted/cancelled work history is limited
  to the last 30 days. Allocation history displays the latest 50 events; the
  complete append-only audit remains stored.

## Existing draft and schedule boundaries

One open pre-arrival draft per apartment remains enforced by the existing unique
index. A scheduled job never silently adopts an unrelated existing draft or
submitted report. Finish an older draft before starting another visit. Start
scheduled work from the work list; ordinary unscheduled packs remain valid but
do not automatically complete an unrelated scheduled job.

Unstarted schedules can be rescheduled or cancelled. Started packs are retained;
this increment does not move or discard their evidence to alter a schedule.
A discarded/deleted linked draft is shown as needing attention rather than as
completed. Reset/relink tooling for those exceptions is a later increment.

## Acceptance and release

Migration: `20261122174325_inspector_workboard.sql`. Review before applying to
the shared staff database. Do not merge or apply an unreviewed production
migration. Deploying these pages before the migration displays a clear pending
setup state and preserves existing flag/pack actions.

Automated checks cover default/manager-only policies, tenant isolation, eligible
assignees, forged requests, atomic bulk failure, stale revisions, schedule
replays, duplicate Start, real caption submission, attribution and unchanged
readiness. `supabase/tests/inspector_workboard.sql` runs inside a rolled-back
transaction on a disposable local database. Never run fixture tests against the
shared staff project. Real two-connection tests additionally exercise competing
allocation saves and concurrent Start requests.

Before rollout, observe an Android inspector and an operations manager:

1. Allocate BL 91 and BV 91 independently; bulk assign, unassign and search.
2. Inspector A is permanent. B opens that apartment's scheduled work, starts a
   pack, uploads photos/captions and uses ordinary Submit. A remains primary;
   B is the actual starter/submitter on both workboards and report.
3. Refresh/reopen a draft, repeat Start, and retry a lost Submit response.
4. Enable manager-only reassignment; an inspector's forged write must also fail.
5. Schedule another turnover for that unit; it must not inherit completion.
6. Verify existing photo capture/retry, PDF sharing and Asana issue reporting.

## Next increments and retained product decisions

Hostaway is not implemented here. Each company must connect independently using
vendor-supported server-side credentials. Read listings and reservations, map
company + property UUID + listing/subunit identity explicitly, and reject
ambiguous/unallocated physical units. Reuse the existing investor mapping.
Never merge BL and BV by unit number or create duplicate apartments. Handle
changed/cancelled bookings, duplicate/out-of-order webhooks, reconciliation,
rate limits, credential rotation and timezone field contracts. A real turnover
trace needs authorized Hostaway access; fixtures are not proof of connectivity.

Inventory beta: first review the current stock sheet and choose one ledger.
Receive reviewed slip lines once, issue to named inspector/unit once, then show
Placed and checked / Still outstanding in the pack. Could not place records a
reason. Save movement answers independently of photo uploads, with safe offline
retry and honest sync state. Preserve item/batch/receipt traceability, confirmed
returns, stock shortages and expected/count/variance until reviewed reconciliation.
Update movement progress/Replaced Date only after confirmed placement. Never
globally complete a shared incident or guest/insurance/owner recovery. Verify
indirect Asana automation before enabling movement writes.

Review metrics follow booking integration: latest valid channel/date/rating,
optional cleanliness context, checkout-month MTD average normalized to 0–10,
count/no-data states and late-review reconciliation. Replacement quick lists
remain backlog. Apple/Google store release requires real mobile packaging,
device/security acceptance, privacy declarations, accounts and store review;
a web deployment alone is not a store release.
