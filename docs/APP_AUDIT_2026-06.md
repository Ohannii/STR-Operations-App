# APP_AUDIT_2026-06.md

**Type:** Read-only sustainability & scalability audit (point-in-time snapshot)
**Date:** 2026-06-21
**Scope:** Drop-Inn / ARCIS STR Operations Platform — `main` branch, live on Vercel staging
**Purpose:** A serious founder/operator review before scaling further (Session 9A). Direct, not defensive. Nothing was edited, migrated, deployed, or connected to produce this — it is evidence-based on the repository and schema as they stand.

> This document is a snapshot. Decisions arising from it live in `PRE_9A_DECISION_MEMO.md`.

---

## Headline verdict

The foundation is genuinely strong where it is hardest to retrofit — multi-tenant Row-Level Security, an audit trail, durable evidence capture, and a schema that already anticipated the entire roadmap — and thin only where you simply have not built the UI yet. **The biggest risks are not bugs. They are three structural decisions to settle on paper before writing more code:** (1) the relationship between the *inspection* event and the *durable evidence pack*, (2) roles that are modelled but not enforced, and (3) a flag taxonomy coupled to legal photo-retention. None of these requires a rewrite.

**What "bulletproof" must mean for this product** (the bar this audit measures against):

1. Tenant isolation is provably tested, not just believed.
2. Evidence is **durable, immutable after sign-off, retained per policy, and defensible** (chain of custody) — because protecting assets and winning disputes is the core value.
3. Permissions enforce *who* may touch accountability, owner-sensitive, and close/sign-off actions — server-side, not just hidden in the UI.
4. The core product never depends on any external tool (Asana, a PMS, WhatsApp). Those are adapters.
5. The model is vertical-agnostic so STR → long-term rental → construction snagging is configuration, not a rebuild.
6. Backups / point-in-time recovery are confirmed enabled before production.
7. Field capture never loses evidence, even offline or if a tab closes.

The app meets #1 and #2 substantially, partially meets #4, and has clear, affordable paths to the rest.

---

## UX non-negotiables — "Powerful system, simple surface"

A binding product principle, equal in weight to tenant isolation and evidence durability: the system may be sophisticated underneath, but **every screen a staff member touches must feel obvious and require no training.** This protects the product from its own ambition — inspections, accountability, owners, cleaners, maintenance, and integrations can make an app powerful *and* unusable if simplicity is not defended explicitly.

Per role, the surface stays narrow: **cleaners** get a simple checklist + report-issue flow; **inspectors** get inspections, report-issue, evidence, and readiness; **managers** get exceptions, readiness, unresolved work, and decisions; **owners** get a calm, view-only portal. Field users never see configuration — **adaptability lives in the admin/setup layer; field users get one obvious workflow.** Defaults are sensible, lists collapse past ≈7 items, language is plain English (never enum names), the brightest button is always the next action, and every screen answers "what do I need to do now?" The app must not feel like Asana, Excel, or a database; every sophisticated workflow should feel like a guided step-by-step assistant.

This reframes the definition of done: the app is not finished when it *works* — it is finished when a new cleaner can use it on a phone, under pressure, with no training. (Aligns with `APARTMENT_ACTION_CENTRE.md` and the 12 stupid-proof rules in `CLAUDE_PROJECT_SKILLSET.md`; the full fifteen-rule list lives in `PRE_9A_DECISION_MEMO.md`, Decision 9.)

---

## 1. Current product state

**Genuinely working (live on staging).** Supabase-SSR auth with cookie sessions and the PKCE callback; company onboarding (`create_company_with_admin`); the dashboard with real company-scoped counts; the Apartment Action Centre; raise-flag with triage and operational chips; the flag detail page with reopen and the guest-recovery workflow; the evidence camera (iOS `getUserMedia` + gallery fallback + on-device compression + signed-URL direct upload); evidence packs (start / submit / discard / history); flag and pack reports (print / PDF / share); SAST timestamps; and the mobile-overflow hardening.

**Partially wired.** Guest recovery works but depends on manual WhatsApp + screenshot discipline; operational chips such as `asana_pending` exist but drive nothing yet and are not auto-applied; flag-level `chargeable_party_decision` works, but the `accountability_records` cost-recovery cascade is schema-only.

