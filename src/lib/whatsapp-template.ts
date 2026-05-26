/**
 * Generates the WhatsApp deep-link + pre-filled message for the
 * guest recovery notification flow.
 *
 * IMPORTANT: the message MUST NOT claim photos are attached. The
 * Evidence Camera (Session 6) is what will let us actually attach
 * photo evidence. Today we say evidence can be shared on request.
 */

export type RecoveryMessageInput = {
  guestFirstName: string
  propertyName: string
  companyName: string
  /** Optional short description of the incident (e.g. "a cracked coffee machine"). */
  description?: string | null
  /** Estimated cost in ZAR. Rendered as "R 2,500.00" when present. */
  estimatedAmount?: number | null
}

/**
 * Build the message text. Newline-separated lines; the encoded
 * version inside wa.me will preserve them as line breaks.
 *
 * Wording is honest about evidence: "Evidence can be shared on
 * request" — NOT "Photos attached" — until the Evidence Camera
 * session ships attachments.
 */
export function buildRecoveryMessage(input: RecoveryMessageInput): string {
  const { guestFirstName, propertyName, companyName, description, estimatedAmount } = input
  const lines: string[] = []

  lines.push(`Hi ${guestFirstName.trim()},`)
  lines.push('')

  const desc = description?.trim()
  if (desc && desc.length > 0) {
    lines.push(
      `We noticed ${desc} in ${propertyName} during the inspection after your stay.`,
    )
  } else {
    lines.push(
      `We noticed some damage in ${propertyName} during the inspection after your stay.`,
    )
  }

  if (estimatedAmount != null && estimatedAmount > 0) {
    lines.push('')
    lines.push(`The estimated cost is ${formatZAR(estimatedAmount)}.`)
  }

  lines.push('')
  lines.push('Could you reply to confirm next steps? Evidence can be shared on request.')
  lines.push('')
  lines.push('Thanks,')
  lines.push(companyName)

  return lines.join('\n')
}

/**
 * Build the wa.me URL. wa.me wants the country code + number with
 * no leading plus, no spaces, no dashes — so we strip everything
 * non-numeric.
 *
 * Returns null when the phone is empty (caller should hide the
 * "Open WhatsApp" button rather than render a broken link).
 */
export function buildWhatsAppUrl(phone: string | null | undefined, message: string): string | null {
  if (!phone) return null
  const cleaned = phone.replace(/[^\d]/g, '')
  if (cleaned.length === 0) return null
  return `https://wa.me/${cleaned}?text=${encodeURIComponent(message)}`
}

/**
 * ZAR currency formatting.
 *
 * Defensive 2-decimal rounding via integer arithmetic. The
 * Math.round(amount * 100) / 100 step neutralises any floating-
 * point drift that may have crept in from form input handling
 * (HTML5 step="0.01" + IEEE-754 can produce values like
 * 199.98000000000002 from "200"). Display must match storage
 * for money or trust gets corroded fast.
 *
 * Long-term: if billing / formal recovery workflows tighten, we
 * may move money to integer cents end-to-end. Not now -- the
 * existing decimal(12,2) Postgres columns are exact; this is
 * purely a defence against bad inputs from the client.
 */
export function formatZAR(amount: number): string {
  const rounded = Math.round(amount * 100) / 100
  return 'R ' + rounded.toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
