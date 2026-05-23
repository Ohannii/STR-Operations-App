# USER_ROLES_AND_PERMISSIONS.md

## Role catalogue

| Role key             | Display name                    | Scope        | One-line purpose                                                              |
| -------------------- | ------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| `super_admin`        | Super Admin / SaaS Owner        | Cross-tenant | Manages the SaaS itself; can impersonate for support (audited).               |
| `company_admin`      | Company Admin                   | Company      | Full control inside one company.                                              |
| `general_manager`    | General Manager                 | Company      | Visibility into everything; manages team performance.                         |
| `operations_manager` | Operations Manager              | Company      | Runs daily operations, approves accountability.                               |
| `property_manager`   | Property Manager                | Properties   | Manages a portfolio of properties.                                            |
| `inspector`          | Inspector                       | Properties   | Performs inspections, captures evidence.                                      |
| `maintenance_coord`  | Maintenance Coordinator         | Company      | Assigns and tracks maintenance jobs.                                          |
| `maintenance_tech`   | Maintenance Technician          | Jobs         | Executes assigned maintenance, captures before/after photos.                  |
| `inventory_manager`  | Inventory Manager               | Company      | Manages inventory templates and reviews movements.                            |
| `cleaner`            | Cleaner / Housekeeping User     | Properties   | Records cleaning checklist completion (post-MVP role; placeholder in v1).     |
| `finance_admin`      | Finance / Admin User            | Company      | Reviews chargeable summaries and exports.                                     |
| `owner_viewer`       | Property Owner Viewer           | Properties   | Read-only access to their own properties' inspections and monthly summaries.  |
| `read_only_auditor`  | Read-only Auditor               | Company      | Read-only across the company; for external auditors / due diligence.          |

---

## Permission principles

1. **Least privilege.** A role starts with nothing and gets only what it needs.
2. **Company-level data isolation.** Even a role with "see everything" can only see everything *inside their company*.
3. **Property assignment scope.** Roles like Inspector and Property Manager only see properties they're explicitly assigned to (unless GM/Admin elevation).
4. **Owner viewers** only see their linked properties — never others, never company-wide data.
5. **Contractors** (`maintenance_tech` not on company payroll) only see maintenance jobs assigned to them.
6. **Approval gates** for owner-chargeable / accountability decisions live in Operations Manager, GM, or Company Admin — not in field roles.
7. **Audit access** is for Company Admin and GM in MVP; read-only auditors can read but not export sensitive PII in MVP.

---

## Permission matrix (MVP v1)

Legend: ✅ = allowed, ⬜ = not allowed, 🔒 = allowed only for own/assigned scope, 🔑 = requires approval step.

### Properties

| Action                          | super_admin | company_admin | GM | ops_mgr | property_mgr | inspector | maint_coord | maint_tech | inv_mgr | finance | owner_viewer | auditor |
| ------------------------------- | ----------- | ------------- | -- | ------- | ------------ | --------- | ----------- | ---------- | ------- | ------- | ------------ | ------- |
| List company properties         | ✅          | ✅            | ✅ | ✅      | 🔒           | 🔒        | ✅          | ⬜         | ✅      | ✅      | 🔒           | ✅      |
| Create / edit property          | ✅          | ✅            | ✅ | ✅      | ⬜           | ⬜        | ⬜          | ⬜         | ⬜      | ⬜      | ⬜           | ⬜      |
| Archive property                | ✅          | ✅            | ✅ | ⬜      | ⬜           | ⬜        | ⬜          | ⬜         | ⬜      | ⬜      | ⬜           | ⬜      |

### Inspection templates

Two layers (see `TEMPLATE_AND_INVENTORY_MODEL.md`): **company standard templates** (apply to all properties) and **property-level overrides** (customise one apartment). They have different permission bars because a company-standard edit is far more impactful than a single-property tweak.

