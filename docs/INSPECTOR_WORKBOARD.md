# Inspector allocations and inspection work

Product decisions: 22 November 2026. This increment implements the allocation
and manual workboard foundation. It is separate from the guided inspection
template engine, Hostaway sync and inventory placement.

## Release requirement: automatic checkout work

Anni confirmed during the phone review that staff have no capacity to schedule
routine inspections manually. This foundation is not an acceptable routine
workflow until Hostaway generates the work automatically. Manual scheduling is
only a test/exception tool; do not ask inspectors or managers to enter each
turnover, checkout or arrival date as normal daily administration.

For each Hostaway checkout, match the company/account and exact physical
listing/subunit to the existing property UUID, then create or update one
turnover work item. Put it on the apartment's primary inspector work list;
unassigned work is visible to the operations team and inspectors. Show the departing
guest from the checkout reservation, checkout time and next arrival when
available. Keep outgoing and incoming guest identities distinct. Missing data
must remain visibly unknown rather than guessed.

The inspector still starts the inspection. Submitting its linked pre-arrival
pack completes that visit, without a second completion or acceptance step.
Booking changes/cancellations, sync retries and duplicate webhooks must not
duplicate jobs, rewrite completed evidence, or mark guest-ready. BL/BV units
with the same number must never collide. Each company connects Hostaway
independently through secure server-side onboarding; no secrets in chat, source
control, public URLs or application logs.

Keep PR #74 in draft while its foundation is independently reviewed. Completing
a manually scheduled test does not establish acceptance of the intended
automated workflow. Hostaway connection, one real mapped turnover and the
inspector-led start/submit flow must be demonstrated before routine rollout.

## User flow

- Dashboard → inspection work → inspector allocations. Search by estate, unit
  or inspector; filter unassigned apartments; select one or several and save.
- The default allows inspectors and operations managers to reassign apartments.
  Operations managers may enable manager-only reassignment. No approval or
  acceptance step is introduced. Every actual change records old/new inspector,
  actor and time in append-only history; identical saves add no event.
- The current foundation includes manual date/checkout/arrival fields for
  controlled tests and exceptions only. Routine work must come from Hostaway.
- My work shows the current user's allocated-unit jobs, packs they actually
  started or submitted, and open work without an available primary inspector.
  This shared unassigned pool does not claim or reassign an apartment when
  someone starts it. Managers can also see all staff and unassigned work. Opening
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
submitted report. Submit or discard an older unrelated draft before starting
another visit. The apartment's primary Start button starts the earliest
unstarted inspection due today or overdue (South Africa date); stale ordinary
Start forms follow the same rule and guarded RPC. Future-dated visits do not
capture today's ordinary pack. Upcoming work remains visible on its dated
workboard card and can still be explicitly selected there. Ordinary unscheduled
packs never automatically complete an unrelated scheduled job.

Unstarted schedules can be rescheduled or cancelled. Started packs are retained;
this increment does not move or discard their evidence to alter a schedule.
A discarded/deleted linked draft is shown as needing attention rather than as
completed. Managers can cancel that visit, preserving the discarded pack/link
and audit trail, then schedule a replacement. They cannot reschedule/relink
discarded work or cancel a live/submitted pack through these controls.
The apartment itself shows the discarded inspection and manager cancellation
in place of ordinary Start. Stale ordinary Start submissions also refuse to
create an unlinked pack while that due inspection needs cancellation.
Cancellation is a compact secondary control on both the apartment and
workboard. Selecting it only opens a native confirmation
dialog naming the apartment and date; Keep inspection receives initial focus.
Only explicit confirmation sends the request. The dialog freezes while saving,
and repeats/double taps are single-flight. Its default/cancel paths never write.

The apartment screen uses a visible teal inspection panel and primary action,
amber recovery panel, and a compact confirmed cancellation control. Discard
is disclosed under More inspection options with a scheduled-recovery warning.
It states the next step: take photos, then review/report issues and submit.
The workboard puts job cards before summaries, allocations and manager-only
setup information. A compact view selector and conditional search preserve
filtering. It uses explicit status labels as well as colour, with manual test
creation below the work list. After a linked submission, the exact server-proven
visit shows Inspection complete and leads back to work; another Start is
secondary. Offline and lost-response Start failures remain inline and retries
reopen the same guarded visit. See `INSPECTOR_UX_WALKTHROUGH.md` for the persona
walkthrough and independent review brief. Zero-only
snapshot cards and implementation-roadmap copy are omitted from daily work.
Touch targets remain at least 44 CSS pixels even where the visual control is
small. Native dialog focus/keyboard behaviour still needs device acceptance.

