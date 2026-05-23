# APARTMENT_ACTION_CENTRE.md

## Plain-English overview

The **Apartment Action Centre** is the single screen that answers the question: *"What needs attention right now?"*

It is the **home screen** of the app once you sign in. It is the screen that replaces Asana for your operation. It is the place a manager checks first thing in the morning and last thing at night.

Without an Action Centre, the product is a collection of features. With it, the product becomes the operational source of truth you're trying to build.

---

## The two views

The Action Centre has two views, switched by a single toggle at the top:

### View A — Portfolio view (default for managers)

Lists every property in the company with a status pill and an open-item count. Used when scanning the whole portfolio for hot spots.

### View B — Property view (default when a property is selected)

Drills into one property and lists everything that needs attention there. Used when working on a specific apartment.

A user can be in either view at any time, and the toggle takes one tap.

---

## What appears on Portfolio view

A table, one row per property, sorted by "most needs attention" first.

Each row shows:

- Property name + thumbnail.
- **Status pill** — `Idle` / `Guest in` / `Between stays` / `Pre-arrival pending` / `Post-stay pending` / `Needs attention` / `Critical`.
- **Open count** — number of open items (flags + issues + recovery tasks + pending approvals).
- **Oldest open age** — how long the oldest item has been open (a property with a 14-day-old open flag is bumped up).
- **This month's owner spend** — running total against the monthly cap (small horizontal bar, green/amber/red).
- **One-tap actions** — "Open property", "Start inspection", "View open items".

Sort defaults: critical → red (deadline-breached items) → orange (high priority) → amber (medium age) → quiet properties at the bottom.

A small "search / filter" bar at the top lets the manager filter by owner, region, or assigned inspector. v1.0 keeps this minimal.

---

## What appears on Property view

Five sections, in this order top to bottom:

### 1. Property header