**Schema-only (designed, no UI yet).** The full inspection engine (`inspections` + `inspection_sections` + `inspection_items` + `inspection_templates` + template sections/items); `inventory_items` / `inventory_movements`; `issues` / `maintenance_jobs`; `approval_policies` / `approval_decisions`; `owner_monthly_summaries`; `weekly_status_updates`; `property_owner_links`; `stays`.

**Risky or confusing.** (a) Two parallel "an inspection happened" representations — the rich `inspections` tables versus the `evidence_packs` you actually ship on; (b) `flag_categories` conflates *what the issue is* with *who pays*; (c) roles are stored but unenforced; (d) capture is in-memory only, so closing the tab mid-batch loses photos; (e) retention class is derived from category keys that the planned redesign will move.

---

## 2. Architecture & scalability

**Data model.** Normalised; `company_id` on every table; pervasive soft-delete (`deleted_at`); `updated_at` triggers; an `audit_events` trail. Disciplined, sound design.

**RLS / multi-tenant.** All 34 tables have RLS enabled, gated through `is_company_member()` — which is `security definer`, `stable`, with `search_path` pinned to `public`, so it is not vulnerable to search-path injection. This is the strongest part of the app and the hardest thing to add later; it was done right early. **Caveat:** the explicit cross-tenant test (a user in Company A actively querying Company B) is on the checklist but has not been run or automated. That is a hard gate before any second company touches the system, and it should live in CI.

**Roles & permissions.** Six roles are seeded — `company_admin`, `gm`, `ops_manager`, `inspector`, `maintenance_coordinator`, `maintenance_tech` — and `role_key` rides on every membership, but **nothing reads it for authorization.** Policies scope by company only. Today every company member can do everything within their company. Two concrete gaps surfaced by the founder's clarification: there is **no `cleaner` role seeded**, and there is no enforcement of the cleaner/inspector distinction the operation actually needs (cleaners may sign off cleanliness and raise/report issues, but must not set final accountability or close owner-sensitive items). A third gap: there is **no `owner` role**, and owner access is a fundamentally **different scoping model** — per-property via `property_owner_links`, not per-company-membership — so a future view-only owner portal needs its own RLS path, not a tweak to `is_company_member()`. These are both SaaS gaps and asset-protection gaps.

**Multi-company / SaaS.** The schema is multi-company-ready (`company_memberships` is many-to-many); the UI is single-company (it picks the oldest active membership). Isolation is sound. The road to SaaS is real but needs: role enforcement, a company switcher, per-company onboarding/seeding (the approval-policy banner is already planned), and the cross-tenant test in CI.

**Sustainability.** "Schema ahead of UI" is a genuine asset — but the `evidence_packs`-vs-`inspections` relationship must be defined deliberately (see §3 and the decision memo), or the two will drift.

---

## 3. Inspection workflow readiness

- **Checkout inspection:** schema-ready (`inspections.template_kind` + `outgoing_stay_id`), no UI. Today "checkout work" happens as flags raised from the Action Centre — functional, but not a structured inspection event.
- **Pre-arrival inspection:** currently produced as an `evidence_packs` photo pack rather than a checklist-driven inspection. It proves "ready + photos" but has no structured QC items or readiness gate.
- **Minimum required pre-arrival:** satisfied today by the pack flow.
- **QC fail / cleaner callback during an in-progress pre-arrival:** **not built.** The `inspections` table already has the exact fields for it — `ready_for_next_guest` + `ready_blocker_reason` — but they are unused because pre-arrival runs on `evidence_packs`. Net-new work.
- **Annual audit / follow-up:** an annual audit is just another `inspection_templates` row (`template_kind`); schema-ready, no UI. Follow-up is currently a flag category.
- **Apartment readiness / "Today's inspections":** not built — and the dashboard currently **hardcodes "Last inspection: Never"** on every property card. The team has no at-a-glance "is this apartment ready for the next guest?" view. Readiness should be a **derived, reservation/date-aware** state computed per turnover (never a stored "green forever" flag), driven by the latest pre-arrival inspection's `ready_for_next_guest` / `ready_blocker_reason` plus open arrival-blocking items plus the next check-in date. Baseline model defined in the decision memo (Decision 8).