Changing an inspection's due date does not change its recorded guest checkout
or next arrival. The form states this explicitly. Distinct checkout times may
still create separate manual slots on the same day. Hostaway needs its own
reservation identity and reconciliation; date/time uniqueness is not enough.
Foreign keys deliberately retain evidence/creator references: destructive
company/user erasure is outside this increment and must not silently cascade.

## Acceptance and release

Applied foundation: `20261122174325_inspector_workboard.sql` (unchanged).
Applied recovery: `20261122191844_inspection_workboard_recovery.sql`.
Both were applied once on 22 November 2026 after review and Anni's approval.
The recovery file is unchanged from reviewed commit `790f171`; its SHA-256 is
`06d0ba5a60b3c301563c52d1222daa0d9d01d0aff8e04b7deceb86905adb9ddf`.
Its six function bodies, authenticated-only execution, retained table grants
and row security were verified. Existing photo/caption/submit definitions and
business row counts were unchanged; verification created no business records.
The follow-up adds discarded-draft cancellation, shared unassigned visibility
in both RLS and the read RPC, schedule creation audit, and weaker non-key locks
for allocation/policy writers. It adds one guarded boolean helper for available
primary inspectors so caller RLS cannot hide another inspector's membership and
accidentally label their apartment unassigned. Its execute grant is authenticated
only; foreign-company and inappropriate-role calls reveal no allocation.
Existing photo/caption/submit functions are not changed. Review before applying
any future migration to the shared staff database; do not merge an unreviewed migration.

Automated checks cover default/manager-only policies, tenant isolation, eligible
assignees, forged requests, atomic bulk failure, stale revisions, schedule
replays, duplicate Start, real caption submission, attribution and unchanged
readiness. `supabase/tests/inspector_workboard.sql` runs inside a rolled-back
transaction on a disposable local database. Never run fixture tests against the
shared staff project. `scripts/tests/inspection-database.mjs` now applies every
repository migration verbatim to a fresh disposable database and runs that SQL
suite plus real multi-connection tests. A test-only trigger holds the real Start
RPC after its property lock to reproduce the allocation/FK deadlock ordering;
the fixed allocation and Start must both commit. Additional cases cover
discard/cancel/replacement, unrelated ordinary packs, unassigned/unavailable
visibility through RPC and RLS, A starting/B submitting with the real caption
RPC, duplicate schedules, competing allocations and concurrent Starts.

Run `pnpm run test:inspections:db` with `STR_TEST_DATABASE_URL` pointing at a
**disposable local PostgreSQL 17 server** and a role able to create databases and
test roles. Remote addresses are refused. The runner creates a random database
and drops only that database in cleanup. Minimal local auth/storage schema
fixtures stand in for Supabase services; these tests do not replace GoTrue,
object-byte or phone acceptance. The GitHub Actions workflow
`.github/workflows/inspection-database.yml` runs this on a PostgreSQL 17 service.

Before rollout, observe an Android inspector and an operations manager:

1. Allocate BL 91 and BV 91 independently; bulk assign, unassign and search.
2. Inspector A is permanent. B opens that apartment's scheduled work, starts a
   pack, uploads photos/captions and uses ordinary Submit. A remains primary;
   B is the actual starter/submitter on both workboards and report.
3. Refresh/reopen a draft, repeat Start, and retry a lost Submit response.
4. Enable manager-only reassignment; an inspector's forged write must also fail.
5. Schedule another turnover for that unit; it must not inherit completion.
6. Verify existing photo capture/retry, PDF sharing and Asana issue reporting.
7. Start and discard a test draft; a manager cancels its visit and starts a
   replacement without rewriting the old evidence.
8. Use the apartment's normal Start button with scheduled work and with an
   unrelated older draft. Neither may silently leave a completed visit unlinked.
9. Find unallocated work in an inspector's default list. A starts, B submits;
   check both names on the card and report without changing primary allocation.
10. Sign in after session expiry and return to the requested work/apartment page.
    Repeated query parameters must not crash the work list.

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
