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

## First delivery and acceptance

Audit the current repo and provider's current documented API/authentication
first. Implement one working Hostaway path behind the provider boundary, not a
calendar of sample bookings presented as live. Trace one real checkout and next
arrival to the correct BL/BV apartment before claiming operational readiness.
Then surface the normalised data in the calendar and Today list.

Acceptance includes two companies with independent connections, same-number
BL/BV units, category bookings awaiting physical allocation, repeated turnovers,
changed unit allocation, booking changes/cancellations, duplicate events, sync
outage/recovery and South Africa time. A calendar checkout, its work-list entry
and the resulting submitted inspection must refer to the same turnover.

This needs a separately reviewed implementation and migration. The current
workboard table still accepts manual schedules only. Do not alter an already
applied migration to introduce this scope or turn on unverified writes.
