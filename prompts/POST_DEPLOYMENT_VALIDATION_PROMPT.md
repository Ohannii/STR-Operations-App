# POST_DEPLOYMENT_VALIDATION_PROMPT.md

We have deployed. Run post-deployment validation.

Check and summarise:
- app loads
- login works for expected roles
- dashboards load
- inspection draft save works
- photo upload works
- queue/sync state is visible
- reports/export paths work
- permissions are correct
- no critical visible runtime errors
- mobile usability is acceptable on a real phone

Return:
- pass/fail summary
- critical issues
- rollback recommendation if needed
- follow-up fixes

Update:
- docs/CHANGELOG.md
- docs/KNOWN_ISSUES.md
- docs/TESTING_CHECKLIST.md
