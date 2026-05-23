# TURNOVER_INSPECTION_WORKFLOW.md

## Plain-English overview

In real life, inspectors don't do "post-stay" and "pre-arrival" as two separate trips. They walk into an apartment after a guest checks out and do **both** in one continuous visit:

- Check for damage the previous guest left.
- Log missing or damaged inventory.
- Start guest-recovery action if needed.
- Confirm the apartment is clean and ready.
- Confirm amenities are stocked.
- Re-check inventory for the next guest.
- Flag maintenance issues.
- Note any record-only observations.
- Photo-prove the condition before the next guest arrives.

This is the **Turnover Inspection.** It is the single most-frequent workflow in the operation, performed roughly 300 times a month for the first customer. The product must treat it as the primary flow, not as a special case bolted onto pre-arrival and post-stay.

---

## What it is

The Turnover Inspection is **one inspection record** in the data model (`inspections.template_kind = 'turnover'`), with two halves:

1. **The "what just happened" half** — backward-looking: previous guest's damage, missing inventory, condition changes since pre-arrival.
2. **The "what's next" half** — forward-looking: cleanliness for next guest, amenities present, ready for arrival.

The two halves share photos, share the same property, share the same stay context, and share the same inspector. They are stitched together by the template — sections are ordered so the inspector walks through the apartment once, not twice.

A turnover inspection optionally links **two stays**: the *outgoing* stay (the guest who just left) and the *incoming* stay (the guest about to arrive). The same `inspections` row references both via `outgoing_stay_id` and `incoming_stay_id` (both nullable; a turnover between vacancies has neither, a turnover between back-to-back stays has both).

---

## Why combined, not separate

If we shipped pre-arrival and post-stay as separate inspection records that the inspector runs back-to-back:

- The inspector taps Submit on post-stay, navigates back to property, taps Start, picks pre-arrival template, navigates through sections — wasted time.
- Photos taken during the visit get split across two records and the manager has to look in two places.
- The same item (e.g., the TV) is checked twice with separate flag rows if there's an issue.
- The Action Centre shows one "post-stay completed" event and one "pre-arrival started" event for what was actually one visit.

With Turnover as one record:

- One template walk-through.
- One photo set.
- One submit.
- One Action Centre event ("Turnover completed for 4B").
- Flags are not duplicated.

The combined inspection is the default. Pre-arrival-only and post-stay-only remain available for the edge cases (apartment was vacant for a week; pre-arrival was done by an early-arriving cleaner before post-stay was attempted; etc.).

---

## The template structure

A standard Turnover template has six sections, in this order:

1. **Previous guest damage check** — walk-through looking for new damage since the pre-arrival of the *outgoing* stay. Heavy on photo capture for any positive finding.
2. **Inventory check** — pulled from the property's `inventory_items`. Mark each present / missing / damaged. Mark-All-OK is available for non-mandatory items.
3. **Cleanliness** — bins emptied, surfaces clean, beds made, bathrooms scrubbed. Mark-All-OK available.
4. **Amenities present** — toiletries restocked, towels stocked, WiFi card present, welcome book in place. Mark-All-OK available.
5. **Appliances working** — oven, stove, water heating, microwave, kettle, lights. All `mandatory_individual` — no Mark-All-OK.
6. **Maintenance / condition observations** — anything caught that needs fixing or noting that doesn't fit above.

The order is deliberate: damage check first while photos of "as-found" condition matter, inventory while the inspector is still walking the kitchen and bathroom, cleanliness/amenities as the inspector tidies up mentally, appliances as a deliberate slow-down (these are critical), and observations last as a catch-all.

(Sections are template-defined, so this can be re-ordered per property via the override mechanism in `TEMPLATE_AND_INVENTORY_MODEL.md`.)

---

## The fast happy path (most inspections)

A clean turnover with no problems:

