-- ============================================================
-- Migration 0005 — Enable RLS (deny-by-default)
-- ============================================================
-- Per docs/DATABASE_SCHEMA_PLAN.md: "All tables have RLS enabled
-- before data is inserted." This migration enables RLS on every
-- business table WITHOUT writing any policies yet.
--
-- Effect: until policies are added, NO non-service-role role can
-- read or write these tables. The service_role bypasses RLS and
-- can still run migrations / seeding. This is the safe default —
-- if we ship to staging now and forget to add policies, no
-- accidental data leak is possible.
--
-- The full policy set arrives in the next session (its own
-- migration: 20260525*_rls_policies.sql) once auth + role lookup
-- is wired in.
--
-- System seed tables (roles, flag_categories) are READ-publicly
-- safe in concept, but we still enable RLS and rely on a public
-- SELECT policy in the next session. Same deny-by-default rule.
-- ============================================================

-- Tenancy and identity
alter table public.roles                          enable row level security;
alter table public.companies                      enable row level security;
alter table public.profiles                       enable row level security;
alter table public.company_memberships            enable row level security;
alter table public.invitations                    enable row level security;

-- Properties
alter table public.properties                     enable row level security;
alter table public.property_assignments           enable row level security;
alter table public.property_owner_links           enable row level security;

-- Stays
alter table public.stays                          enable row level security;

-- Inspection templates and instances
alter table public.inspection_templates           enable row level security;
alter table public.inspection_template_sections   enable row level security;
alter table public.inspection_template_items      enable row level security;
alter table public.property_template_overrides    enable row level security;
alter table public.inventory_items                enable row level security;
alter table public.inspections                    enable row level security;
alter table public.inspection_sections            enable row level security;
alter table public.inspection_items               enable row level security;

-- Flags and downstream actions
alter table public.flag_categories                enable row level security;
alter table public.flags                          enable row level security;
alter table public.issues                         enable row level security;
alter table public.maintenance_jobs               enable row level security;
alter table public.inventory_movements            enable row level security;

-- Guest recovery
alter table public.guest_recovery_tasks           enable row level security;
alter table public.recovery_attempts              enable row level security;

-- Approvals and accountability
alter table public.approval_policies              enable row level security;
alter table public.accountability_records         enable row level security;
alter table public.approval_decisions             enable row level security;

-- Photos
alter table public.photos                         enable row level security;

-- Owner communications
alter table public.weekly_status_updates          enable row level security;
alter table public.owner_monthly_summaries        enable row level security;
alter table public.owner_monthly_summary_lines    enable row level security;

-- Audit
alter table public.audit_events                   enable row level security;
