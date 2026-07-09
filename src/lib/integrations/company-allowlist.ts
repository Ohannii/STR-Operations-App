/**
 * Provider-agnostic company allowlist guard (Slice 5).
 *
 * The Asana integration uses ONE shared token + ONE pinned project for
 * every enabled company. To make it structurally impossible for a
 * wrong (or a future second) company's flags to be processed into that
 * project, the worker must assert the company is on an explicit
 * allowlist before any write — the tenancy analogue of
 * `assertAllowedProject`.
 *
 * Pure/offline: the allowlist itself is supplied by the caller (the
 * worker will read it from an env var via `parseAllowedCompanyIds`), so
 * no environment-specific company UUID is hard-coded here — staging and
 * production have different company ids.
 */

/** Thrown when a company is not on the approved allowlist. */
export class DisallowedCompanyError extends Error {
  constructor(companyId: string) {
    super(
      `Refusing to process integration work for company "${companyId}". ` +
        `It is not on the approved company allowlist.`,
    )
    this.name = 'DisallowedCompanyError'
  }
}

/**
 * FAIL-CLOSED company guard. Throws unless `companyId` is a non-empty
 * string present in `allowedCompanyIds`. An empty/missing allowlist
 * always throws, so nothing is processed by default.
 */
export function assertAllowedCompany(
  companyId: string,
  allowedCompanyIds: readonly string[],
): void {
  if (
    !companyId ||
    allowedCompanyIds.length === 0 ||
    !allowedCompanyIds.includes(companyId)
  ) {
    throw new DisallowedCompanyError(companyId)
  }
}

/**
 * Parse a comma-separated allowlist (e.g. from an env var) into a clean
 * array: trims whitespace, drops empty entries, dedupes. Returns `[]`
 * for undefined/empty input — which makes `assertAllowedCompany` fail
 * closed.
 */
export function parseAllowedCompanyIds(raw: string | undefined): string[] {
  if (!raw) return []
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return Array.from(new Set(ids))
}
