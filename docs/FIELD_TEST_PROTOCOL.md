# FIELD_TEST_PROTOCOL.md

## Purpose

Each v1 stage (v1.0, v1.1, v1.2, v1.3) ends with a real-apartment field test before it is considered done. This document defines exactly how that field test runs, what counts as pass, and what to do when it fails.

The point: avoid the trap of "it works on my laptop" by forcing real-world conditions before declaring a stage complete.

---

## Why a real field test

Demos in a Wi-Fi'd home environment hide:

- Weak signal mid-inspection.
- iPhone Safari quirks under storage pressure.
- Photo upload failures during real use.
- UX confusion when an inspector hasn't already seen the screen.
- The actual length of a 50-line-item inspection on a busy turnover day.

Every stage's acceptance criteria say "on a real iPhone in a real Durban apartment." This protocol describes how to actually do that.

---

## The protocol

1. **Pick a real apartment.** The founder's own STR portfolio is the test environment. Pick one that has had a recent guest turnover.
2. **Pick a real inspector.** Not the founder. A staff member who has not been involved in building the app. Ideally a junior team member.
3. **Brief the inspector once, briefly.** "Use this app to do today's turnover inspection like you normally would. If you can't figure something out, ask. Otherwise just do the inspection."
4. **The founder observes silently** for the first 5 minutes. Notes confusion, hesitation, accidental taps.
5. **The founder is allowed to answer questions** but not allowed to drive the device or take it over.
6. **Capture three things:**
   - The actual time taken to complete the inspection.
   - The number of times the inspector asked for help.
   - The number of times they tried to fall back to WhatsApp / camera roll.
7. **Submit the inspection.** The founder verifies that the inspection record, photos, flags, and Action Centre state are all correct.
8. **Compare to acceptance criteria** for the stage being tested.
9. **Record results** in `TASK_LOG.md`.

---

## Pass criteria

A stage passes its field test when **all** of these are true:

| Criterion | v1.0 | v1.1 | v1.2 | v1.3 |
|---|---|---|---|---|
| The inspector completes the relevant primary workflow end-to-end without giving up | ✅ | ✅ | ✅ | ✅ |
| Help requests during inspection: **0** for stupid-proof items (Mark-All-OK, photo capture, flag raise), at most **1** for any non-field-team workflow | ✅ | ✅ | ✅ | ✅ |
| Falls back to WhatsApp / camera roll: **0** | ✅ | ✅ | ✅ | ✅ |
| All photos appear `synced` within 5 minutes of returning to good signal | ✅ | ✅ | ✅ | ✅ |
| Turnover inspection time (when applicable): **≤ 15 minutes** for a clean apartment, **≤ 25 minutes** with 3 flagged items | ✅ | ✅ | ✅ | ✅ |
| Guest recovery task completed end-to-end (v1.1+) — message sent, screenshot logged | — | ✅ | ✅ | ✅ |
| Approval cap correctly triggers (v1.2+) — over-cap charge enters pending-owner flow | — | — | ✅ | ✅ |
| Weekly owner update generated and sent without writing free text in the happy case (v1.3) | — | — | — | ✅ |
| Stage's specific acceptance tests in `TESTING_CHECKLIST.md` all green | ✅ | ✅ | ✅ | ✅ |

If any pass criterion fails: the stage is NOT done. Fix the issue, run the field test again with a different inspector if possible (to prevent learning effects from one person doing it twice).

---

## What to do when the test fails

Failure mode 1: **Inspector confused about a screen.**

- Watch where exactly they hesitated.
- The failure is in the screen, not the inspector.
- Fix the screen (default values, plain language, bigger buttons, clearer empty state).
- Re-test with a *different* inspector if available.

Failure mode 2: **Photo capture is slow or fails.**

- This is the highest-priority failure to fix.
- Photo capture must match WhatsApp speed or the team falls back.
- Check Evidence Camera Mode: camera-stays-open, photo strip, no upload modal between shots.
- Test offline behaviour separately.

Failure mode 3: **Falls back to WhatsApp/Asana.**

- Diagnose the trigger. Most common: "I couldn't find the right place to put the photo."
- Usually fixed by surfacing the right action on the right screen, not by adding features.

Failure mode 4: **Inspection takes too long.**

- Identify which section ate the time.
- Check whether Mark-All-OK was discoverable and used.
- Check whether mandatory_individual items are right-sized for the section.

Failure mode 5: **Photos don't sync.**

- iOS PWA + signal issues + IndexedDB pressure. The hardest cluster of bugs.
- Reproduce in known conditions.
- Add a stress test to `TESTING_CHECKLIST.md` so it doesn't regress.

Every failure goes into `KNOWN_ISSUES.md` if it's not resolved before the next stage; otherwise into `CHANGELOG.md`.

---

## Equipment for each field test

- A real iPhone (the founder's primary device).
- A real apartment, recently used.
- A real inspector (not the founder).
- Average signal — typical Wi-Fi at the apartment, no power-tier router boost.
- A stopwatch.
- A notebook (or notes app on a separate device) for observations.

That's it. No special instrumentation.

---

## Frequency

Each v1 stage runs the field test **once** to pass the acceptance gate.

In addition, the founder runs an informal field test:

- After any non-trivial change to the inspection workflow.
- Before any production deploy of v1.0+ once it's live.
- Quarterly thereafter, to catch regression and drift.

These informal tests don't need a fresh inspector each time; the founder using their own staff is sufficient for regression.

---

## What this protocol does not cover

- Load testing (concurrent users, large data volumes). Out of scope for MVP at 1 customer.
- Cross-device testing (Android, desktop browsers). Covered by `TESTING_CHECKLIST.md` separately.
- Integration tests against third-party services (Hostaway etc.). Out of scope until those exist.
- Owner-facing screens. Test with a real owner only if they consent; otherwise founder reviews.

---

## Why this matters

The product fails if real inspectors don't use it. Real inspectors will only use it if it's faster than WhatsApp. The field test is the only way to know that — and the cost of skipping it (a v1.5 retrofit because v1.0 was unusable in practice) dwarfs the cost of running it (an hour per stage).