1. Inspector taps **"Start Turnover"** from the property's Action Centre card. Picks the outgoing stay (auto-filled if there's exactly one recent stay). Picks the incoming stay (auto-filled from next booking if Hostaway is integrated; v1.5; until then, optional manual entry).
2. Template snapshot is taken. Inspector starts at section 1.
3. **Previous guest damage:** inspector walks the apartment, sees nothing wrong, taps "Mark all OK" for the section. Confirms.
4. **Inventory check:** walks kitchen and bathroom. Mark-All-OK on items confirmed present. Mandatory ones (e.g., safe key) still tapped individually.
5. **Cleanliness:** Mark-All-OK after a confirming look-around.
6. **Amenities:** Mark-All-OK if all stocked.
7. **Appliances:** taps each one individually (no bulk allowed). Turns on the oven, the stove, the water tap. Confirms each.
8. **Maintenance/condition:** nothing to flag. Mark-All-OK or simply skip if there are no items.
9. **Final review screen** — summary: "47 of 47 OK, 0 flags, 12 photos captured (mostly inventory baseline), 0 issues raised."
10. Tap Submit.

**Estimated time on a tidy apartment: 8–12 minutes.** Most of the time is the actual walking around, not the app.

---

## When issues are found

Same flow, but with detours:

- **Previous guest damage:** inspector notices a cracked TV. Taps "Flag" on the line item. Picks flag type `guest_damage`. Opens Evidence Camera. Fires off 4 photos of the crack. Adds a one-line note: "Crack across centre of screen, front face." The flag is created. A `guest_recovery_tasks` row is created automatically (because the recovery clock starts at checkout +24h). A maintenance job placeholder is created (because someone will need to repair/replace). All three are children of the **one parent flag** — see `DEDUPLICATION_AND_TASK_GROUPING_RULES.md`.

- **Inventory check:** inspector notices the TV remote is missing. Taps the item, marks `missing`. Photos optional but auto-prompted. An `inventory_movement` row is created. If the inspector suspects guest involvement, they can additionally flag it as `guest_damage`; otherwise it's just a missing-inventory event awaiting manager triage.

- **Appliances:** inspector tries the oven. It doesn't heat. Taps Flag, type `maintenance_issue`. Photo of the oven, photo of the cool element. The flag spawns a maintenance issue child.

- **Maintenance/condition observations:** inspector notices a small scuff on the bedroom wall. Taps "Add observation" (not "Add flag"). Picks `condition_note`. Writes "Small scuff, left of bedroom door, paint scratch only." Saves. The observation goes into apartment history but does not become an open Action Centre item.

---

## How the inspector signals "ready for next guest"

The turnover ends with a final review screen that explicitly asks: **"Is this apartment ready for the next guest?"**

Two options:

- **"Yes, ready."** Submit. Property status changes to `ready_for_arrival`. The Action Centre updates.
- **"No, not yet."** Submit, but property stays in `between_stays_blocked` status until the open issues clear. Manager is alerted.

The inspector cannot tap "Ready" if there are open `safety_urgent` flags from this inspection. The UI blocks it: "Resolve safety issues before marking ready."

If the inspector taps "Not ready," they're prompted to add a one-line reason ("Oven not heating — need contractor before guest arrival"). This reason surfaces on the Action Centre card so management knows what to chase.

---

## Junior inspector mode

The team has junior staff. The turnover flow must be **stupid-proof** (the first-class principle in `CLAUDE_PROJECT_SKILLSET.md`).

### Flag behaviour during a turnover (prototype findings #1, #2, #3, #7, #9)

These rules apply throughout the turnover flow and are worth stating explicitly because the turnover is where most flags are born:

- **Context is inherited, never re-asked.** A flag raised anywhere in the turnover automatically carries this property, this inspection, and the outgoing stay. The inspector is never asked "which apartment?" mid-flow.
- **Saving a flag never submits the turnover.** The inspection stays in progress until the inspector taps the single "Submit Inspection" button on the final review screen. An inspector can raise ten flags across six sections and the inspection is still a draft until they choose to submit.
- **Notes are captured in the guided flow before a damage/maintenance flag saves** — the inspector describes what they see while looking at it, not later from memory.
- **The action-needed picker is optional for the inspector.** Junior staff who don't know whether something is owner-chargeable or needs Asana simply save the flag with a photo and note; the manager triages from the Action Centre afterwards.
- **After saving a flag, the inspector gets three clear next actions:** Continue inspection (default), Go to Apartment Action Centre, or Review saved flag.

