/**
 * Session 9C — category-aware "what needs to happen next" guidance.
 *
 * The issue detail page used to present every issue with the same generic
 * triage form, so an "item missing" read like a maintenance repair. This
 * helper returns short, plain-language, operationally-specific next steps
 * for the issue's category (with a "resolved" override once it's closed),
 * so a tired field user instantly knows what this *kind* of issue needs.
 *
 * Pure/display-only: keys off the existing category key + status. It does
 * NOT change the category/accountability data model and does not automate
 * any workflow — it's guidance text, not actions.
 */

export type IssueGuidanceTone = 'default' | 'urgent' | 'resolved'

export type IssueGuidance = {
  /** One-line "what to do" summary. */
  headline: string
  /** A short checklist of next steps (0–3 items). */
  steps: string[]
  tone: IssueGuidanceTone
}

export function issueGuidance(input: {
  categoryKey: string | null | undefined
  status: string
}): IssueGuidance {
  // Closed / no-action issues: guide toward verifying or reopening.
  if (input.status === 'closed' || input.status === 'no_action') {
    return {
      headline: 'This issue is resolved.',
      steps: [
        'If it turns out it is not actually fixed, reopen it below.',
        'The evidence and activity history stay on record.',
      ],
      tone: 'resolved',
    }
  }

  switch (input.categoryKey) {
    case 'safety_urgent':
    case 'safety':
      return {
        headline: 'Act today — this is a same-day safety priority.',
        steps: [
          'Make the apartment safe, or block it from the next arrival if needed.',
          'Tell a manager now.',
          'Keep the photos — safety issues can become insurance or dispute matters.',
        ],
        tone: 'urgent',
      }

    case 'maintenance_issue':
      return {
        headline: 'Get it repaired.',
        steps: [
          'Assign someone to fix it.',
          'Capture before/after photos as proof of the repair.',
          'Set who pays in the Responsibility picker if it is not clear.',
        ],
        tone: 'default',
      }

    case 'appliance_furniture':
      return {
        headline: 'Repair or replace the appliance / furniture.',
        steps: [
          'Decide whether it can be repaired or needs replacing.',
          'Capture photos of the damage.',
          'Set who pays in Responsibility.',
        ],
        tone: 'default',
      }

    case 'cleaning_issue':
      return {
        headline: 'Get it cleaned.',
        steps: [
          'Send it back to the cleaning team / request a re-clean.',
          'Confirm it is done before the apartment is marked ready.',
        ],
        tone: 'default',
      }

    case 'linen_towels':
      return {
        headline: 'Replace or wash the linen / towels.',
        steps: [
          'Send for washing or swap in fresh stock.',
          'Confirm it is restocked before the next guest.',
        ],
        tone: 'default',
      }

    case 'inventory_missing':
      return {
        headline: 'Replace the missing item.',
        steps: [
          'Confirm it is actually missing (not just moved or in use).',
          'Request a replacement.',
          'Set who is accountable for the cost in Responsibility.',
        ],
        tone: 'default',
      }

    case 'inventory_damaged':
      return {
        headline: 'Repair or replace the damaged item.',
        steps: [
          'Decide repair vs replace.',
          'Keep photos of the damage.',
          'Set who is accountable in Responsibility.',
        ],
        tone: 'default',
      }

    case 'guest_damage':
      return {
        headline: 'Recover the cost from the guest.',
        steps: [
          'Notify the guest with the evidence (use Guest recovery below).',
          'Track whether they pay or refuse.',
          'Keep the photos — this is dispute evidence.',
        ],
        tone: 'default',
      }

    case 'guest_incident':
      return {
        headline: 'Log the incident and decide follow-up.',
        steps: [
          'Record what happened, with any evidence.',
          'Decide if guest recovery or a manager escalation is needed.',
        ],
        tone: 'default',
      }

    case 'access_keys_lock':
      return {
        headline: 'Sort out access / keys / locks.',
        steps: [
          'Resolve the lock, key, or access problem.',
          'Re-key or update access if security may be affected.',
        ],
        tone: 'default',
      }

    case 'owner_chargeable':
      return {
        headline: 'This is chargeable to the owner.',
        steps: [
          'Confirm it is genuinely owner-chargeable.',
          'Keep the cost evidence for the owner report.',
        ],
        tone: 'default',
      }

    case 'company_responsibility':
      return {
        headline: 'The company absorbs this one.',
        steps: ['Record it for history — no charge to the guest or owner.'],
        tone: 'default',
      }

    case 'condition_note':
    case 'observation_note':
    case 'no_action_record':
      return {
        headline: 'This is a note for the record.',
        steps: [
          'No action needed unless it becomes a real issue.',
          'Close it as “No action” once it is noted.',
        ],
        tone: 'default',
      }

    case 'follow_up_required':
      return {
        headline: 'Check this again next visit.',
        steps: ['Leave it open as a reminder.', 'Re-inspect at the next turnover.'],
        tone: 'default',
      }

    case 'legacy_uncategorised':
      return {
        headline: 'Pick the real issue type for this.',
        steps: [
          'This was carried over from an old category.',
          'Choose the correct category and responsibility, then continue.',
        ],
        tone: 'default',
      }

    default:
      return {
        headline: 'Triage this issue and decide the next step.',
        steps: [
          'Set the status, severity, and who is responsible below.',
          'Use the progress chips to track what is happening, and Mark resolved when it is done.',
        ],
        tone: 'default',
      }
  }
}
