# ASANA & WORKFLOW ROADMAP / BACKLOG

**Type:** living roadmap. Captures product/workflow feedback so it isn't lost while we operationalise.
**Updated:** 2026-07-11

## Where we are
Merged & working: Asana integration foundation (DB, mapping, outbox, enqueue wiring, guards, provider, worker), first real BETA task verified, **9a** ("Open Asana task" link), **9b** (`issue_title` + human-readable task naming).

**Beta rule:** **App = source of truth. Asana = admin work-board.** One-way app → Asana. Worker is currently manual — operationalising next.

## Immediate operational blocker (do next)
Manual PowerShell worker runs and manual enable/disable are not acceptable for 93 live properties.
→ **Operationalise the worker: automatic scheduled run.** `ASANA_WORKER_DRY_RUN=false` and `integration_settings.is_enabled=true` become **emergency kill switches only**, not part of normal workflow.

## Captured workflow / UX feedback (deferred — not lost)
1. Mobile UI is too noisy.
2. "View details" is too small/easy to miss → the card should be **tap-to-open**, not a tiny chevron/dropdown.
3. Asana logged/pending should be **system-derived** from `asana_task_url` (no manual Asana chips for staff). No `asana_task_url` = "Asana pending"; exists = "Asana logged" + Open link.
4. Triage vs operational status is confusing → needs a cleaner model.
5. Close reason should show **only** when "No action required" / closed-without-action.
6. Maintenance operational statuses candidate: Raised → Assigned → In progress → Ready for inspection → Completed (+ No action required). Recommend the real-world best, don't follow blindly.
7. Field leads update from the app; admin / maintenance / cost-recovery people work from Asana.
8. Two-way / mirrored status sync matters but must not be rushed; app stays beta source of truth.
9. Photos don't feed to Asana yet (expected). Later: app photo **link** in Asana vs actual attachments.
10. Asana naming = title → property → category → guest-charge tag (**done in 9b**).
11. A flag that makes a unit **not guest-ready** needs a clear **red indicator**.

## Proposed slice order (after the operational slice)
- **9c** — derive Asana logged/pending (remove manual chips) + close-reason conditional + red "not guest-ready" indicator.
- **9d** — detail-page reorg into clean zones (classification · status · guidance · evidence · activity).
- **9e** — mobile list = tap-to-open, clean scannable card.
- **9f** — operational status model (extend `flags.status` vocabulary) — the real workflow.
- **Later (gated):** Asana status custom field + inbound mirror; cost-recovery track; photo links then attachments; webhook/real-time freshness.

## Not building yet
Two-way sync, webhooks, Asana custom fields, real photo attachments, category-specific status tracks, operational-status changes — until auto-run is stable and staff have used the flow.
