-- Verified external property identities. No investor/contact data is seeded here.
-- The composite FK prevents a mapping from naming another company's property.
create unique index uq_properties_id_company on public.properties(id, company_id);

create table public.property_asana_identities (
  property_id uuid primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  estate_key text not null check (estate_key in ('ballito_life', 'ballito_village')),
  unit_number text not null check (unit_number ~ '^(0|[1-9][0-9]*)$'),
  investor_task_gid text not null check (investor_task_gid ~ '^[0-9]+$'),
  investor_reference text not null check (length(investor_reference) between 1 and 200),
  unit_option_gid text not null check (unit_option_gid ~ '^[0-9]+$'),
  unit_option_label text not null check (length(unit_option_label) between 1 and 200),
  verified_at timestamptz not null default now(),
  verified_by uuid not null references public.profiles(id),
  foreign key (property_id, company_id) references public.properties(id, company_id) on delete cascade,
  unique (company_id, estate_key, unit_number),
  unique (company_id, investor_task_gid),
  unique (company_id, unit_option_gid)
);

alter table public.property_asana_identities enable row level security;
revoke all on public.property_asana_identities from public, anon, authenticated, service_role;
grant select on public.property_asana_identities to authenticated, service_role;
create policy "members read company property identities"
  on public.property_asana_identities for select to authenticated
  using (public.is_company_member(company_id));
