# Company AI connections

Confirmed product direction: support both an AI helper inside STR Operations and
connections from a company's existing ChatGPT/Claude apps, starting with the
in-app helper. These are requirements; neither connection is implemented by
this documentation update. The inspection reliability fixes remain separate.

## In-app helper first

A company can choose a supported OpenAI or Anthropic provider connection in its
integration settings, subject to verifying the provider's current supported
authentication and API terms. Do not assume a consumer chat subscription grants
API access. Do not ask staff to paste keys into chat or put them in the client.
Store credentials server-side, isolated by company, with revocation/rotation.

Initial useful actions are answering questions about permitted work, finding
apartments or inspections, summarising source evidence and drafting issue or
report text. Responses link to the source records and distinguish unavailable,
stale or missing data. Provider failure must not block inspection, upload,
reporting or submission. Existing AI roadmap principles still apply.

Use the existing editing and Save/Submit steps for AI drafts; do not add a second
acceptance workflow just because AI helped. Preserve actual staff authorship and
audit, and identify generated suggestions. AI must not invent bookings, evidence,
financial totals, blame, charges or guest readiness. Any introduced write tool
must call the same guarded server action as the ordinary UI, with tenant, role,
record ownership, concurrency and retry protections enforced outside the model.

## External ChatGPT and Claude connections next

Provide an authenticated app/tool connection, using a supported vendor mechanism
such as MCP where appropriate. Verify each vendor's current capability before
promising compatibility. A staff member connects to their own authorised company
context; the connection cannot bypass app membership or reveal another company's
records. Begin with useful read/draft tools and introduce scoped writes only
through the existing permissions and guarded actions.

The AI connection and PMS connector are independent. The same normalised
calendar, turnover, issue and evidence records should serve the UI and tools.
Neither a company-wide model key nor an assistant's prompt is proof that a
particular staff member may access a record. Define which data is sent to a
provider, minimise it, make processing understandable and provide an off switch
and visible per-company cost limits.

## Implementation order

Finish the controlled phone acceptance, then implement verified PMS checkout sync
and the calendar (`PMS_CALENDAR_SCOPE.md`). Add the in-app AI helper on top of the
verified data, then external assistant connections. User confirmation of in-app
first sets the order within AI work; it does not replace the urgent PMS task.

Development-agent review protocol is in `DEVELOPMENT_REVIEW_PROTOCOL.md`; it is
separate from the product AI connection scope.
