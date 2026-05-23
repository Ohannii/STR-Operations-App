# AI_FEATURE_ROADMAP.md

## Core AI principle

**AI is assistive, not authoritative.**

The product must work fully without AI. AI features can help speed up writing, suggest categories, and summarise — but a human is always the source of truth on:

- Accountability decisions (who is responsible for damage)
- Owner-chargeable status
- Guest / OTA chargeable status
- Dispute decisions
- Anything that becomes money
- Anything that ends up in an owner's monthly summary

If the AI service is down, the app must keep working perfectly.

---

## Why this matters

A short-term rental operations app touches money, evidence, and trust. If an AI hallucinates that a guest broke a TV and the system auto-charges someone, we have manufactured a dispute. The damage to a customer relationship is bigger than any time saved.

So:

- AI suggests; humans confirm.
- AI output is always editable before it lands in a permanent record.
- AI does not write directly to `accountability_records`, `owner_monthly_summaries`, or any chargeable field.
- AI output that becomes part of a record is timestamped and flagged: "AI-drafted, edited by X on Y."

---

## Classification of AI features

Each candidate feature is classified into one of four buckets:

- **Must-have now (MVP)** — none.
- **Useful later (v1.5 / v2)** — light-touch, cheap, high value.
- **Expensive later (v2+)** — useful but cost or risk needs more thought.
- **Not recommended yet** — solves a problem we don't have or carries too much risk.

---

### Candidate features

#### 1. Inspection summary drafting

- **What:** After an inspector submits an inspection, AI drafts a short paragraph summarising the findings (e.g. "Apartment in good condition. Minor damage to bedside lamp. One missing TV remote.").
- **Bucket:** **Useful later (v1.5).**
- **Why:** Cheap, low-risk, high time savings for managers.
- **Guardrails:** Manager edits before the text goes anywhere external. The source structured data remains the truth.

#### 2. Issue severity suggestion

- **What:** When an inspector creates an issue, AI suggests priority (low / med / high) based on the title, description, and a few photos.
- **Bucket:** **Useful later (v1.5).**
- **Why:** Helps inexperienced inspectors triage; saves manager time.
- **Guardrails:** Inspector can override. Final priority is whatever the human picks.

#### 3. Maintenance category suggestion

- **What:** Suggest "plumbing / electrical / appliance / cleaning / cosmetic" from the issue description.
- **Bucket:** **Useful later (v1.5).**
- **Why:** Speeds up assignment to the right technician.
- **Guardrails:** Coordinator confirms. No auto-assignment in MVP.

#### 4. Owner report cover note drafting

- **What:** AI drafts a short, friendly paragraph for the cover of the monthly owner summary.
- **Bucket:** **Useful later (v1.5).**
- **Why:** Saves managers from writing 100 versions of "Hi, here's your monthly summary."
- **Guardrails:** Manager edits and sends. Numbers and line items are never AI-generated.

#### 5. WhatsApp message drafting

- **What:** Suggest a short message to send with a share link.
- **Bucket:** **Useful later (v1.5).**
- **Why:** Saves time; low risk.
- **Guardrails:** User reviews before sending. The message is just text — no auto-send.

#### 6. Duplicate issue detection

- **What:** When a new issue is created, AI checks recent issues at the same property and suggests "this looks like the same as issue #123 raised last week."
- **Bucket:** **Useful later (v2).**
- **Why:** Reduces noise; catches recurring problems early.
- **Guardrails:** Coordinator confirms. The original issue is never modified by the suggestion.

#### 7. Photo quality checking

- **What:** Detect blurry, too-dark, or empty-frame photos at capture time and prompt the inspector to retake.
- **Bucket:** **Expensive later (v2).**
- **Why:** Valuable, but on-device ML adds bundle size and battery cost; cloud calls per photo are expensive at 60,000 photos/month.
- **Guardrails:** Inspector can always override. Not a blocker for submission.
- **Alternative now:** Simple heuristics (file size, brightness histogram) can catch obvious cases without AI.

#### 8. Evidence pack summarisation

- **What:** AI drafts a narrative for an OTA dispute pack — "On [date], inspector [X] noted the following damage…"
- **Bucket:** **Useful later (v2).**
- **Why:** Saves significant manager time on disputes.
- **Guardrails:** Manager edits and signs off. Photos and timestamps remain the actual evidence.

#### 9. Predictive maintenance

- **What:** "Apartment 4B has had the same plumbing issue 3 times in 6 months — investigate."
- **Bucket:** **Useful later (v2).**
- **Why:** This is actually mostly statistics, not AI. We can ship a simple "recurrence" report in v1.5 without any model.
- **Guardrails:** Recommendation only; no auto-actions.

#### 10. AI-driven accountability / blame

- **What:** AI decides who is responsible for damage.
- **Bucket:** **Not recommended. Ever.**
- **Why:** Catastrophic failure mode. Manufactures disputes. Erodes trust. No amount of accuracy makes this a good idea.

#### 11. AI-generated owner reports

- **What:** AI writes the entire monthly summary including numbers.
- **Bucket:** **Not recommended.**
- **Why:** The whole product's value is structured evidence. We never let AI generate the numbers.

#### 12. AI customer support chatbot

- **What:** Chatbot embedded in the app that answers user questions.
- **Bucket:** **Not recommended yet.**
- **Why:** Out of scope for an operations product. Adds risk. Reconsider only if there's a clear customer need.

#### 13. Voice-to-text inspection notes

- **What:** Inspector dictates a note instead of typing.
- **Bucket:** **Useful later (v2).**
- **Why:** Speeds up note-taking in a real apartment context. Modest cost.
- **Guardrails:** The transcribed text is editable before submit.

#### 14. Auto-translation of reports

- **What:** Translate owner monthly summaries to the owner's preferred language.
- **Bucket:** **Useful later (v2+).**
- **Why:** Genuinely useful for multi-country operators. Cost is per page.
- **Guardrails:** The structured data is the truth; the translation is a courtesy view, marked "machine translation."

---

## Cost control

If we add AI features in v1.5+, costs must be visible and capped:

1. **Per-company monthly AI budget.** When exceeded, AI features quietly degrade to "off" rather than racking up cost.
2. **Inference happens server-side** behind our API. Never ship API keys to the browser.
3. **Cache aggressively** for repeated prompts (issue category suggestion for similar titles).
4. **Choose models by cost-fit.** Drafting a sentence does not need a frontier model.
5. **Disable AI features** for a tenant with a single toggle. Some customers will want this for compliance.
6. **Log every AI call** with token counts. We will be very glad to have this when the first cost spike happens.

---

## Privacy considerations

- AI prompts must not include guest PII unless absolutely necessary.
- Photos sent to a vision model are sent with as little surrounding metadata as possible.
- Customers must be told, in plain language, when AI processes their data.
- A per-company "AI features: off" switch is a hard requirement before we ship the first AI feature.

---

## Recap: what ships when

| Phase | AI features |
|---|---|
| MVP v1 | **None.** |
| v1.5 | Inspection summary drafting; issue severity suggestion; maintenance category suggestion; owner report cover note; WhatsApp message drafting. |
| v2 | Duplicate issue detection; photo quality checking (probably); evidence pack summarisation; voice-to-text notes; auto-translation. |
| Not planned | AI-driven accountability/blame; AI-generated reports; AI customer support chatbot. |
