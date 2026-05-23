# PROMPT_0_CLAUDE_PREP.md

You are working on a mobile-first SaaS product for short-term rental property management operations.

Important: DO NOT build the app yet.
Important: DO NOT write production code yet.
Important: DO NOT create package.json, migrations, components, API routes, or deployment configs yet unless explicitly requested later.

Your job in this session is to create the complete product and technical blueprint that will later be used for controlled development.

## Founder context

The founder is non-technical and needs step-by-step beginner guidance.

Explain work simply, as if guiding someone through the process for the first time.

## Product context

The app is for short-term rental property management companies.

It must help teams:
- conduct apartment inspections
- take pre-arrival and post-stay evidence photos
- track apartment lifecycle history
- track inventory movement and damage
- track maintenance issues
- track owner-chargeable items
- track guest/OTA accountability
- track unresolved issues
- produce evidence packs and reports
- monitor inspector and team performance
- manage operations across 100+ apartments
- eventually scale into SaaS for multiple companies

## Recommended product direction

- Mobile-first PWA for MVP
- Native app later only if required
- Web dashboard/admin backup later if useful
- Offline inspections required
- SaaS-ready architecture required
- Multi-company data isolation required
- Simple UX is mandatory
- AI features optional and not required for MVP
- Hostaway and WhatsApp are important future integrations
- Asana, Airbnb, Booking.com, Guesty, Google Calendar, Slack, and email are future integration candidates

## Device requirement

The app must be designed to work across:
- iPhone / iOS
- Android
- Mac
- Windows
- modern desktop browsers
- modern mobile browsers

Do not assume that building on Windows limits the app to Windows.

## MVP product position

This is an evidence-first operations system.
It is not a full PMS replacement in MVP.

The MVP should focus on:
- inspection workflows
- photo evidence
- issue creation
- maintenance tracking
- inventory/accountability tracking
- monthly owner-chargeable summaries
- operational dashboards
- exports and evidence packs

## Required user roles to analyse

- Super Admin / SaaS Owner
- Company Admin
- General Manager
- Operations Manager
- Property Manager
- Inspector
- Maintenance Coordinator
- Maintenance Technician / Contractor
- Inventory Manager
- Cleaner / Housekeeping User
- Finance/Admin User
- Property Owner Viewer
- Read-only Auditor

The General Manager must be able to monitor:
- employee performance
- inspection completion rates
- unresolved issues
- maintenance delays
- recurring problems
- apartment readiness
- accountability trends

## First instruction

Before producing anything:
1. Read CLAUDE_PROJECT_SKILLSET.md.
2. Read all docs files that exist.
3. Summarise what files are present and which are empty.
4. Explain the current state in simple language.
5. Identify missing information.
6. If missing information is not blocking, recommend a sensible default and continue.
7. If something is genuinely blocking, explain why.

## Your required output

Create or update the following files with complete planning content:

- docs/PROJECT_BRIEF.md
- docs/PRODUCT_REQUIREMENTS.md
- docs/TECHNICAL_ARCHITECTURE.md
- docs/DATABASE_SCHEMA_PLAN.md
- docs/USER_ROLES_AND_PERMISSIONS.md
- docs/INSPECTION_WORKFLOWS.md
- docs/INVENTORY_AND_MAINTENANCE_LOGIC.md
- docs/PHOTO_AND_EVIDENCE_SYSTEM.md
- docs/REPORTING_REQUIREMENTS.md
- docs/INTEGRATION_ROADMAP.md
- docs/AI_FEATURE_ROADMAP.md
- docs/TASK_LOG.md
- docs/CHANGELOG.md
- docs/KNOWN_ISSUES.md
- docs/TESTING_CHECKLIST.md
- docs/DEPLOYMENT_GUIDE.md
- docs/NON_TECHNICAL_USER_GUIDE.md

## Required analysis sections

Your response must include:

1. Current state summary
2. Assumption register
3. Competitor and best-practice synthesis
4. Product recommendation
5. Role and permissions model
6. MVP v1 boundary
7. v1.5 boundary
8. Later phase boundary
9. Mobile UX principles
10. Offline-first strategy
11. Photo/evidence strategy
12. Inventory/accountability strategy
13. Maintenance strategy
14. Reporting strategy
15. Integration strategy
16. AI feature classification
17. Technical stack recommendation
18. Database planning recommendation
19. Risk register
20. Testing strategy
21. Implementation roadmap
22. File update plan
23. Exact content to paste into each required project document

## Research requirements

Research and synthesise best-practice lessons from:
- RedRabbit
- Breezeway
- Properly
- Operto Teams
- Turno
- Hostaway
- Guesty
- Sweeply
- RoomChecking
- similar short-term rental or hospitality operations tools

Pay special attention to:
- inspection checklist structure
- mobile inspection UX
- photo proof workflows
- maintenance ticket creation from inspections
- readiness and cleanliness status
- owner statements and owner-facing evidence
- accountability and damage recovery support
- Hostaway integration readiness
- WhatsApp workflow readiness
- SaaS multi-tenancy and permissions
- offline PWA constraints
- iPhone/Safari limitations
- photo storage cost control
- AI cost control

## Recommended stack to evaluate

Evaluate and recommend from:
- Claude Projects
- GitHub
- VS Code
- Next.js PWA
- Supabase
- Vercel
- Supabase Storage
- Cloudinary or Cloudflare R2 later if needed
- React Native / Expo later if needed
- Replit only as disposable prototype support, not primary production system

Explain recommendations in simple language.

## Hard rules

Do not:
- code yet
- create production app files yet
- build UI yet
- create database migrations yet
- connect services yet
- deploy yet
- turn this into a full PMS
- make AI features mandatory
- ignore offline sync
- ignore iOS/PWA constraints
- ignore photo storage costs
- ignore audit trails
- ignore tenant isolation
- ignore role permissions

Always:
- explain decisions simply
- identify trade-offs
- use conservative, low-cost, scalable defaults
- separate MVP from later phases
- create documentation that can survive Claude rate limits
- update TASK_LOG.md
- update CHANGELOG.md
- update KNOWN_ISSUES.md
- update TESTING_CHECKLIST.md

## End of session requirement

At the end:
- list all files that should be updated
- list unresolved decisions
- list the safest next step
- do not generate build code
- do not generate final build prompts yet unless specifically asked
