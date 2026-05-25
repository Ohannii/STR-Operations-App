-- ============================================================
-- Migration 0004 — System-wide seed data
-- ============================================================
-- These are the seeds that exist independently of any company:
--
--   * roles — 11 fixed role keys referenced by company_memberships.
--   * flag_categories — the 11 taxonomy rows from
--     docs/FLAG_AND_ACTION_MODEL.md, inserted with company_id = NULL.
--     Every company inherits them at lookup; per-company custom
--     categories arrive in v1.5+ (the unique key already supports
--     it: UNIQUE (company_id, key)).
--
-- Per-company seeds (default approval policy + the four inspection
-- templates) belong in a stored procedure or app-side seeding flow,
-- not here. That arrives in the next session.
--
-- Both inserts end with ON CONFLICT DO NOTHING so a partial-failure
-- recovery (or any accidental re-run) is idempotent. The
-- flag_categories ON CONFLICT depends on the UNIQUE NULLS NOT DISTINCT
-- constraint declared in the core schema migration.
-- ============================================================


-- ----------------------------------------------------------------
-- Roles
-- ----------------------------------------------------------------
-- Eleven role keys per docs/USER_ROLES_AND_PERMISSIONS.md.
insert into public.roles (key, display_label, description) values
  ('company_admin',          'Company Admin',
   'Top-level admin for one company. Edits policies, users, properties, templates.'),
  ('gm',                     'General Manager',
   'Approves over-limit charges, overrides caps with audit, oversees property owners.'),
  ('ops_manager',            'Operations Manager',
   'Triages flags, classifies and converts, runs day-to-day Action Centre work.'),
  ('maintenance_coordinator','Maintenance Coordinator',
   'Schedules and assigns maintenance jobs, verifies before/after evidence.'),
  ('inspector',              'Inspector',
   'Runs inspections in the field. Raises flags. Cannot classify or close them.'),
  ('maintenance_tech',       'Maintenance Technician',
   'Carries out maintenance jobs, captures before/after photos.'),
  ('inventory_manager',      'Inventory Manager',
   'Manages per-property inventory and approves owner-chargeable inventory lines.'),
  ('finance',                'Finance',
   'Read access for accountability records, monthly summaries, exports.'),
  ('auditor',                'Auditor',
   'Read access to audit_events for the company.'),
  ('property_owner_viewer',  'Property Owner (Viewer)',
   'Read-only access to sent reports and dispute evidence for their own properties.'),
  ('super_admin',            'Super Admin',
   'Platform-level admin. Used for support and rare cross-company operations.')
on conflict (key) do nothing;


-- ----------------------------------------------------------------
-- Flag categories — the 11 taxonomy rows
-- ----------------------------------------------------------------
-- Per docs/FLAG_AND_ACTION_MODEL.md and docs/SEED_DATA_PLAN.md.
-- company_id IS NULL marks these as system seeds.
-- default_action: 'no_action' | 'create_issue' | 'create_movement'
--                 | 'create_recovery' | 'create_accountability'
-- severity_default: 'low' | 'med' | 'high'
insert into public.flag_categories
  (company_id, key, display_label, icon, severity_default, default_action)
values
  (null, 'condition_note',          'Just a note',        'clipboard',      'low',  'no_action'),
  (null, 'cleaning_issue',          'Cleaning needed',    'broom',          'low',  'create_issue'),
  (null, 'maintenance_issue',       'Broken thing',       'wrench',         'med',  'create_issue'),
  (null, 'inventory_missing',       'Item missing',       'search-off',     'med',  'create_movement'),
  (null, 'inventory_damaged',       'Item damaged',       'broken-circle',  'med',  'create_movement'),
  (null, 'guest_damage',            'Guest broke it',     'user-x',         'high', 'create_recovery'),
  (null, 'owner_chargeable',        'Owner pays',         'wallet',         'low',  'create_accountability'),
  (null, 'company_responsibility',  'Company pays',       'building',       'low',  'create_accountability'),
  (null, 'safety_urgent',           'Safety!',            'alert-octagon',  'high', 'create_issue'),
  (null, 'follow_up_required',      'Check next time',   'calendar-clock', 'low',  'no_action'),
  (null, 'no_action_record',        'Just noting it',     'bookmark',       'low',  'no_action')
on conflict (company_id, key) do nothing;
-- ON CONFLICT works here because the UNIQUE constraint on
-- flag_categories(company_id, key) was declared NULLS NOT DISTINCT
-- in 20260524120100_core_schema.sql, so two (NULL, 'condition_note')
-- rows are treated as a conflict. Without that change, ON CONFLICT
-- on a NULL company_id would silently let duplicates through.
