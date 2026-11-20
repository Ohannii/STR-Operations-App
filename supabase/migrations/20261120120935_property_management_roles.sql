-- Property metadata is managed by operational managers, including maintenance.
-- Keep company-member SELECT, and grant UPDATE only for the editable fields.
drop policy "members insert company properties" on public.properties;
drop policy "members update company properties" on public.properties;

create policy "managers insert company properties" on public.properties
  for insert to authenticated
  with check (public.has_company_role(company_id,
    array['company_admin', 'gm', 'ops_manager', 'maintenance_coordinator']));

create policy "managers update company properties" on public.properties
  for update to authenticated
  using (deleted_at is null and public.has_company_role(company_id,
    array['company_admin', 'gm', 'ops_manager', 'maintenance_coordinator']))
  with check (deleted_at is null and public.has_company_role(company_id,
    array['company_admin', 'gm', 'ops_manager', 'maintenance_coordinator']));

revoke update on public.properties from authenticated;
grant update (name, address, unit_reference, bedrooms, notes)
  on public.properties to authenticated;
