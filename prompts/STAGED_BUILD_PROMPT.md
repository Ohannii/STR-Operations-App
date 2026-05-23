# STAGED_BUILD_PROMPT.md

## When to use this prompt

Once tooling setup is complete and the v1.0 skeleton exists, every build session opens with a version of this prompt. The point is to force per-session scope to **one v1 stage at a time** so scope doesn't creep across stages.

Replace `{stage}` with `v1.0` / `v1.1` / `v1.2` / `v1.3` as appropriate.

---

## The prompt

```
We are building {stage} of the STR ops product.

Important:
- Stay strictly inside {stage}'s scope as defined in docs/PRODUCT_REQUIREMENTS.md.
- Do not start anything from later stages even if it seems close or convenient.
- If a later-stage feature appears necessary for this stage, surface the question; do not just build it.
- Save each file to disk as it is completed (save-as-you-go rule).
- Follow CLAUDE_PROJECT_SKILLSET.md at all times.

Read first:
- docs/PRODUCT_REQUIREMENTS.md ({stage} section)
- docs/DATABASE_SCHEMA_PLAN.md (the consolidated final schema)
- docs/TASK_LOG.md (what's been done / what's next)
- docs/KNOWN_ISSUES.md (current risks)
- docs/TESTING_CHECKLIST.md ({stage} milestone gate)
- Whatever stage-specific docs apply (e.g., for v1.0: TURNOVER_INSPECTION_WORKFLOW.md, EVIDENCE_CAMERA_AND_PHOTO_NOTES.md, APARTMENT_ACTION_CENTRE.md, FLAG_AND_ACTION_MODEL.md, DEDUPLICATION_AND_TASK_GROUPING_RULES.md, TEMPLATE_AND_INVENTORY_MODEL.md, EVIDENCE_VAULT_AND_WHATSAPP_WORKFLOW.md)

For each new module:
1. Confirm the scope is in {stage}, not later.
2. Confirm the data shape matches docs/DATABASE_SCHEMA_PLAN.md.
3. Confirm the UX follows the stupid-proof rules.
4. Confirm flag-as-parent and Action-Centre-as-home discipline (DEDUPLICATION_AND_TASK_GROUPING_RULES.md).
5. Write code in small, reviewable steps.
6. Write tests for each module as it is built.

At the end of the session:
1. Run the session close ritual (CLAUDE_PROJECT_SKILLSET.md).
2. Update TASK_LOG.md with what shipped this session.
3. Update CHANGELOG.md.
4. List anything found that should change in docs (for separate approval, not silent changes).

Do not:
- Pull a future-stage feature forward.
- Skip the field test before declaring {stage} done.
- Connect to production data.
- Build features that don't have acceptance tests in TESTING_CHECKLIST.md.
```

---

## How to use it

1. Open a fresh Claude session.
2. Paste the prompt above, with `{stage}` replaced.
3. Add a one-line goal for this session: e.g., "Today we're building the inspection workflow screens for v1.0."
4. Let Claude read, then work through the goal.

---

## Why this exists

Without per-stage scoping, Claude (or any developer) drifts: "while I'm here I'll also add X." Drift is what made v1 too big in the first place. The staged plan only works if each session enforces it.