**Reframing the model (per founder clarification).** The right shape is:

- **Inspection = the canonical operational workflow/event** — the structured "what happened": a checkout, a pre-arrival, a tenant ingoing/outgoing, a snagging round. It owns checklist items, pass/fail, and the readiness gate.
- **Evidence pack = the durable evidence/report output** attached to an inspection (or to a flag, QC fail, claim, audit, or maintenance issue). **It is not temporary.** A pre-arrival pack is a defensible record that may need to be retained for at least six weeks after checkout, and often much longer for disputes, owner queries, guest claims, audits, maintenance evidence, or company policy.

The only thing that is "interim" is the *current v1 UI implementation*, where pre-arrival packs exist standalone and are not yet linked to a formal `inspection` record. That is an implementation gap to close — **not** a statement about their importance or lifespan. The photos table already supports this dual life (a photo carries both `evidence_pack_id` and `flag_id`); the durable-pack model formalises it.

---

## 4. Flags & issue model

This is the best-architected part of the domain. The flag-as-parent rule is real and consistent: `issues`, `maintenance_jobs`, `inventory_movements`, `accountability_records`, and `guest_recovery_tasks` all carry `parent_flag_id`. "One real-world problem = one flag; children hang off it" is enforced by schema shape, not just documentation.

- **Category vs accountability:** conflated in `flag_categories` today (`guest_damage`, `owner_chargeable`, `company_responsibility` are accountability, not issue types). The flag already has a separate `chargeable_party_decision`, so the redesign is mostly code + reseed + back-fill.
- **Duplicate prevention:** the flag-as-parent rule is founder-locked (good anchor); duplicate *detection* is not built.
- **Follow-up / reopen / failed-fix:** reopen is built; follow-up is a category; failed-fix has the bones (`issues.verified_at`) but no UI.
- **Critical interaction — retention is coupled to the taxonomy.** `retention.ts` derives the photo retention class from category keys, including `guest_damage` and `owner_chargeable`, which the redesign moves to *accountability*. If the taxonomy is split without updating the retention mapping, dispute and owner-chargeable evidence gets mis-classified for legal retention. **The retention rule must be re-derived from category + accountability together.** This is the single most important downstream dependency of the Raise Flag redesign and a direct asset-protection concern.

**Terminology (product decision).** The user-facing action should read **"Report issue"**, not "Raise a flag" and not "Raise a ticket" — most reported issues are not maintenance tickets (they may become an inventory replacement, a cleaner callback, an owner request, an evidence record, or record-only). Keep three distinct layers: **"Report issue"** is the user action; **"Flag"** stays the internal parent evidence/control record (table not renamed); **"ticket / task / request"** is the downstream action created from it. See decision memo, Decision 7.

---

## 5. Photo & evidence storage (durable evidence)

- **Storage.** One private `evidence-photos` bucket with size and MIME limits and company-scoped object RLS; reads via signed URLs; **no DELETE policy** (objects orphan on soft-delete — documented; acceptable now, needs a cleanup job eventually).
- **Thumbnails.** On-device canvas (master ~1600px / q0.72, thumb 400px), deliberately avoiding Supabase's per-request transform pricing. Smart and cost-scalable.
- **Retention.** Seven classes, written correctly at capture — but promotion and purge are deferred, so **storage grows unbounded until a lifecycle job exists.** Given the durability requirement (≥6 weeks minimum, indefinite for disputes/claims/audits/owner-chargeable/maintenance), the lifecycle job must be **retain-by-default and purge-only-when-provably-safe**: it must never delete a pack tied to an open or unresolved dispute, claim, audit, owner query, or accountability record, and retention promotion must remain one-way (routine → dispute).
- **Backup / DR.** Depends on the Supabase plan (point-in-time recovery on a paid tier) — an ops decision that must be confirmed before production. Evidence is the product's core asset; losing it is existential, so this is non-negotiable.
- **Upload reliability.** Direct signed PUT bypasses Vercel's body limit (good), concurrency-4, per-file status — but there is **no offline queue, no retry-on-reconnect, no background sync, and capture is in-memory.** For inspectors on weak apartment signal this is the biggest field-reliability risk in the product.
- **Legal-grade integrity (gap to close for "bulletproof").** Submitted packs should be immutable / append-only, and evidence should be tamper-evident. A cheap, high-value addition: store a content hash (e.g. SHA-256) per photo at upload so you can later prove an image was not altered. Note the existing tension: `compress.ts` strips EXIF for privacy, which also removes original GPS/time — the app captures `captured_at` separately, but a verified server-side capture timestamp (and, later, optional device attestation) would harden disputes.
- **Scale.** At the founder's own ~60k photos/month estimate, cost is the lever; compression + client thumbs help; you will need the retention/purge job and likely a Cloudflare R2 path. The architecture is sound; the lifecycle job is the missing piece.

