# FIVE_ADVISOR_SIGN_OFF_2026-06.md

**Type:** Governance / sign-off — the final five-advisor review before Session 9A build work
**Date:** 2026-06-21
**Decision required:** Proceed / Proceed with amendments / Hold
**Source context:**
- `docs/APP_AUDIT_2026-06.md` (read-only sustainability & scalability audit)
- `docs/PRE_9A_DECISION_MEMO.md` (nine ratifiable decisions)
- *STR Operations App readiness report for the five-advisor audit and Session 9A* (deep-research report, supplied as context)

> Purpose: scrutinise the current direction and decide whether to proceed to Session 9A Slice 1, amend first, or hold. This document does not change code, schema, or configuration. It converts written direction into a binding go/no-go.

---

## Decisions reaffirmed for this review (the clarifications this sign-off is measured against)

1. **Powerful system, simple surface.** Field users (cleaners, inspectors) must use it on a phone, under pressure, with little or no training. Complexity lives in admin/config and behind-the-scenes logic, never in the field user's face.
2. **Terminology.** User-facing action = **"Report issue"** (not "Raise a flag", not "Raise a ticket"). "Flag" stays the internal parent evidence/control record (tables not renamed). "Ticket / task / request" = downstream action.
3. **Category vs accountability.** Issue category = *what is wrong*; accountability = *who may bear cost/responsibility*. Guest damage, owner-chargeable, company-absorbed, wear-and-tear, cleaner callback, contractor fault, unknown/needs-triage are **accountability**, not categories. The Report-Issue UI must stay simple.
4. **Inspection model.** Pre-arrival is the minimum operational requirement; checkout is valuable but not always possible. Evidence packs are **durable retained outputs**, not disposable — and may be needed long after six weeks when tied to a dispute, owner query, claim, maintenance history, or audit.
5. **QC fail / cleaner callback.** Generatable mid-inspection, easy to send to cleaners (WhatsApp today), and it must **not** break the inspection flow — the inspector continues and later marks ready.
6. **Readiness.** "Today's inspections" is date/reservation-aware; never "green forever"; on arrival day an apartment is not ready until the readiness check completes; with no check-in, show last readiness state with date context.
7. **Integrations.** The app stands on its own. Asana is an **optional outbound adapter** (test projects only, no live writes yet). PMS systems (Hostaway/Guesty/NightsBridge) later feed reservation/turnover dates inbound but never own inspection truth.
8. **Future verticals + annotations.** Model stays adaptable for STR, estate agency / long-term rentals, and construction snagging. Future image annotation preserves the original master and stores arrows/blocks/markups as non-destructive overlays.

---

## Advisor 1 — Contrarian

**Main concern.** The biggest risk is building a clever ops brain before the field-user surface is simple enough — becoming "Asana-with-photos." Several planned surfaces (full readiness dashboard, owner portal, maintenance/inventory UIs, Asana) are schema-first luxuries, not the immediate operator painkiller. "Follow-up" and "Record-only" are sitting in the category dropdown but are really *dispositions* — leaving them as categories pollutes reporting and retention.

**What must be amended.** Reclassify "Follow-up" and "Record-only" as dispositions/statuses, not issue categories. Cut Session 9A to a single foundational slice. Make the Report-Issue surface visibly simpler than today's Raise Flag form.

**What must not be built yet.** Asana integration; the full readiness dashboard; maintenance and inventory UIs; owner portal. None of these reduce daily pain until the foundation (Report Issue → category/accountability split → duplicate prevention → retention) is right.

**Verdict: Proceed with amendments.**

---

## Advisor 2 — First Principles

**Main concern.** The app is only independently valuable if its truth chain stands without Asana or any PMS. That chain is **Inspection → Issue → Evidence → Action → Readiness.** The danger is letting an external tool (Asana today, a PMS tomorrow) quietly become the system of record for any link in it.

**What must be amended.** Write a one-paragraph source-of-truth statement and a "never outsource this" list into the Slice 1 spec. Mark which actions are **append-only or server-authorised** because they change liability or proof: evidence submission, accountability decisions, flag close/sign-off, and report generation. UI gating is not enough for these — the server is the authority.

**What must not be built yet.** Any inbound integration that creates or mutates inspection/evidence/accountability records directly. Inbound data (reservations) may *trigger* work; it must not *own* it.

**Verdict: Proceed with amendments.**

---

## Advisor 3 — Expansionist

**Main concern.** What breaks first at 500+ units, multiple clients, and new verticals is enforcement and lifecycle, not schema. Specific risks: roles modelled but unenforced; no retention/purge lifecycle job (storage grows unbounded); evidence egress/cost at ~60k images/month; readiness rules that assume STR turnovers; and Drop-Inn-specific defaults baked into seeds.

**What must be amended.** Produce a scaling-risk list with red/amber/green ratings for tenancy, storage, roles, readiness, and integrations. Commit to an **object-storage abstraction** now (keep Supabase operationally; decide later which evidence classes move to R2, and which dispute-grade classes may need S3 Object Lock / R2 bucket-lock immutability). Make all vertical/company-specific behaviour **admin-configurable**, never visible to field users.

**What must not be built yet.** Storage re-platforming (keep Supabase for the next six weeks). Per-vertical product forks — keep one engine with configurable templates.