What junior-mode means in this workflow:

- **Big visual hints.** Each section has an icon. Mark-All-OK button is the biggest button. Flag button is also big, but a different colour (orange/red) so it stands out as the "this is more work" path.
- **Default everything.** Outgoing stay auto-filled. Template auto-picked. Required photos pre-prompt. Default flag type is always pre-selected based on context (in the damage section, default flag type = "guest damage"; in the appliances section, default = "maintenance issue").
- **Plain language.** "Mark all OK" not "Bulk update status." "Flag a problem" not "Raise inspection finding."
- **No menus.** No settings. No three-dot overflow buttons in the inspection flow. If a feature can't fit on the screen, it lives outside this flow.
- **Clear submit gating.** If the inspector tries to submit with required photos missing, the missing items appear in a list and the inspector taps to jump to each one. Not a generic "some items are incomplete" toast.
- **No financial decisions.** Inspectors never see "estimated cost" or "owner-chargeable" tick boxes. They just flag the problem with photos. The manager decides money later.

---

## The final review screen

Before submit, the inspector sees:

- Section-by-section status summary.
- Count of items checked, items OK, items flagged.
- A photo gallery thumbnail strip of all photos captured.
- All flags raised in this inspection, with one-line summary each.
- The ready/not-ready question.
- A free-text "anything else?" field (optional).
- Submit button.

If the inspection took longer than 30 minutes, a small banner: "Inspection started 32 minutes ago. Take a moment to confirm everything." (Helps catch the case of "I started, got distracted, came back, submitted without finishing.")

---

## What happens after submit

On submit, the system does several things automatically:

1. Writes the inspection's `submitted_at` and inspector id.
2. For each flag raised, evaluates whether downstream children should auto-spawn:
   - `guest_damage` flags → spawn `guest_recovery_tasks` immediately (24h clock starts).
   - All other flag types → stay as flags only; await manager triage to convert.
3. Updates the property's status pill based on the ready/not-ready answer.
4. Updates the outgoing and incoming `stays` rows with the inspection link.
5. Generates the inspection HTML report (rendered on demand later; metadata committed now).
6. Writes audit events.
7. Refreshes the Action Centre.

The inspector is then routed to the **Apartment Action Centre** (not back to their inspection list) so they see the current state of the property they just completed. This reinforces "the Action Centre is where the truth lives."

---

## How it feeds the Apartment Action Centre

After a turnover with no flags: the property's card shows green status, "Last inspection 5 minutes ago," no open work strip. Quiet.

After a turnover with flags: the property's card shows the new parent flags. Each parent flag is one row. Cracked-TV (guest_damage), Missing-remote (inventory), Oven-not-working (maintenance) → three rows on the Action Centre, one per real-world problem. Each row has its work strip with children.

The guest_damage row has the recovery task deadline already running, brightest button "Notify guest." A manager opening the Action Centre right after submit sees exactly what needs attention right now.

The dedup rules from `DEDUPLICATION_AND_TASK_GROUPING_RULES.md` apply: even though the cracked TV created three database rows (flag + recovery task + maintenance job), it appears as **one** Action Centre card.

---

## How it creates downstream records

A turnover inspection's flags can spawn:

| Flag type raised in turnover | Spawned at submit | Spawned later by manager |
|---|---|---|
| guest_damage | guest_recovery_task (auto) | maintenance_job (convert), accountability_record (convert) |
| inventory_missing | inventory_movement (auto) | accountability_record (convert if chargeable) |
| inventory_damaged | inventory_movement (auto) | maintenance_job (convert if fixable), accountability_record (convert if chargeable) |
| maintenance_issue | nothing automatic | maintenance_job (convert) |
| owner_chargeable | nothing automatic | accountability_record (convert) |
| company_responsibility | nothing automatic | accountability_record (convert) |
| safety_urgent | issue (auto, high priority) | maintenance_job (convert), manager notified |
| cleaning_issue | nothing automatic | cleaning task (v1.5) or follow-up inspection |
| condition_note | nothing | nothing (history only) |
| follow_up_required | nothing | propagated to next inspection on this property |
| no_action_record | nothing | nothing |

