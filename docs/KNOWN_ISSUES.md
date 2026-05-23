# KNOWN_ISSUES.md

## Active issues

None. No code or services exist yet.

---

## Open risks and how we will address them

These are not bugs — they are planning-stage risks that need attention as we move into building. They are listed here so we don't forget any of them once we have code.

### Risk: a "record-only" choice could be used to bury a safety flag — **NEW (Claude logic test, prototype findings)**

- **Priority: Safety**
- The action-needed picker (#8) includes "record-only / no action," and the picker is optional for inspectors (#9). A junior or careless inspector could mark a genuine safety hazard (gas smell, broken lock, exposed wiring) as record-only, dropping it out of the open Action Centre queue.
- **Plan:** A flag whose **type** is `safety_urgent` must NOT be closeable to `no_action`/record-only by an inspector. Safety flags always enter the open queue and notify a manager regardless of the picker. The picker's "record-only" option is suppressed when the flag type is safety. Manager override to close a safety flag is allowed but audited. Add an explicit acceptance test.
- **Reassess:** at v1.0 flag-capture field test. Any path that lets a safety flag silently disappear is a release blocker.

### Risk: editing flags on an already-submitted/reviewed inspection — **NEW (Claude logic test)**

- **Priority: Data / Audit**
- Findings #9/#10 make child actions editable later by managers from the Action Centre, but the parent flag lives on an inspection that may be `submitted`/`reviewed`. We haven't stated whether the flag's own fields (type, description, photos) can change after submit, versus only its child actions.
- **Plan:** Child actions remain manager-editable after submit (that's triage). The flag's evidentiary core (type, description, original photos) becomes **append-only** after submit — you can add a clarifying note/photo (audited) but not rewrite or delete originals, preserving evidence integrity. True edits require the same role gating as reopening the inspection. Document in `FLAG_AND_ACTION_MODEL.md` before building flag-edit UI.
- **Reassess:** before the flag module is built.

### Risk: meaning of "Closed" is a derived display state, not stored — **NEW (Claude logic test)**

- **Priority: Architecture (minor)**
- History distinguishes In progress / Submitted / Reviewed / **Closed** (#5), but `inspections.status` is only `draft | submitted | reviewed`. "Closed" is derived ("reviewed AND all child actions resolved").
- **Plan:** Keep it derived for v1.0 (no redundant column); make the derivation explicit in code and tests. If users later want to close an inspection independent of child actions, add a stored `closed_at` — a one-line migration. Documented in `INSPECTION_WORKFLOWS.md`.
- **Reassess:** after v1.0 real use.

### Risk: offline behaviour of the Asana queue, Evidence Pack, and child-action edits — **NEW (Claude logic test)**

- **Priority: UX / Offline**
- These new manager surfaces may be used on poor signal. We specified offline behaviour for inspection capture but not for these.
- **Plan:** Online-preferred, offline-tolerant: queue child-action status changes locally and sync like drafts; the Evidence Pack/Asana export need photos that may not be cached offline, so show a clear "needs connection to assemble full pack" state rather than a half-empty pack. Specify in `APARTMENT_ACTION_CENTRE.md` / `EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md` when built (v1.1/v1.2).
- **Reassess:** when the Action Centre manager actions are built.

### Risk: duplicate flags from "add flag anywhere" during a concurrent inspection — **NEW (Claude logic test)**

- **Priority: UX / Dedup**
- Finding #14 lets anyone add a flag from the Action Centre any time. If an inspector is mid-turnover AND a coordinator adds a flag for the same problem from the Action Centre, two flags exist for one problem.
- **Plan:** Extend the "possible duplicates" detection (same property + similar type within a short window) to fire across the add-from-Action-Centre path and an in-progress inspection on the same property. v1.0 surfaces the hint; manual merge. Add a test. (`DEDUPLICATION_AND_TASK_GROUPING_RULES.md`)
- **Reassess:** at v1.0 dedup acceptance testing.

### Risk: "Needs Asana" assumes Asana for every company — **NEW (Claude logic test, minor)**

- **Priority: Workflow (minor)**
- "Needs Asana" is a first-class picker option (#8/#11), but Asana is optional and the app is source of truth. For a future company that never used Asana, the option is noise.
- **Plan:** Make the "Needs Asana" picker option and the Asana logging queue a **per-company toggle**, off by default unless Asana transition mode is enabled. Cheap; the child-action type is already optional. Document in `INTEGRATION_ROADMAP.md` when the queue is built.
- **Reassess:** when a second company is onboarded.

### Risk: Evidence Camera Mode on iOS Safari — implementation cost and reliability — **NEW (evidence-camera refinement)**

- **Priority: UX / Architecture**
- The camera-stays-open burst pattern is the single make-or-break UX of v1.0. Android supports multi-capture via the native file input, but **iOS Safari does not** — it requires a custom camera component built on `getUserMedia()` with a manual shutter, in-worker compression, and an IndexedDB-backed capture queue. The founder's primary device is an iPhone, so this is the path that must work. This is more dev effort than a plain file input and carries the usual iOS PWA risks (memory pressure on long sessions, backgrounding killing the stream, no reliable background sync).
- **Plan:** Build the custom iOS camera component early in v1.0, not last. Stress-test 20-photos-in-60-seconds on a real iPhone per `FIELD_TEST_PROTOCOL.md`. Persist the capture queue to IndexedDB on a background tick so a crash or backgrounding never loses photos. Keep sync resume tied to app-foreground (don't promise background sync). If the PWA camera proves unreliable in the field, the fallback is the native file input with single-shot capture (slower but robust) until a later native-shell option is considered.
- **Reassess:** at the v1.0 photo-capture field test. If it fails the 20/60s bar or loses photos, treat as a release blocker.

### Risk: RedRabbit parity is an assumption, not a measurement — **NEW (evidence-camera refinement)**

- **Priority: UX / Product**
- `EVIDENCE_CAMERA_AND_PHOTO_NOTES.md` claims we "match or exceed" RedRabbit on evidence capture. That comparison is built from second-hand description, not hands-on testing. We may be overestimating our parity and missing small, mature ergonomics RedRabbit has refined over years (e.g., capture latency, gesture shortcuts, offline edge cases).
- **Plan:** In the v1.0 field test, use an inspector who has actually used RedRabbit and ask directly "what was faster/clearer there?" Capture the gaps as concrete backlog items rather than assuming parity. Where RedRabbit must clearly be beaten is search and the parent-flag thread (our differentiators), not necessarily every capture micro-interaction.
- **Reassess:** after the first field test with a RedRabbit-experienced inspector.

### Risk: Deduplication discipline degrades if a developer splits child surfaces — **NEW (dedup refinement)**

- **Priority: Architecture / UX**
- The flag-as-parent rule (`DEDUPLICATION_AND_TASK_GROUPING_RULES.md`) is the single most load-bearing architectural decision. It is easy for a future developer — chasing a "show all maintenance jobs" or "issue inbox" feature — to build a parallel top-level surface that lists child records independently. The instant that happens, one real-world problem appears in multiple places again and the product regresses to the Asana/WhatsApp mess it exists to replace.
- **Plan:** The rule is documented as a hard product anchor in `PRODUCT_REQUIREMENTS.md`, `APARTMENT_ACTION_CENTRE.md`, and the dedup doc. **The founder formally approved the flag-as-parent rule as the locked deduplication model on 2026-05-14**, so any future deviation is a deliberate reversal of an approved decision, not a casual implementation choice. `TESTING_CHECKLIST.md` carries explicit acceptance tests ("one broken TV shows as ONE card, search returns ONE result"). `prompts/STAGED_BUILD_PROMPT.md` instructs every build session to confirm flag-as-parent discipline. Any proposed new list surface must justify itself against the rule before being built — child-record lists are allowed only as drill-downs *from* a flag card, never as independent open-task surfaces.
- **Reassess:** at every architecture review, and whenever a new "list of X" surface is proposed.

### Risk: Manual WhatsApp screenshot discipline — **NEW (evidence-vault refinement)**

- **Priority: Operational / Data**
- The MVP guest-notification flow depends on the manager manually capturing a screenshot of the sent WhatsApp message as proof (`recovery_message_proof`). If managers skip the screenshot, the audit/evidence trail loses its value and the team is back to scrolling WhatsApp during a dispute. The discipline relies on people, not the system, because there is no WhatsApp API in MVP.
- **Plan:** Strongly nudge (not silently allow) the screenshot at "Mark sent." Surface a "no proof attached" indicator on the recovery task and in the Evidence Drawer so missing proof is visible. The Action Centre deadline widget keeps the task visible until resolved. v1.5+ signed evidence links and/or WhatsApp Business API would remove the manual step entirely — flag as the eventual fix, not an MVP requirement.
- **Reassess:** after the first 30 days of v1.1 guest-recovery use; if proof-attach rate is low, prioritise the v1.5 signed-link flow.

### Risk: Apartment Action Centre clarity — **NEW (operational logic test)**

- **Priority: UX / Adoption**
- The Action Centre is the screen that replaces Asana. If overwhelmed, soup-like, or unclear, the team will fall back to WhatsApp and Asana within a week. The whole "operational source of truth" thesis depends on this surface being usable.
- **Plan:** `APARTMENT_ACTION_CENTRE.md` defines section limits (max 7 items per section), plain-language status, role-aware home variants, and stupid-proof UX rules. Real iPhone test on day one of v1.0 with a real inspector. If they don't immediately know what to do next on the screen, the design is wrong.
- **Reassess:** after first real inspector field test (v1.0 acceptance).

### Risk: Approval policy mis-seeding for non-ZA / non-STR markets — **NEW (operational logic test)**

- **Priority: Data / Workflow**
- The seeded Dropinn defaults (R1,000 / R2,000 / R2,000 monthly / R60,000 annual) are tuned for the South African STR market. A future customer in a different market would have wildly different caps. If we don't catch this, the system silently mis-protects them.
- **Plan:** Company Admin sees a banner on first login: "Please review your approval policy before approving any charges." Per-market policy templates added in v1.5. Onboarding script (manual for now) checks policy before going live.
- **Reassess:** when the first non-Dropinn customer is in pipeline.

### Risk: Copy-paste guest-recovery workflow discipline — **NEW (operational logic test)**

- **Priority: UX / Operational**
- The MVP guest-recovery flow asks the manager to copy a template, paste it into WhatsApp, send it, then come back and mark "sent" with a screenshot. If managers forget to mark sent, the deadline dashboard goes wrong. If they fake the screenshot, the audit trail loses value. Discipline relies on the team, not the tech.
- **Plan:** The Action Centre's "Today's recovery deadlines" widget is the daily nudge. Open tasks past deadline turn red and surface across portfolio. After 7 days unresolved, GM is alerted. v1.5+ may add WhatsApp Business API integration to remove the discipline tax.
- **Reassess:** after first 30 days of v1.1 use.

### Risk: Cost recovery leakage across the portfolio — **NEW (operational logic test)**

- **Priority: Data / Financial**
- The founder explicitly named this: "even if a guest does not pay for damage, the owner would need to pay for replacement." Without explicit tracking, costs disappear into the portfolio and the company eats them silently.
- **Plan:** `INVENTORY_AND_MAINTENANCE_LOGIC.md` Part 1.5 defines the no-leakage rule: every `accountability_records` row must reach a `closed` state with `final_chargeable_party` set. Records in unresolved states past 60 days are flagged for manager review. Action Centre surfaces stale recovery items.
- **Reassess:** at v1.1 acceptance and again after first 30 days of real recovery flow.

### Risk: Stupid-proof UX is hard, not free — **NEW (operational logic test)**

- **Priority: UX / Build complexity**
- Defaults, icons, one-tap conversions, plain-language status, single-happy-path per task — these are not polish to add at the end. They have to be built in. Building them correctly costs more dev time than building admin-screen-style UIs.
- **Plan:** `CLAUDE_PROJECT_SKILLSET.md` carries the 12 stupid-proof UX rules as a first-class principle. Every screen review against the rules. If a flow can't be made stupid-proof, the founder is told before it ships.
- **Reassess:** at each stage gate. If the field team needs training to use a screen, the screen has failed.

### Risk: Founder-as-first-customer staging/production discipline

- **Priority: Safety / Data / Workflow**
- The founder runs their own STR operation on the product. Production = real apartments, real owners, real money. Staging = experiments and field tests.
- **Plan:** Two separate Supabase projects (staging and production) with separate photo buckets, set up before v1.0 cutover. Different login email addresses. `NON_TECHNICAL_USER_GUIDE.md` and `TESTING_CHECKLIST.md` carry the safeguards.
- **Reassess:** after first 30 days of real-operation use.

### Risk: Temptation to skip a v1 sub-release

- **Priority: Workflow**
- v1 is staged for safety. Skipping a sub-release breaks the dependency chain — the owner report needs accountability records to roll up; accountability records need approval policy enforcement.
- **Plan:** Each stage has its own acceptance criteria. The recommended `STAGED_BUILD_PROMPT.md` (pending founder approval) would force per-session scope to one stage.
- **Reassess:** at each stage gate.

### Risk: Offline PWA behaviour on iPhone

- **Priority: UX / Architecture**
- iOS Safari has real limitations: background sync is unreliable, push notifications are limited, IndexedDB has quirks under storage pressure.
- **Plan:** Sync runs when the app is foregrounded; UI clearly shows queued items; we never promise invisible background sync on iOS. Dedicated iPhone testing is in `TESTING_CHECKLIST.md`.
- **Reassess:** after first real iPhone tests in v1.0 build phase.

### Risk: Photo storage cost growth

- **Priority: Cost**
- ~60,000 photos/month at scale; compounding over years.
- **Plan:** Client-side compression mandatory, archival policy for >24-month photos (v1.5), Cloudflare R2 migration path if Supabase egress hurts.
- **Reassess:** after first 3 months of real use.

### Risk: Multi-company data isolation

- **Priority: Safety / Data**
- A leak between tenants would be catastrophic.
- **Plan:** RLS on every table from day one; explicit cross-tenant test (User A in Company A actively tries to query Company B data via the API and Supabase client) on `TESTING_CHECKLIST.md`; this test runs before every production deploy.
- **Reassess:** every release.

### Risk: Owner-chargeable summary accuracy

- **Priority: Data / UX**
- Owner trust depends on every number being defensible.
- **Plan:** Reports built from structured data only; AI never produces numbers; approvals required; full audit trail; manager review before send. v1 HTML reports must also meet the new presentation quality bar (clean, professional, printable, structured).
- **Reassess:** after first real owner summary is generated in v1.3.

### Risk: Claude usage / context limits

- **Priority: Workflow**
- Mid-session usage caps can interrupt work. This has now interrupted us twice and recovered cleanly both times.
- **Plan:** The doc-driven workflow makes interruptions recoverable. The `SESSION_RESUME.md` prompt was designed for this. The new "save each file as it is finished" rule (now in `CLAUDE_PROJECT_SKILLSET.md`) is the additional safeguard that paid off in the planning sessions.
- **Reassess:** ongoing.

### Risk: Beginner-safe GitHub / Vercel workflow

- **Priority: Workflow / Safety**
- A non-technical founder can break things on GitHub or production with one wrong click.
- **Plan:** `DEPLOYMENT_GUIDE.md` and `NON_TECHNICAL_USER_GUIDE.md` cover the safe patterns. Production deploys only after a checklist passes. Rollback is one click in Vercel.
- **Reassess:** after the first v1.0 deploy.

### Risk: Photo upload reliability under poor signal

- **Priority: UX / Architecture**
- Inspectors work in apartments with weak signal.
- **Plan:** Upload queue with exponential backoff, dead-letter visibility, retry button, clear sync banner. Test plan covers airplane mode, slow 3G, mid-upload connection loss.
- **Reassess:** after first real inspector field test (v1.0 acceptance).

### Risk: Migration mistakes

- **Priority: Data / Safety**
- A bad migration can silently corrupt data.
- **Plan:** Migrations run on staging first, always; one-way migrations get an explicit note in `CHANGELOG.md`; point-in-time recovery enabled on Supabase paid tier before production; backup-before-migration rule now explicit in `DEPLOYMENT_GUIDE.md`; rollback playbook in same.
- **Reassess:** after first production migration.

### Risk: Single-currency assumption

- **Priority: Data / Architecture**
- MVP assumes ZAR (founder-confirmed). A future EU customer with EUR will need multi-currency.
- **Plan:** Numeric `amount` columns; currency handling deferred but not blocked structurally.
- **Reassess:** when the first non-ZAR customer is in pipeline.

### Risk: Single-user-per-company assumption in MVP

- **Priority: Architecture**
- Some operators work for multiple PMCs. The `company_memberships` table is shaped for many-to-many, but the UI assumes one.
- **Plan:** The schema is ready; the UI is not. Add multi-membership UI when there's a real customer need.
- **Reassess:** v1.5+.

### Risk: Service-role key exposure

- **Priority: Safety**
- A leaked service-role key bypasses RLS entirely.
- **Plan:** Server-only env vars; never in client bundles; `.env.local` gitignored; rotate immediately on any suspected leak. **New red-flag rule:** Claude will never ask for the production service-role key — see `DEPLOYMENT_GUIDE.md`.
- **Reassess:** every quarter or on any incident.

### Risk: v1 HTML reports look "draft-grade"

- **Priority: UX / Customer trust** — **NEW**
- v1 ships HTML reports only. If they look like admin screens (raw IDs, no spacing, no print stylesheet), owners will lose confidence and the founder will be embarrassed.
- **Plan:** `REPORTING_REQUIREMENTS.md` has an explicit Clean / Professional / Printable / Structured bar with a validation checklist. `TESTING_CHECKLIST.md` includes a print-quality test.
- **Reassess:** at v1.0 (inspection report) and v1.3 (owner summary) stage gates.

---

## Resolved (closed in operational logic test 2026-05-13)

These were previously identified or implicit and have now been addressed:

- ~~No configurable approval policies~~ → `approval_policies` table added with 4-level scope and three approval ceilings; Dropinn defaults seeded.
- ~~No cost recovery cascade~~ → `accountability_records` extended with cascade fields; `guest_recovery_tasks` + `recovery_attempts` tables added; no-leakage rule documented.
- ~~Pre-arrival inspection wrongly deferred to v1.3~~ → Promoted to v1.0 alongside post-stay.
- ~~Flag taxonomy too thin (OK/Damaged/Missing/Attention only)~~ → Replaced with 11-category taxonomy in `FLAG_AND_ACTION_MODEL.md`.
- ~~No Apartment Action Centre~~ → Designed in `APARTMENT_ACTION_CENTRE.md`; basic version ships in v1.0.
- ~~Uniform photo retention~~ → 7 retention classes added; `retention_class` field on every photo from v1.0.
- ~~No same-day guest damage notification workflow~~ → `GUEST_DAMAGE_RECOVERY_WORKFLOW.md` defines the workflow; ships in v1.1 with copy-paste message templates.
- ~~No weekly owner update~~ → Added to v1.3 in `OWNER_COMMUNICATION_WORKFLOWS.md` and `REPORTING_REQUIREMENTS.md`.
- ~~No annual audit workflow~~ → Seeded as a template type in v1.3 (uses standard inspection mechanics).
- ~~Stupid-proof UX as implicit nice-to-have~~ → Codified as first-class principle in `CLAUDE_PROJECT_SKILLSET.md` (12 rules).

---

## Resolved (closed in founder review 2026-05-12)

These were previously open and have now been answered:

- ~~Currency for MVP~~ → **ZAR** confirmed.
- ~~First paying customer profile~~ → **Founder's own STR operation** confirmed.
- ~~Domain name owned yet~~ → **Not needed yet**; Vercel preview URLs sufficient through build phase.
- ~~OK with no AI features in v1?~~ → **Yes** confirmed.
- ~~OK with HTML-only reports in v1?~~ → **Yes**, with a presentation quality bar attached.
- ~~OK with the Next.js + Supabase + Vercel stack?~~ → **Yes** confirmed.

---

## Lessons learned from this session

- **The doc-driven workflow paid off twice.** Usage caps interrupted us mid-planning *and* mid-finish-the-blueprint. Both times the resume worked cleanly because each file was saved to disk as it was finished. This pattern is now codified as a rule in `CLAUDE_PROJECT_SKILLSET.md`.
- **A founder review session is itself a quality gate.** Re-reading the blueprint with fresh eyes surfaced gaps (no print-stylesheet plan), contradictions (OTA pack labelled "required" but actually v1.5), and over-complexity (one big v1 instead of staged sub-releases). Worth doing once per major phase, not just at the start.
- **Splitting v1 into staged sub-releases is the single biggest risk reduction in this session.** It costs nothing (same total scope) and turns an overwhelming "build all of MVP" into four shippable milestones.
- **The "Claude will never ask for production secrets" rule is a small line of text but a big shield.** A non-technical founder can easily comply with "never paste a secret if asked." Naming the failure mode out loud makes the safe behaviour obvious.
