# Inspector journey and design review

This is a code-and-screenshot walkthrough, not a claim of observed field-user
acceptance. The connected desktop browser reaches app sign-in on the preview;
no staff session, inspection or Asana record was changed during this review.

## Working persona

An inspector is standing in the apartment, using one hand on a phone, with
limited time and possible interrupted connectivity. A field lead needs to
recognise blocked work, see who actually submitted it and help recover it.
Neither should need to understand database jobs, allocation rules or why the
app calls the inspection evidence a pack.

## Findings and resulting flow

| Moment | Inspector's question | What the interface must communicate |
| --- | --- | --- |
| Work list | Which apartment and what state? | Estate and unit stay together. Text status distinguishes Due today, Upcoming, In progress, Needs attention, Cancelled and Inspection complete. |
| Due apartment | What do I do first? | Teal inspection panel, short date, one Start inspection action and a brief explanation of photos, issues and submission. |
| Empty draft | What now? | Take photos leads. Review pack is secondary. Upload safety, retry and device queue information remain visible. |
| Draft with photos | How do I finish? | Finish taking photos, then Review and submit pack. Remove the duplicate Open pack link. The review page owns the real submit; opening it never completes work. |
| Issue found | Will I lose my inspection? | Existing issue sheet stays attached to its photo; save confirmation and truthful Asana status remain independent from pack submission. |
| Discarded draft | Why can't I start again? | Amber Inspection needs attention panel explicitly says the inspection is still open and gives the next recovery step. Managers have a labelled Options control. |
| Cancellation | Can I tap safely? | Options opens a menu; Cancel inspection opens confirmation. Keep inspection is focused first. Only explicit final confirmation writes. |
| Submission | Was the inspection recorded? | The linked work card says Inspection complete with actual starter and submitter. Guest readiness and unresolved incidents remain separate. |

The prior neutral treatment made status and navigation too easy to miss.
Colour now carries a consistent role: teal for progressing work, amber for
recovery, emerald for recorded completion and rose for overdue/destructive
contexts. Labels carry the meaning even without colour. Ordinary property
status remains separate from inspection status.

The work list comes before the manager's test/exception creation form. A small,
truthful Hostaway notice stays visible. Creating routine work manually is not
the intended operational workflow.

## Basis

Google's Material guidance distinguishes filled primary actions, outlined
secondary actions and low-emphasis text actions:
https://github.com/material-components/material-web/blob/main/docs/components/button.md

Apple warns against hiding primary actions in a menu:
https://developer.apple.com/design/human-interface-guidelines/pull-down-buttons

These are hierarchy and discoverability references, not evidence that this
specific app has passed usability testing or a claim to have audited the most
popular apps individually.

## Next acceptance step

On the updated preview, have one inspector and one field lead describe the
next action without being coached. Use a controlled Test 2 visit; do not
create fabricated live bookings or modify real inspection history for a design
check. On the existing discarded job, safely open Options, then Cancel
inspection, then Keep inspection. That must leave the job unchanged.

Observe a fresh test visit from Start through photos, issue reporting, review
and ordinary Submit; confirm the work card completes and the primary allocation
is unchanged. Also inspect the empty, pending-upload, offline/retry and recovery
states at phone width and increased text size. Record errors and unexpected taps.
Automated DOM and SQL tests do not replace this observation.

## Independent Claude review brief

Review PR #74 at its current exact head in a separate checkout. Review the
mobile workflow as an inspector and as a field lead, not just as a code reviewer.
Read this document and the workboard requirements. Check what is immediately
visible, whether the next action is obvious without instructions, colour and
contrast, text size, one-handed touch targets, navigation, duplicate actions,
loading/offline/upload failure states, completion feedback and accidental
cancellation. Check empty, due, in-progress, discarded, submitted and cancelled
states. Use BL/BV same-number units to check identity clarity. State which
screens/interactions you actually ran versus inferred from code. Return a
prioritised list of concrete problems with evidence and the smallest fixes.
Preserve work in progress. Do not merge, apply migrations, edit shared staff
records, send to Asana or change production during the review. Report the
exact reviewed commit.

## Next implementation priority

Hostaway checkout automation: audit existing connector support and vendor
requirements, then implement company-isolated credentials, verified listing to
physical-apartment mapping and idempotent turnover generation/reconciliation.
Trace one real checkout and next arrival to the correct estate/unit before
claiming a usable daily work list. Do not match by unit number alone or invent
booking data. Routine rollout stays blocked until that integration and device
acceptance are proven.