**Verdict: Proceed with amendments.**

---

## Advisor 4 — Outsider

**Main concern.** A new estate agency or construction company would find the product too STR-shaped and too insider-worded. "Raise a flag" is insider language; "guest damage" as a *category* is STR-specific and conflates what-happened with who-pays. They would not know what an "evidence pack" or "operational chip" is.

**What must be amended.** Ship the **"Report issue"** wording. Keep the Report-Issue screen plain-English and short: pick *what's wrong* (category), optionally *who might be responsible* (accountability, default "unknown / needs triage"), describe, photograph — nothing else on the first screen. List the terms and fields that must be **admin-configurable** so a non-STR company can adopt without code (property/unit labels, template kinds, category set, accountability set, inventory catalog).

**What must not be built yet.** Hard-coded STR vocabulary or STR-only flows (stay-required inspections, OTA-only language) in the core engine.

**Verdict: Proceed with amendments.**

---

## Advisor 5 — Executor

**Main concern.** The work must be sequenced so Slice 1 is built once. The single most dangerous hidden failure is **mis-retaining dispute evidence** during the taxonomy migration. Artefacts must exist before code, and the migration must be reversible with a clear rollback point.

**What must be amended.** Adopt this order: (1) this sign-off; (2) one build spec (`SESSION_9A_SLICE_1_BUILD_SPEC.md`); (3) code Slice 1; (4) only then QC-fail report; (5) only then maintenance / inventory / Asana test-project wiring. The Slice 1 migration runs as: snapshot category distribution + sample export → ratify mapping table → seed new categories while legacy stays readable → **dry-run backfill report** (every affected flag, proposed mapping, resulting retention class) → ops review of edge cases → execute **only after PITR/restore confidence** → switch Report-Issue UI + triage/report logic → retire legacy values only once retention/report queries verify. Rollback point: pre-backfill PITR snapshot + the reversible mapping.

**What must not be built yet.** Anything before the artefact pack and the gates below are green.

**Verdict: Proceed with amendments.**

---

## Final sign-off verdict

**PROCEED WITH AMENDMENTS — do not code yet.** All five advisors agree the direction is sound and the foundation is strong; none recommend Hold or a rewrite. The next move is a short, disciplined pre-build programme: ratify the amendments above, complete the gates, produce the artefact pack, then build Slice 1 once.

## No-go items before coding (hard gates — all must be green)

1. **Cross-tenant isolation test matrix** written and run on staging (negative cases: Company A → Company B reads/mutations/signed media; future owner-scoped user → unrelated properties; cleaner-role → out-of-scope actions). No service-role bypass in any app pathway.
2. **PITR confirmed enabled** on production, retention period documented, and a **restore rehearsal** performed on staging/a duplicate (a backup never restored is only a theory).
3. **Role-enforcement posture decided:** enforce the v1 matrix (incl. `cleaner`, and `owner` view-only via `property_owner_links`) server-side, or record an explicit, time-boxed risk acceptance.
4. **Ratified taxonomy mapping + retention matrix:** legacy category → target issue category (+ accountability), and a category × accountability × open/dispute-state → retention-class matrix. Reversible backfill plan with a dry-run report.
5. **Readiness arrival-blocking rules** defined (what makes an apartment "Blocked").
6. **UX pass/fail checklist** (mobile baseline: no sideways overflow / no 2-D scroll at 320px, ≥24×24px targets, progressive disclosure, no "green forever") across login, Action Centre, Report Issue, evidence capture, report/PDF/share, readiness.
7. **No live Asana / no storage re-platform** during Slice 1.

## Required artefacts before Session 9A Slice 1 (the pre-build pack)

1. Taxonomy mapping table (legacy → category + accountability).
2. Category + accountability (+ dispute/open state) → retention-class matrix.
3. Reversible backfill plan (snapshot → mapping → dry-run → ops edge-case review → execute-after-PITR → cutover → retire legacy) with rollback point.
4. Readiness arrival-blocking rule set.
5. Cross-tenant isolation test matrix (negative cases) + one repeatable staging run.
6. UX verification checklist (devices + core flows, pass/fail).
7. Asana **test-project** field map + generic `external_task_links` model (no live writes).
8. Vendor-neutral PMS inbound adapter contract (inbound reservation data, outbound task/report, idempotency).
9. QC-fail / cleaner-callback report requirements spec (identifies property, inspection instance, generated-at, inspector, callback status, block reason; lists only open QC items grouped by room; thumbnails; stable report id; generation is audited).
10. Evidence immutability plan — **define, do not code:** per-photo SHA-256 at upload, server-generated `received_at`, append-only submission for packs/dispute reports, and immutable storage prefixes reserved for dispute/owner-claim/guest-damage/safety/legal classes.

## Recommended next document

**`docs/SESSION_9A_SLICE_1_BUILD_SPEC.md`** — and nothing else before it. It should contain the taxonomy mapping table, the accountability vocabulary (default "unknown / needs triage"), the retention re-derivation matrix, the reversible backfill sequence + rollback point, the "Report issue" UI definition (simple, progressive disclosure), and the Slice 1 test + rollback plan. Only after that document is reviewed does coding begin.