| Action                          | super_admin | company_admin | GM | ops_mgr | property_mgr | inspector | maint_coord | inv_mgr |
| ------------------------------- | ----------- | ------------- | -- | ------- | ------------ | --------- | ----------- | ------- |
| List templates                  | ✅          | ✅            | ✅ | ✅      | ✅           | ✅        | ✅          | ✅      |
| Create / edit **company standard** template (v1.3) | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| Archive company standard template | ✅        | ✅            | ⬜ | ⬜      | ⬜           | ⬜        | ⬜          | ⬜      |
| Create / edit **property-level override** (v1.3) | ✅ | ✅ | ✅ | ✅ 🔒(assigned) | ✅ 🔒(assigned) | ⬜ | ⬜ | ⬜ |
| Edit a property's **inventory list** | ✅      | ✅            | ✅ | ✅      | ✅ 🔒(assigned) | ⬜      | ⬜          | ✅      |
| Add a **one-off item** inside an in-progress inspection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | ⬜ |

Rationale: company-standard edits affect every property and sit with Company Admin (financial/operational consistency). Property overrides and per-property inventory are day-to-day operational and sit with managers (including Property Manager for their assigned properties). Inspectors can add a one-off check during an inspection (life surprises them) but cannot change the durable template.

### Inspections

| Action                                | company_admin | GM | ops_mgr | property_mgr | inspector | maint_tech | finance | owner_viewer |
| ------------------------------------- | ------------- | -- | ------- | ------------ | --------- | ---------- | ------- | ------------ |
| Start an inspection                   | ✅            | ✅ | ✅      | 🔒           | 🔒        | ⬜         | ⬜      | ⬜           |
| Save draft / edit own draft           | ✅            | ✅ | ✅      | 🔒           | 🔒        | ⬜         | ⬜      | ⬜           |
| Submit inspection                     | ✅            | ✅ | ✅      | 🔒           | 🔒        | ⬜         | ⬜      | ⬜           |
| View company inspections              | ✅            | ✅ | ✅      | 🔒           | 🔒        | ⬜         | ✅      | 🔒 (own)     |
| Reopen / edit submitted inspection    | ✅            | ✅ | 🔑      | ⬜           | ⬜        | ⬜         | ⬜      | ⬜           |
| Delete inspection (soft)              | ✅            | ✅ | ⬜      | ⬜           | ⬜        | ⬜         | ⬜      | ⬜           |

### Photos / evidence

| Action                                | company_admin | GM | ops_mgr | property_mgr | inspector | maint_tech | finance | owner_viewer |
| ------------------------------------- | ------------- | -- | ------- | ------------ | --------- | ---------- | ------- | ------------ |
| Upload photo to own inspection / job  | ✅            | ✅ | ✅      | 🔒           | 🔒        | 🔒         | ⬜      | ⬜           |
| View company photos                   | ✅            | ✅ | ✅      | 🔒           | 🔒        | 🔒         | ✅      | 🔒 (own)     |
| Delete photo                          | ✅            | ✅ | 🔑      | ⬜           | 🔒 (own, before submit) | ⬜ | ⬜  | ⬜           |

### Issues

| Action                                | company_admin | GM | ops_mgr | property_mgr | inspector | maint_coord | maint_tech | finance |
| ------------------------------------- | ------------- | -- | ------- | ------------ | --------- | ----------- | ---------- | ------- |
| Create issue                          | ✅            | ✅ | ✅      | 🔒           | 🔒        | ✅          | 🔒         | ⬜      |
| Edit issue                            | ✅            | ✅ | ✅      | 🔒           | 🔒 (own, before assignment) | ✅ | 🔒    | ⬜      |
| Change issue status                   | ✅            | ✅ | ✅      | 🔒           | ⬜        | ✅          | 🔒 (own jobs) | ⬜    |
| Assign issue to a tech                | ✅            | ✅ | ✅      | ⬜           | ⬜        | ✅          | ⬜         | ⬜      |

### Maintenance jobs

| Action                                | company_admin | GM | ops_mgr | maint_coord | maint_tech | finance |
| ------------------------------------- | ------------- | -- | ------- | ----------- | ---------- | ------- |
| Create job from issue                 | ✅            | ✅ | ✅      | ✅          | ⬜         | ⬜      |
| Update job status / cost              | ✅            | ✅ | ✅      | ✅          | 🔒 (own jobs, limited fields) | ⬜ |
| View all company jobs                 | ✅            | ✅ | ✅      | ✅          | 🔒         | ✅      |
| Verify completed job                  | ✅            | ✅ | ✅      | ✅          | ⬜         | ⬜      |