---

## 6. Reporting

**Built:** flag report and pre-arrival pack report — both print / PDF / share, now overflow-safe. **Not built:** the cleaner QC-fail report, owner monthly report (`owner_monthly_summaries` exists), maintenance report (`issues` / `maintenance_jobs`), inventory movement / replacement evidence (`inventory_movements`), and a dedicated guest/OTA evidence pack (today approximated by the flag report + recovery). The reporting infrastructure — server-rendered HTML + print CSS + share/print buttons + signed thumbnails — is reusable for all of them, which is strong leverage. The owner report is the trust-critical one; the rule that AI never generates the numbers is the right guardrail and should be stated in `REPORTING_REQUIREMENTS.md` as a hard constraint.

---

## 7. Integration readiness — the app is the source of truth

**The app already works without Asana.** Asana is not connected; `asana_pending` is just an internal chip. The architecture already matches the founder's principle.

Define the boundary explicitly and build to it:

- **Inbound adapters (feed the app):** PMS / channel managers — Hostaway, Guesty, NightsBridge, and others — push reservations, dates, stays, and turnaround schedules. They create the *occupancy context* and can *trigger* inspections, but the app owns the inspection, evidence, flag, accountability, and report once created.
- **Outbound adapters (the app feeds them):** Asana / Trello (tasks), WhatsApp / Slack / email (reports and notifications), accounting (cost recovery). One-way export first.
- **Invariant:** canonical data — inspections, evidence, flags, accountability, reports — is **never owned by an integration.** Integrations are pluggable adapters behind a stable internal port, so adding Guesty or removing Asana never touches the core.

**Cheap thing to do now:** keep every integration touchpoint behind a thin internal interface. Today `asana_pending` is just a flag; when export is built, model a generic `external_task_links` concept (entity → external system → external id + status), not an Asana-specific column. That one decision keeps Asana genuinely optional and makes Hostaway/Guesty/Slack additive rather than invasive.

---

## 8. Multi-vertical adaptability (STR, estate agency, construction)

The product can serve more than STR if the **inspection** stays vertical-agnostic. The schema already supports this — `inspection_templates.template_kind` plus nullable stay links — so the work is mostly discipline, not new structure.

- **One abstraction, many template kinds:** `str_pre_arrival`, `str_checkout`, `ltr_ingoing`, `ltr_outgoing`, `construction_snag`, `annual_audit`, etc. The engine renders a checklist + evidence; the *kind* is data.
- **Decouple from STR-only concepts.** `stays` (outgoing/incoming guest) is STR-specific. For long-term rentals it is a tenancy/lease; for construction there is no occupancy at all. The stay links are already nullable, which is correct — keep inspections runnable with **no** stay, and treat occupancy as an optional context, not a requirement.
- **Property is generic enough.** For estate agencies a "property" is a let unit; for construction it is a site/plot/unit. The model works; keep user-facing labels configurable per company/vertical.
- **Evidence annotations roadmap (arrows, blocks, markups).** Store annotations as a **non-destructive overlay** (e.g. an `annotations` JSON layer or a `photo_annotations` table) over the untouched master, never baked into the original file. This preserves chain-of-custody (the original is provably unaltered) while letting inspectors mark up a copy — which matters as much for snagging and disputes as for STR.

The takeaway: adaptability is a *naming and discipline* exercise on top of an already-generic core, not a second product.

---

## 9. Technical debt & risks

