-- ============================================================
-- Migration 0003 — Indexes
-- ============================================================
-- Indexes per the MVP indexing plan in docs/DATABASE_SCHEMA_PLAN.md.
--
-- Rules:
--   - Every company_id column gets an index (tenant filter, hot path).
--   - Every property_id column gets an index (Action Centre queries).
--   - Every parent_flag_id column gets an index (flag-as-parent rule).
--   - Every stay_id column gets an index (Evidence Vault).
--   - Composite indexes for known hot queries (Action Centre listing,
--     Evidence Vault filters, monthly/annual cap calculations,
--     audit lookups).
--
-- All indexes are plain B-tree. No partial indexes in v1.0 — those
-- arrive when query patterns harden in v1.2+.
-- ============================================================


-- ----------------------------------------------------------------
-- company_id indexes (one per business table)
-- ----------------------------------------------------------------
create index idx_company_memberships_company_id      on public.company_memberships(company_id);
create index idx_invitations_company_id              on public.invitations(company_id);
create index idx_properties_company_id               on public.properties(company_id);
create index idx_property_assignments_company_id     on public.property_assignments(company_id);
create index idx_property_owner_links_company_id     on public.property_owner_links(company_id);
create index idx_stays_company_id                    on public.stays(company_id);
create index idx_inspection_templates_company_id     on public.inspection_templates(company_id);
create index idx_property_template_overrides_company_id on public.property_template_overrides(company_id);
create index idx_inventory_items_company_id          on public.inventory_items(company_id);
create index idx_inspections_company_id              on public.inspections(company_id);
create index idx_flag_categories_company_id          on public.flag_categories(company_id);
create index idx_flags_company_id                    on public.flags(company_id);
create index idx_issues_company_id                   on public.issues(company_id);
create index idx_maintenance_jobs_company_id         on public.maintenance_jobs(company_id);
create index idx_inventory_movements_company_id      on public.inventory_movements(company_id);
create index idx_guest_recovery_tasks_company_id     on public.guest_recovery_tasks(company_id);
create index idx_approval_policies_company_id        on public.approval_policies(company_id);
create index idx_accountability_records_company_id   on public.accountability_records(company_id);
create index idx_approval_decisions_company_id       on public.approval_decisions(company_id);
create index idx_photos_company_id                   on public.photos(company_id);
create index idx_weekly_status_updates_company_id    on public.weekly_status_updates(company_id);
create index idx_owner_monthly_summaries_company_id  on public.owner_monthly_summaries(company_id);
create index idx_audit_events_company_id             on public.audit_events(company_id);


-- ----------------------------------------------------------------
-- property_id indexes
-- ----------------------------------------------------------------
create index idx_property_assignments_property_id    on public.property_assignments(property_id);
create index idx_property_owner_links_property_id    on public.property_owner_links(property_id);
create index idx_stays_property_id                   on public.stays(property_id);
create index idx_property_template_overrides_property_id on public.property_template_overrides(property_id);
create index idx_inventory_items_property_id         on public.inventory_items(property_id);
create index idx_inspections_property_id             on public.inspections(property_id);
create index idx_flags_property_id                   on public.flags(property_id);
create index idx_issues_property_id                  on public.issues(property_id);
create index idx_maintenance_jobs_property_id        on public.maintenance_jobs(property_id);
create index idx_inventory_movements_property_id     on public.inventory_movements(property_id);
create index idx_guest_recovery_tasks_property_id    on public.guest_recovery_tasks(property_id);
create index idx_accountability_records_property_id  on public.accountability_records(property_id);
create index idx_approval_decisions_property_id      on public.approval_decisions(property_id);
create index idx_photos_property_id                  on public.photos(property_id);
create index idx_weekly_status_updates_property_id   on public.weekly_status_updates(property_id);
create index idx_owner_monthly_summaries_property_id on public.owner_monthly_summaries(property_id);


-- ----------------------------------------------------------------
-- parent_flag_id indexes (the flag-as-parent rule)
-- ----------------------------------------------------------------
create index idx_issues_parent_flag_id                on public.issues(parent_flag_id);
create index idx_maintenance_jobs_parent_flag_id      on public.maintenance_jobs(parent_flag_id);
create index idx_inventory_movements_parent_flag_id   on public.inventory_movements(parent_flag_id);
create index idx_guest_recovery_tasks_parent_flag_id  on public.guest_recovery_tasks(parent_flag_id);
create index idx_accountability_records_parent_flag_id on public.accountability_records(parent_flag_id);


-- ----------------------------------------------------------------
-- stay_id indexes (Evidence Vault, turnover pairing)
-- ----------------------------------------------------------------
create index idx_inspections_outgoing_stay_id   on public.inspections(outgoing_stay_id);
create index idx_inspections_incoming_stay_id   on public.inspections(incoming_stay_id);
create index idx_flags_stay_id                  on public.flags(stay_id);
create index idx_guest_recovery_tasks_stay_id   on public.guest_recovery_tasks(stay_id);
create index idx_photos_stay_id                 on public.photos(stay_id);


-- ----------------------------------------------------------------
-- Composite indexes for known hot queries
-- ----------------------------------------------------------------

-- Action Centre flag listing — open work per property
create index idx_flags_property_status
  on public.flags(property_id, status)
  where deleted_at is null;

-- Evidence Vault filtering — photos by property + retention + time
create index idx_photos_property_retention_captured
  on public.photos(property_id, retention_class, captured_at);

-- Recovery attempts timeline per task
create index idx_recovery_attempts_task_recorded
  on public.recovery_attempts(task_id, recorded_at);

-- Monthly / annual cap rollups per property
create index idx_approval_decisions_property_decided
  on public.approval_decisions(property_id, decided_at);

-- Audit history per entity
create index idx_audit_events_entity
  on public.audit_events(entity_type, entity_id, created_at);


-- ----------------------------------------------------------------
-- Misc helpful indexes
-- ----------------------------------------------------------------

-- Inspection items by inspection + section (drives the inspection screen)
create index idx_inspection_items_inspection_section
  on public.inspection_items(inspection_id, section_id);

-- Photos by inspection (drives evidence drawer in an inspection)
create index idx_photos_inspection_id on public.photos(inspection_id);

-- Photos by flag (drives evidence drawer on a flag card)
create index idx_photos_flag_id on public.photos(flag_id);

-- Inventory movements by item (drives item history view)
create index idx_inventory_movements_inventory_item_id
  on public.inventory_movements(inventory_item_id);