### Inventory and accountability

| Action                                | company_admin | GM | ops_mgr | inv_mgr | inspector | finance | owner_viewer |
| ------------------------------------- | ------------- | -- | ------- | ------- | --------- | ------- | ------------ |
| Manage inventory items / templates    | ✅            | ✅ | ✅      | ✅      | ⬜        | ⬜      | ⬜           |
| Record inventory movement             | ✅            | ✅ | ✅      | ✅      | 🔒        | ⬜      | ⬜           |
| Create accountability record          | ✅            | ✅ | ✅      | ✅      | 🔒        | ⬜      | ⬜           |
| **Approve** owner-chargeable status   | ✅            | ✅ | ✅ 🔑   | ⬜      | ⬜        | ⬜      | ⬜           |
| **Approve** guest/OTA chargeable      | ✅            | ✅ | ✅ 🔑   | ⬜      | ⬜        | ⬜      | ⬜           |
| View accountability records           | ✅            | ✅ | ✅      | ✅      | 🔒 (own)  | ✅      | 🔒 (own)     |

### Reports

| Action                                | company_admin | GM | ops_mgr | finance | owner_viewer | auditor |
| ------------------------------------- | ------------- | -- | ------- | ------- | ------------ | ------- |
| View inspection report                | ✅            | ✅ | ✅      | ✅      | 🔒 (own)     | ✅      |
| Generate owner monthly summary        | ✅            | ✅ | ✅      | ✅      | ⬜           | ⬜      |
| Send owner monthly summary            | ✅            | ✅ | ✅      | ✅      | ⬜           | ⬜      |
| Generate weekly owner status update   | ✅            | ✅ | ✅      | ⬜      | ⬜           | ⬜      |
| Send weekly owner status update       | ✅            | ✅ | ✅      | ⬜      | ⬜           | ⬜      |
| View own property weekly update       | ⬜            | ⬜ | ⬜      | ⬜      | ✅ (sent only) | ⬜    |
| Export OTA evidence pack              | ✅            | ✅ | ✅      | ✅      | ⬜           | ⬜      |
| Read audit log                        | ✅            | ✅ | ⬜      | ⬜      | ⬜           | 🔒 (limited fields, no PII export) |

### Approval policies and overrides (new — v1.2)

Approval policies represent contract obligations between the company and the owner. They are not casual operational settings — changing them has financial and legal consequences. The permissions are deliberately tight.

(See `APPROVAL_LIMITS_AND_CONTRACT_RULES.md` for the full policy model.)

| Action                                                | super_admin | company_admin | GM       | ops_mgr | inspector | finance | owner_viewer |
| ----------------------------------------------------- | ----------- | ------------- | -------- | ------- | --------- | ------- | ------------ |
| View company-level approval policy                    | ✅          | ✅            | ✅       | ✅      | ⬜        | ✅      | ⬜           |
| Edit company-level approval policy                    | ✅          | ✅            | ⬜       | ⬜      | ⬜        | ⬜      | ⬜           |
| Add / edit owner-level override                       | ✅          | ✅            | ✅ 🔑    | ⬜      | ⬜        | ⬜      | ⬜           |
| Add / edit property-level override                    | ✅          | ✅            | ✅ 🔑    | ⬜      | ⬜        | ⬜      | ⬜           |
| Add / edit category-level override (v1.5)             | ✅          | ✅            | ✅ 🔑    | ⬜      | ⬜        | ⬜      | ⬜           |
| Override a cap on a single approval (one-off)         | ✅ 🔑       | ✅ 🔑         | ✅ 🔑    | ⬜      | ⬜        | ⬜      | ⬜           |
| **Invoke emergency over-limit maintenance** (safety/urgent, proceed before approval) | ✅ 🔑 | ✅ 🔑 | ✅ 🔑 | ✅ 🔑 | ⬜ | ⬜ | ⬜ |
| **Conduct post-event review of an emergency override** | ✅ | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ |
| Record owner approval response                        | ✅          | ✅            | ✅       | ✅      | ⬜        | ⬜      | ⬜           |
| View approval decisions audit                         | ✅          | ✅            | ✅       | ✅      | ⬜        | ✅      | ⬜           |
| Edit a historical approval_decisions row              | ✅ 🔑       | ⬜            | ⬜       | ⬜      | ⬜        | ⬜      | ⬜           |

