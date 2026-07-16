/**
 * Build a SAFE, user-facing message for a failed evidence upload.
 *
 * Safety: this only ever surfaces the HTTP status and, when the storage
 * response body is JSON, its `message`/`error` field (Supabase Storage
 * errors are JSON like {"statusCode","error","message"}). It NEVER echoes
 * arbitrary raw body text, and it never has access to — so can never leak
 * — the signed URL, upload token, or any secret.
 */
export function describeUploadFailure(
  status: number,
  bodyText?: string | null,
): string {
  let msg = ''
  const detail = (bodyText ?? '').trim()
  if (detail.startsWith('{')) {
    try {
      const parsed = JSON.parse(detail) as { message?: unknown; error?: unknown }
      if (typeof parsed.message === 'string') msg = parsed.message
      else if (typeof parsed.error === 'string') msg = parsed.error
    } catch {
      /* not JSON — fall through to the generic message */
    }
  }
  msg = msg.trim().slice(0, 140)
  return msg ? `Upload failed (${status}): ${msg}` : `Upload failed (${status}).`
}