**Fix or decide before building more:** (1) define the inspection ↔ durable-evidence-pack relationship and document it; (2) decide the role-enforcement posture, including adding a `cleaner` role and the cleaner/inspector permission split; (3) run the cross-tenant isolation test (release gate); (4) update the retention-mapping plan for the category/accountability split and the durability windows.

**Document:** the inspection/evidence decision; the permission matrix; the integration port/adapter boundary; the taxonomy back-fill mapping; the retain-by-default purge rules.

**Delay:** full inventory/maintenance UIs, owner/annual reports, approval-decision enforcement, offline-first, live Asana/PMS connections.

**Remove or demote:** the already-deprecated `inspections.stay_id`; "Follow-up" and "Record only" as *categories* (they are really statuses/dispositions). Do **not** demote `evidence_packs` — reposition it as the durable evidence/report container.

**Standing risks (still valid):** manual WhatsApp screenshot discipline; no offline queue; unbounded photo storage until the lifecycle job exists; PITR not yet confirmed.

---

## 10. Five-advisor review

**Contrarian — what are we overbuilding?** The schema is over-built ahead of the UI (34 tables, ~10 surfaced). The risk is building UI for all of it and never shipping. Delay owner summaries, weekly updates, approval *decisions*, and annual audit until there is real pull. Do not build inventory + maintenance + Asana at once.

**First Principles — the real operating system without Asana.** Property → inspection event → flags (one per real-world problem) → child records (issue / maintenance / inventory / accountability) → durable evidence (photos + packs) → reports. That chain must stand alone; Asana, WhatsApp, and any PMS are adapters at the edges. The app already embodies this via `parent_flag_id` everywhere — protect it.

**Expansionist — 500+ units, multi-estate, multiple clients, new verticals.** The schema scales; the gaps are enforcement and lifecycle: role enforcement, a company switcher, per-company templates/policies/inventory catalogs (schema supports this via `*_template_overrides` and `approval_policies`), a retain-by-default retention/purge job, R2 for egress, vertical-agnostic inspection kinds, and the cross-tenant test in CI.

**Outsider — a new company that never used Drop-Inn's Asana.** They would expect to onboard, define properties + inventory + a checklist, run phone inspections, and get owner/cleaner reports, with no Asana. Today they would hit no inspection-checklist UI, no inventory/owner/maintenance reports, Drop-Inn-tuned approval defaults, and a category list with Drop-Inn accountability baked in. Genericising = the inspection engine + configurable taxonomy/policies + the role split.

**Executor — smallest slice, most pain relief, least debt.** The QC-fail cleaner report is the highest daily-pain reducer and reuses the report infra with near-zero schema change — but it should be built on the *durable evidence pack tied to an inspection*, not as another standalone artefact, so it strengthens the model instead of forking it. Debt-aware order: settle the inspection/evidence + roles decisions (a memo, this session) → Raise Flag category/accountability split (foundational) → QC-fail report on the durable-pack model.

---

## 11. Final recommendation

**Do not jump straight into Session 9A coding.** Spend one short, focused session ratifying the decisions in `PRE_9A_DECISION_MEMO.md` — they are cheap now and expensive to unwind later. Then build, in this order:

1. **Raise Flag redesign** — category/accountability split + default operational marks + duplicate hint (foundational; unblocks everything downstream and fixes the form that confuses today).
2. **QC-fail cleaner report** on the durable-evidence-pack model (highest daily pain; reuses report infra).
3. **Maintenance ticket + inventory replacement** — wiring existing tables (`issues`, `maintenance_jobs`, `inventory_movements`) to flags.
4. **Asana test-project mapping** — one-way, behind a generic integration port; PMS inbound adapters later.

**Do not build yet:** owner monthly/annual reports, approval-decision enforcement, full offline-first, and any live Asana/PMS connection — each needs real pull or one of the memo decisions first.

**Is the foundation strong enough to scale and to be bulletproof?** Yes — provided three things are closed first: the cross-tenant isolation test, the role-enforcement posture (including the cleaner split), and the inspection ↔ durable-evidence model. None of these is a rewrite. They are decisions and targeted wiring on top of a schema that already saw this coming.