Auto-spawning is conservative on purpose: only the time-sensitive cases (guest_damage, safety_urgent) auto-spawn. Everything else waits for human triage, because forcing the system to make accountability decisions without human input is exactly the kind of "AI deciding money" failure we banned.

---

## Owner / guest / company / contractor cost classification

This happens **after** the turnover, at the manager triage step — not by the inspector. The reason: inspectors don't have the context to make these decisions. They photograph and flag; managers decide.

The flow:

1. Manager opens the flag card from the Action Centre.
2. Looks at the evidence.
3. Picks the chargeable party from a dropdown: `guest` / `owner` / `company` / `contractor` / `pending_decision`.
4. If `guest`: the recovery task is already running; no new action needed. Cost cascade kicks in (see `INVENTORY_AND_MAINTENANCE_LOGIC.md` Part 1.5).
5. If `owner`: an accountability record is created (or already exists from auto-spawn). It enters the approval policy flow (`APPROVAL_LIMITS_AND_CONTRACT_RULES.md`).
6. If `company`: an accountability record is created with `chargeable_party = company` and `absorbed_reason` required.
7. If `contractor`: rare; means contractor messed something up and the contractor pays. Same as company-absorb in v1.0 with a different reason code.
8. If `pending_decision`: record is created but not finalised. Shows on the Action Centre as "Awaiting cost decision."

The Action Centre surfaces "Awaiting cost decision" items distinctly so they don't get forgotten — this is exactly the leakage failure mode the founder named.

---

## Inventory proof in the turnover

The "Inventory check" section produces two distinct outputs:

1. **Baseline photos** for items that are present and correct — `routine_pre_arrival` retention class (because in a turnover, the same photos serve as pre-arrival proof for the incoming stay).
2. **Movement records** for items marked missing or damaged — actual `inventory_movements` rows with `inventory_evidence` photos.

The same inspector tap that says "TV remote present" produces a photo classified as routine pre-arrival baseline, which becomes the dispute-defence evidence if the next guest later denies leaving the remote. The system does this without the inspector needing to think about it.

---

## Cleanliness check

The Cleanliness section is mostly Mark-All-OK in practice. Photos are not required by default for clean items. Flags are raised when something is *not* clean.

For a "not clean" flag:

- Type: `cleaning_issue`.
- Photo: required (configurable, default).
- Outcome: in v1.0, the flag is recorded and the property stays `not_ready`. The manager sees it and arranges re-cleaning manually. In v1.5, the flag can convert directly to a cleaning task assigned to a housekeeping role.

---

## Maintenance flagging (during turnover)

The maintenance section (and any maintenance flag raised in any section) creates flags that the manager triages later.

For a maintenance flag:

- Type: `maintenance_issue` (or `safety_urgent` if urgent).
- Photo: required (default).
- Note: optional unless `safety_urgent`.
- Outcome at submit: a flag exists; a maintenance job is *not* auto-created. Manager taps "Convert to maintenance job" on the Action Centre, fills cost estimate, assigns to a technician.

The reason: deciding contractor + cost takes time the inspector doesn't have during the turnover. Manager triage costs a manager 30 seconds per flag and gets the routing right.

---

## Guest notification action (during or after turnover)

The same-day guest notification flow is detailed in `GUEST_DAMAGE_RECOVERY_WORKFLOW.md`. Brief summary as it applies to the turnover:

