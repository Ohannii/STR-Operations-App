/**
 * Pure decision logic for the pre-arrival pack submit guard
 * (fix/prearrival-photo-submit-guard).
 *
 * A pre-arrival pack must FAIL CLOSED: it can only become `submitted`
 * when it has at least one active (non-deleted) linked photo row, AND —
 * when the client declares how many photos it INTENDED for this pack —
 * the server-side active count must be at least that intended total.
 * This closes the "selected 5, only 3 linked, submit 3" race.
 *
 * The check is server-authoritative; a disabled client button is never
 * sufficient. Every pre-arrival submit surface now sends `expected_count`,
 * so a request that OMITS it (absent) or supplies a MALFORMED value is
 * rejected outright — there is no absent-value bypass. We never silently
 * ignore a manipulated or missing count.
 *
 * Kept pure and I/O-free so every branch is unit-testable without a DB.
 * The caller supplies `linkedActivePhotoCount` from a company-scoped,
 * soft-delete-filtered query (RLS + `evidence_pack_id` + `deleted_at is
 * null`), so scoping/deletion semantics are enforced by the query and
 * merely counted here.
 */

/** Result of interpreting the client's `expected_count` form value. */
export type ExpectedCount =
  | { present: false } // field absent (legacy surface) → fall back to >=1
  | { present: true; valid: false } // supplied but malformed → fail closed
  | { present: true; valid: true; value: number } // supplied intended total

export type PackSubmitDecision =
  | { ok: true }
  | { ok: false; code: 'empty' | 'missing' | 'invalid' | 'partial'; message: string }

/**
 * Interpret a raw form value. `null` = absent (no field on the form).
 * Anything present must be a plain non-negative integer; empty strings,
 * decimals, signs, NaN, or junk are "present but invalid".
 */
export function parseExpectedCount(raw: unknown): ExpectedCount {
  if (raw == null) return { present: false }
  const s = String(raw).trim()
  if (s === '') return { present: true, valid: false } // present-but-empty is malformed
  if (!/^\d+$/.test(s)) return { present: true, valid: false }
  const n = Number(s)
  if (!Number.isSafeInteger(n) || n < 0) return { present: true, valid: false }
  return { present: true, valid: true, value: n }
}

export function evaluatePackSubmit(input: {
  linkedActivePhotoCount: number
  expected: ExpectedCount
}): PackSubmitDecision {
  const linked = Number.isFinite(input.linkedActivePhotoCount)
    ? Math.trunc(input.linkedActivePhotoCount)
    : 0

  // Mandatory minimum: an empty pack can never submit (covers absent
  // expected, and a manipulated request that lowers it to 0).
  if (linked < 1) {
    return {
      ok: false,
      code: 'empty',
      message:
        'This pack has no saved photos yet. Capture photos and wait for them to finish uploading before submitting.',
    }
  }

  const e = input.expected

  // Absent → fail closed. Every legitimate pre-arrival submit surface now
  // sends the intended count, so a missing field is a stale/manipulated
  // request, never a legacy fallback.
  if (!e.present) {
    return {
      ok: false,
      code: 'missing',
      message:
        'The submit request was incomplete. Nothing was submitted — reload the pack and try again.',
    }
  }

  // Present but malformed → fail closed. Do NOT silently ignore it.
  if (!e.valid) {
    return {
      ok: false,
      code: 'invalid',
      message:
        'The submit request was malformed. Nothing was submitted — reload the pack and try again.',
    }
  }

  // Valid intended total: the pack must actually have at least that many
  // active linked photos.
  if (linked < e.value) {
    return {
      ok: false,
      code: 'partial',
      message: `Only ${linked} of ${e.value} photos have saved. Recapture or retry the missing photo${
        e.value - linked === 1 ? '' : 's'
      } before submitting.`,
    }
  }

  return { ok: true }
}