- Name, address, photo, current status pill.
- Assigned inspector(s), assigned coordinator.
- Owner name (managers see it; field roles don't).
- This-month owner spend bar.

### 2. Today's actions

The most time-sensitive stuff for this property right now. Shows:

- Guest recovery tasks past or near deadline (red/orange).
- Safety/urgent flags.
- Inspections due today.
- Maintenance jobs scheduled today.

Empty state: "Nothing urgent today. ✅"

### 3. Open problems (one card per real-world problem)

This is the heart of the Action Centre. **Each card is one parent flag = one real-world problem.** It is never the case that the same problem appears as several separate rows. This is the rule from `DEDUPLICATION_AND_TASK_GROUPING_RULES.md`, and it is what keeps the screen scannable at 200 apartments.

Each card shows:

- **Header:** flag type icon + 3-word label, short description, age ("2 hours ago", "3 days ago"), severity, photo badge ("3 photos").
- **Work strip:** small chips for each child record this problem has spawned (issue / maintenance job / inventory movement / guest recovery task / accountability record), each with its own status. Tapping a chip opens that child's focused detail view; closing it returns to the card.
- **Action buttons:** the single most useful next action for this problem right now (the brightest button), plus a few common ones — e.g. "Open", "Add photo", "Notify guest", "Add note". The "Notify guest" button for a guest-damage problem lives **here, on the card** — there is no separate guest-recovery module to navigate to.

Worked example — a cracked TV flagged on a turnover spawns a flag (parent) + recovery task + maintenance job + accountability record. It appears as **one** card with a three-chip work strip, not four cards. Full example in `DEDUPLICATION_AND_TASK_GROUPING_RULES.md`.

Cards in `raised`/`classified` with no children yet simply have an empty work strip and a "Classify / Convert / Mark no-action" action — they're problems the manager hasn't routed yet.

**Record-only observations never appear here.** A `condition_note` / `no_action_record` set to `no_action` lives in apartment history, not in this open queue (see `TEMPLATE_AND_INVENTORY_MODEL.md`).

### 4. Standalone work (no parent flag)

A small section for downstream records that legitimately have no parent flag — scheduled maintenance ("annual aircon service"), planned restocks, direct financial adjustments. These have `parent_flag_id = NULL` and appear as their own cards. This is not duplication; there is no problem to group under.

Each row: title + status pill + age + one-tap action.

### 5. Pending approvals

Owner-chargeable items waiting for manager approval, plus items waiting for the owner to sign off (via the approval policy flow), plus any emergency overrides awaiting post-event review.

Each row: amount + chargeable party + reason for pending + one-tap action ("Approve", "Send to owner", "Mark owner approved", "Review override").

### 6. Coming up

- Upcoming inspections in the next 7 days (especially turnovers and pre-arrivals).
- Upcoming scheduled maintenance.
- Manual occupancy/reservation notes the manager has added.

---

## Where the data comes from

The Action Centre is a read-only aggregate. It writes nothing of its own. All data comes from existing tables:

- Flags from `flags`.
- Issues / maintenance from `issues` and `maintenance_jobs`.
- Recovery tasks from `guest_recovery_tasks`.
- Inventory movements from `inventory_movements`.
- Accountability records from `accountability_records`.
- Approvals from `approval_decisions`.
- Properties from `properties`.
- Inspections from `inspections`.

The query is one SQL view per company per property (or a parameterised function), with RLS enforcing that a user only sees their company's data and their role-permitted entities.

---

## Performance considerations

At MVP scale (one company, hundreds of properties, low hundreds of open items), a single query per page load is fine.

If a customer hits hundreds of thousands of open items: add a materialised view per company refreshed every minute, or use Supabase Realtime to push deltas. Not needed in v1.0–v1.3.

---

## What the field team sees

The Action Centre is role-aware:

| Role | Sees |
|---|---|
| Company Admin / GM | Full Portfolio + Property views. |
| Ops Manager / Property Manager | Portfolio view filtered to their assigned properties; Property views for those. |
| Maintenance Coordinator | "Today's actions" + "Open work" with maintenance-flavoured items prioritised; can see across all properties (since they assign work). |
| Inspector | A simpler home screen: today's assigned inspections + their own raised flags; no portfolio view, no approval section, no financials. |
| Maintenance Tech | Even simpler: today's assigned jobs only. |
| Property Owner Viewer | Does NOT see the Action Centre; sees their owner-facing dashboard only (see `OWNER_COMMUNICATION_WORKFLOWS.md`). |

Each role-view of the Action Centre is built specifically for that role — not a single screen with permission-hidden sections. That keeps each user's home screen simple.

---

## Stupid-proof UX rules

The Action Centre is the screen that 90% of users will look at 90% of the time. It must be obvious.

1. **The brightest button is always the next action.** A user scanning the screen should never have to read carefully to know what to do next.
2. **No more than 7 items in any one section without "show more".** Visual overwhelm kills usefulness.
3. **Plain language status, not internal enum names.** "Waiting for owner — 3 days" not "PENDING_OWNER_APPROVAL since 2026-05-09T14:23:00Z".
4. **Colour is a hint, not the only signal.** Red items also have an exclamation icon and a "deadline passed" label.
5. **No empty filters.** If a section has zero items, show a calm empty state ("No open work for this property — well done.") not an empty table.
6. **Tappable rows go to the detail screen.** Tapping the row title navigates; tapping the action button does the action without navigating. Two distinct hit zones, big enough.
7. **Refresh is automatic on focus.** Coming back to the Action Centre from another screen refreshes the data; no pull-to-refresh required (though it works too).

---

## v1.0 scope — what ships first

The Action Centre is the **home screen of v1.0** even though it's a thin version. v1.0 includes:

- Portfolio view: list of properties with status pill + open count.
- Property view: header + Open Flags + Open Work + Coming Up sections.
- Today's actions: inspections due today + safety flags.
- Role-aware: Company Admin, Ops Manager, Inspector home variants.

Not in v1.0 (added stage by stage):

- Pending approvals section — needs the approval policy enforcement (v1.2).
- Guest recovery deadline widget — needs `guest_recovery_tasks` (v1.1).
- This-month owner spend bar — needs approval policy + accountability flow (v1.2).
- Owner-facing dashboard — needs owner viewer role (v1.3).

This staging is intentional: v1.0 ships a real Action Centre, not a placeholder. Each subsequent stage adds its widget to the same screen rather than building a new home page.

---

## Why this matters

Right now, your operation lives across Asana, WhatsApp, spreadsheets, and inspector head-memory. Replacing that with "open the app and look at the Action Centre" is the largest single-feature win in the entire product.

If the Action Centre is wrong (overwhelming, unclear, slow), the team will fall back to WhatsApp and Asana within a week. If the Action Centre is right, the team will start asking "what's not on the Action Centre yet?" and the product will absorb the rest of the operational chatter naturally.

**The Action Centre is the test of whether this product replaces Asana or merely adds to it.**
