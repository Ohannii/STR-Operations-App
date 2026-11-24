# Company PMS calendar and automatic inspection work

Product requirement added after the inspector UX review. This is the next
integration scope, not a claim that booking sync or a calendar is implemented.
No credentials, database schema or staff records are changed by this document.

## Product decision

The calendar uses the PMS each company connects. Hostaway is the first adapter
because Drop-Inn uses it; the calendar and inspection workflow must not require
Hostaway-specific booking objects or a vendor-branded embedded calendar.
Additional PMSs require verified API/authentication support and an implemented
connector before they can be offered. Do not claim universal plug-and-play PMS
support. Keep the first implementation small rather than building a speculative
integration framework.

Each company independently selects a supported provider, connects its own
account and maps provider listing/physical-unit identifiers to existing app
properties. Credentials stay server-side and tenant isolated. The app's single
normalised booking/turnover read model feeds both the calendar and work list.
No one re-enters routine inspection schedules.

## What staff see

- Managers: a multi-unit calendar with apartments down the side and dates across
  the top; day/week overview, estate/unit/inspector filters and visible checkout,
  next-arrival, inspection-state and allocation exceptions.
- Inspectors on phones: Today work first, plus a Calendar/date selector that opens
  that day's agenda. Each job opens the correct apartment with Start or Continue.
  The calendar is another view of the same work, not a second scheduling system.
- Show departing guest and incoming guest separately when supplied by the PMS
  and permitted by the staff role. Never fabricate a guest or booking. Do not
  expose unnecessary payment, financial or guest-contact data.
- Show last successful sync and an honest stale/failed/missing-connection state.
  Empty results must be distinct from failed or incomplete sync.

## Automatic lifecycle and physical identity

1. Read real reservations and checkout/arrival times from the connected provider.
   A planned checkout creates the inspection requirement; it does not prove that
   the guest has left, the cleaner has finished or the apartment is guest-ready.
2. Match using company, connection/provider and external physical-unit identity
   against the existing internal property UUID. Unit number alone is never a key:
   BL 91 and BV 91 are different apartments. Never create a duplicate apartment
   merely because another booking or channel alias arrives.
3. A multi-unit/category reservation without an allocated physical apartment is
   an allocation exception for a manager. Do not guess a unit or silently create
   an inspection on a parent listing. Handle later allocation and unit changes
   through reconciliation.
4. Repeated webhooks, reconciliation and retries update the same turnover.
   Preserve the provider reservation plus unit-assignment identity; two different
   stays in the same apartment remain distinct work. Date alone is not identity.
5. Booking changes/cancellations update or cancel appropriate unstarted work.
   Started/submitted evidence must be preserved and surfaced as an exception
   rather than silently moved, deleted or reassigned to a different stay.
6. The inspector explicitly starts. Ordinary submission records the linked
   inspection as complete. Primary property allocation, actual authorship,
   cleaning, readiness, incidents and recovery remain separate.

Use provider time semantics and explicit property/company time zones. Keep
outgoing checkout and next incoming arrival as separate facts, including gaps,
same-day changeovers and late updates. Manual creation remains an exception or
controlled test tool while a connector is unavailable.

## First delivery: one useful Hostaway path

Start with a verified, hand-reviewed Hostaway listing/subunit-to-existing-property
mapping for Drop-Inn's BV/BL apartments, secure company-scoped credentials, a
scheduled pull of upcoming departures and an idempotent upsert into the existing
inspection work list. Trace one real departure/next arrival to the correct
apartment. Do not require a provider marketplace, webhooks, the manager calendar
grid, guest-name presentation or a second real customer before that first useful
beta. Add date-based agenda/calendar views to the same read model next, then the
manager grid. The calendar requirement is retained, not falsely declared shipped.

Tenant isolation is a first-delivery requirement: use two synthetic companies
and independent connections in automated tests before enabling writes. A second
real customer onboarding can wait. Webhooks improve freshness later; the first
scheduled pull must already have retry, reconciliation and honest freshness.

## Identity, manual collisions and cancelled work

The current table accepts only source='manual' and its existing unique indexes
key manual slots by apartment/day or checkout time. A separately reviewed new
migration must add a persistent external turnover identity and scope the manual
slot constraints appropriately. Do not edit the applied foundation migration.
Use (company, connection/provider, reservation, physical listing/subunit) as the
external key; the connection disambiguates two provider accounts reusing IDs.
A date change updates the same identity, rather than creating another visit.

If sync collides with an existing manual visit, do not silently adopt its pack,
overwrite the visit or create a duplicate. Record an explicit reconciliation
exception. A manager resolves the manual slot; a subsequent pull retries the same
external identity. Exact physical identity and source context must be preserved.
This is exception handling, not a requirement to schedule normal visits manually.

For mapped apartments in automatic mode, the normal Start must select the actual
due PMS-generated visit. Retire ordinary ad-hoc Start from that normal flow;
keep any deliberate non-turnover inspection separately labelled as an exception.
Before enabling an apartment, detect and resolve existing unrelated open drafts.
An unrelated draft must never be silently linked to make a checkout visit look
complete. Continued booking/unit changes after a draft starts become visible
exceptions without losing the evidence or its actual author.

A manager-cancelled synced visit keeps a durable cancellation/tombstone for its
external identity. Repeated pulls/webhooks must not recreate it or clear its
cancellation. Reinstatement is an explicit authorised action; booking changes
alone do not undo a manager's cancellation. Preserve the distinction between a
provider-cancelled reservation, a manager-cancelled inspection and retained
submitted evidence.

## Acceptance

Cover exact BL/BV mapping, unresolved multi-unit allocation, repeated turnovers,
changed unit allocation, booking changes/cancellations, duplicate pulls/events,
manual-slot collisions, manager cancellation surviving resync, old ad-hoc drafts,
sync outage/recovery and explicit time zones. A calendar checkout, work-list row
and submitted inspection must reference the same turnover. Do not claim live
success using invented bookings, credentials or guest names.