Legend reminders:
- 🔑 = audited; the action writes a prominent audit event including the actor's name, the previous value, and the new value.
- ⬜ = not allowed at all.

**Why the company-level policy is Company Admin only:** changing the headline caps (R1,000 / R2,000 / R2,000 monthly / R60,000 annual) affects every property under the company without going through any per-property override. This is a financial-policy change, not an operational setting; it sits with the role accountable for the business relationship.

**Why GM can do owner/property overrides but not company-level:** real-world contracts vary by owner (a long-trusted owner may give a higher cap; a new owner may impose a lower one). GM is close enough to the owner relationships to manage these without escalating to Company Admin for every variation.

**Why one-off overrides are audited especially heavily:** the override path exists for genuine emergencies (e.g., midnight burst pipe at R5,000 to stop the leak). It must be available but rarely used. Every override requires a written reason and is audited prominently. Frequent overrides are a sign the policy needs adjusting, not that the override path is the right tool.

**Emergency over-limit maintenance vs a one-off cap override:** these are related but distinct. A *one-off cap override* finalises a charge above the cap when the owner can't be reached in time. An *emergency over-limit maintenance* invocation lets safety/urgent work physically *proceed* before any approval, with the financial decision following. Ops Manager can invoke the emergency path (because safety can't wait for a GM at 2am), but the **post-event review** of that override sits with GM / Company Admin, who confirm the spend was justified and decide final chargeability. Both write prominent audit rows. See `APPROVAL_LIMITS_AND_CONTRACT_RULES.md`.

### Users and roles

| Action                                | super_admin | company_admin | GM |
| ------------------------------------- | ----------- | ------------- | -- |
| Invite user to company                | ✅          | ✅            | 🔑 |
| Change a user's role                  | ✅          | ✅            | ⬜ |
| Deactivate a user                     | ✅          | ✅            | ⬜ |
| View other companies                  | ✅          | ⬜            | ⬜ |
| Impersonate (support mode)            | ✅ (audited)| ⬜            | ⬜ |

---

## Where these rules live in code

- **At the database:** RLS policies enforce the company-isolation and role-based access for every `SELECT/INSERT/UPDATE/DELETE`. This is the **floor** — the app cannot bypass it even with a bug.
- **In server code** (Next.js Route Handlers, Edge Functions): a `requirePermission(user, action, entity)` helper checks role + scope before any privileged write. Approval gates (`🔑`) are enforced here.
- **In the UI:** the same `can(user, action, entity)` helper hides buttons the user can't use. UI hiding is **not security** — it's just UX. The real check is in code and RLS.

---

## What we are *not* shipping in MVP

- Custom role builder (companies cannot define their own roles).
- Fine-grained per-property permission edits (you assign a user to a property, period).
- Per-field redaction (e.g., hiding cost from inspectors).
- Time-limited access grants.
- API tokens for external integrations.

All of those are credible v2+ features. They are not needed for the MVP.

---

## Open questions to revisit

1. Should Inspectors see *cost estimates* on issues they raised? — Recommendation: **No** in MVP. Costs are an Ops/Finance concern.
2. Should Owner Viewers be able to download a PDF of their summary? — Recommendation: **Yes**, but only the approved version.
3. Should a Property Manager be able to approve owner-chargeable items? — Recommendation: **No** in MVP. Keep the approval gate at Ops Manager and above so the audit story stays clean.
4. Do we need a "limited owner viewer" that can't see staff names? — Defer to v1.5 if customers ask for it.