- Inspector raises a `guest_damage` flag during the turnover.
- A `guest_recovery_tasks` row spawns immediately with deadline = checkout +24h.
- **The inspector can notify the guest right there**, from the flag card, while still in the apartment. The "Notify guest" button is on the flag card. One tap → message template → copy → open WhatsApp.
- Alternatively, the inspector tags the flag and leaves notification to the manager.
- Either way, the flag card carries the notification state visibly. No one has to "remember" to notify; the Action Centre surfaces it with a colour-coded deadline.

---

## Volume considerations

300 turnovers per month means roughly 10 per day. With one inspector at 10 minutes each, that's 100 minutes of inspection time per day. Photos: at 12 photos per inspection on average, that's ~120 photos/day = ~3,600/month from turnovers alone (less than the original 6,000 estimate because Turnover combines two previously-separate inspections into one). Annual audits add another ~50 inspections × 50 photos = 2,500/year (= ~208/month).

Total estimated photo volume from inspections: ~3,800/month. Storage projections remain in the small-cost range (see `PHOTO_RETENTION_POLICY.md`). These are estimates until confirmed by real use.

---

## Edge cases

| Situation | Behaviour |
|---|---|
| Apartment was vacant — no outgoing stay | Inspector starts Turnover with `outgoing_stay_id = NULL`. Damage section becomes "Condition check" instead of "Previous guest damage." Same template, semantically softer. |
| Apartment goes from one guest directly to another — no time for cleaning | The "Cleanliness" section is still required. Inspector marks it not-ready if cleaning has not occurred. Property cannot transition to `ready_for_arrival`. |
| Two inspectors start a Turnover for the same property | Same as today — both drafts exist, manager picks one. The other is closed as duplicate. (Schema is ready for collaborative edit in v2+; not in MVP.) |
| Inspection started but app crashes | Local IndexedDB draft survives. Inspector reopens app; draft is restored. Already-uploaded photos remain. |
| Inspector closes the app mid-section | Auto-save preserves state. Picks up where they left off. |
| Inspector finishes pre-arrival half but post-stay items remain (or vice versa) | Submit is allowed only when all *mandatory* items are answered. Optional items can be left blank. The summary makes this clear. |
| Outgoing guest extends their stay mid-turnover | Inspector pauses, doesn't submit. Manager updates the stay's checkout time. Inspector resumes when guest actually leaves. |

---

## Acceptance criteria (v1.0)

A turnover inspection is acceptable for v1.0 when:

1. Inspector can start a Turnover from a property's Action Centre card with one tap.
2. The template snapshot is taken at start time (template version recorded).
3. Mark-All-OK works at the section level and respects `mandatory_individual` items.
4. The Inventory section auto-populates from the property's `inventory_items`.
5. Flagging a `guest_damage` line item creates a parent flag AND auto-spawns a `guest_recovery_tasks` row with the deadline.
6. The flag card on the Action Centre immediately offers "Notify guest" with a copy-paste message template.
7. The final review screen blocks Submit when safety_urgent items are unresolved AND ready-for-next-guest is True.
8. Submitting routes the inspector to the property's Action Centre, not back to a list.
9. The property status pill updates correctly based on ready/not-ready.
10. The whole flow on a real iPhone with the founder's average-signal apartment Wi-Fi takes 8–15 minutes for a clean turnover.

---

## What is NOT in v1.0

- **Cross-stay inspection comparison** (auto-diff between outgoing and incoming pre-arrival). v1.5.
- **Auto-fill incoming stay** from Hostaway. v1.5.
- **Cleaning task auto-assignment**. v1.5.
- **Inspector-side cost decisions.** Never. Always manager.
- **Conditional sections** (skip cleanliness if turnover-to-vacant). v2+.
- **Two inspectors collaborating on one inspection**. v2+.

---

## Why this matters

300 turnovers per month is the dominant workflow. If the turnover flow is right, the product is used. If it's wrong, the team falls back to WhatsApp and Asana for everything except the few non-turnover inspections.

This is also the workflow that proves the deduplication discipline: a turnover with three flagged problems produces three Action Centre cards, not 15 records. The flag-as-parent model is what makes 300 turnovers/month survivable in the Action Centre.
