# Hostaway connection and physical apartment mapping

This increment prepares a company account and verifies its physical apartment
identities. It does **not** enable reservation ingestion, webhook processing,
inspection creation, a booking calendar, guest display or Hostaway writeback.
Other PMS providers remain a later increment.

Company admins open **Connect Hostaway & match apartments** on the dashboard
(`/dashboard/settings/pms`). Inspectors and operations managers cannot manage
credentials. Server actions derive the company and actor from authenticated
context; neither comes from a browser form.

## Credentials and deployment

`20261123084514_pms_hostaway_connection.sql` is a **new, unapplied migration**.
Review the exact file and apply it with the normal migration-history guard only
after approval. Existing workboard migrations are unchanged. Until this schema
exists the setup screen reports that setup is unavailable and disables entry.

The account ID and API key are entered in the admin form over HTTPS. The server
exchanges the key for an access token, waits for activation and verifies a listing
read before saving. The API key is not stored. The access token is stored using
the existing Supabase Vault extension, never in ordinary company settings.
No new Vercel environment secret is required for each customer account.

The four credential/mapping RPCs are executable only by `service_role` and
independently recheck the supplied server-authenticated actor's current active
company-admin membership. Their fixed empty search path uses qualified objects.
Ordinary users have no direct writes, no credential-column read, and no token RPC
execution. Admin-only row policies expose safe metadata. Audit records contain
actor, identity and revision history without credential values. No raw provider
response or error body is returned or logged by the transport/actions.

Reconnect rotates the stored access token using a revision check and preserves
the account's mappings. Changing the account ID is refused pending a reviewed
transfer workflow. Disconnect deletes the local Vault secret and retains the
mapping audit/history. It does **not** revoke a token at Hostaway; revoke provider
credentials there if needed.

## Identity rules

Match the exact account/listing/subunit to an existing company property UUID.
Never match solely by unit number. BL 91 and BV 91 remain separate UUIDs.
Discovery projects only listing/subunit identifiers, display names and timezone,
not full provider objects. Listing pages must be complete and internally unique;
failure does not return a partial selectable collection.

If Hostaway returns subunits, select a specific physical subunit. If it returns an
empty unit list, the admin must explicitly confirm the listing represents one
physical apartment. A failed unit read never means there are no subunits.
The server re-reads provider identities before every mapping save. Unknown
timezones stay unknown and are flagged for verification before scheduling.

Mappings are unique by source identity and by target property within a
connection. A parent-only mapping and child mappings cannot coexist for a listing.
This deliberately refuses aliases/conflicting mappings; review the identities
before implementing a future alias/removal workflow. No apartment is created by
this setup. Concurrent saves are serialized and checked against connection and
mapping revisions, so a stale result cannot silently replace a winner.

## Verification and limits

Run `pnpm test`, `pnpm lint`, `pnpm build`, and the two database scripts against a
**local disposable PostgreSQL** using `STR_TEST_DATABASE_URL`. Remote addresses
are refused. `pnpm test:pms:db` applies all migrations and tests permissions,
cross-tenant access, same-number apartments, rotation/disconnection, audit
protection and real two-connection races. CI runs it on PostgreSQL 17 alongside
the inspection database runner.

The local platform fixture includes a clearly marked **plaintext Vault API shim**.
Those tests verify SQL contracts and transactions, not Vault cryptography or
GoTrue. Hosted extension compatibility and a real account/listing read still need
an approved deployment and admin-entered credentials. No real turnover has been
traced by this increment. The next increment must use reservations and their
physical unit resources to create/update/cancel checkout requirements idempotently
before any claim of automated inspections.

Provider contracts checked against the official [Hostaway API documentation](https://api.hostaway.com/documentation)
and [Supabase Vault guide](https://supabase.com/docs/guides/database/vault).
