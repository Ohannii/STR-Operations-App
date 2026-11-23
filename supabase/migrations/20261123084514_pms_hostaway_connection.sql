-- Company Hostaway connection and verified physical-unit mappings only.
-- No reservation sync, worker, automatic schedules or Hostaway writes are enabled.
-- Token material lives only in Vault. All writes/secret reads use service-only
-- RPCs that recheck the server-authenticated actor's current company-admin role.
do $$ begin
  if to_regclass('vault.secrets') is null or to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Supabase Vault must be available before PMS setup';
  end if;
end $$;

create table public.pms_connections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  provider text not null default 'hostaway' check (provider='hostaway'),
  account_id text not null check (account_id ~ '^[1-9][0-9]{0,17}$'),
  status text not null check (status in ('connected','disconnected')),
  credential_id uuid,
  credential_expires_at timestamptz,
  revision bigint not null default 1 check (revision>0),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id,provider), unique(company_id,id),
  check ((status='connected' and credential_id is not null and credential_expires_at is not null)
    or (status='disconnected' and credential_id is null and credential_expires_at is null))
);
create table public.pms_listing_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  connection_id uuid not null,
  listing_id text not null check (listing_id ~ '^[1-9][0-9]{0,17}$'),
  unit_id text not null default '0' check (unit_id ~ '^(0|[1-9][0-9]{0,17})$'),
  property_id uuid not null references public.properties(id),
  listing_name text not null check (length(listing_name) between 1 and 500),
  unit_name text check (unit_name is null or length(unit_name) between 1 and 500),
  time_zone text check (time_zone is null or length(time_zone) between 1 and 100),
  revision bigint not null default 1 check (revision>0),
  verified_by uuid not null references public.profiles(id),
  verified_at timestamptz not null default now(),
  foreign key(company_id,connection_id) references public.pms_connections(company_id,id),
  unique(connection_id,listing_id,unit_id),
  unique(connection_id,property_id)
);
create index pms_mapping_property on public.pms_listing_mappings(company_id,property_id);
alter table public.pms_connections enable row level security;
alter table public.pms_listing_mappings enable row level security;
revoke all on public.pms_connections,public.pms_listing_mappings from public,anon,authenticated,service_role;
grant select(id,company_id,provider,account_id,status,credential_expires_at,revision,created_at,updated_at)
  on public.pms_connections to authenticated;
grant select on public.pms_listing_mappings to authenticated;
grant select on public.pms_connections,public.pms_listing_mappings to service_role;
create policy pms_admin_reads_connection on public.pms_connections for select to authenticated
  using (public.has_company_role(company_id,array['company_admin']));
create policy pms_admin_reads_mapping on public.pms_listing_mappings for select to authenticated
  using (public.has_company_role(company_id,array['company_admin']));

create function public.pms_require_setup_admin(p_company_id uuid,p_actor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_actor_id is null or not exists (
    select 1 from public.company_memberships m join public.companies c on c.id=m.company_id
    join public.profiles p on p.id=m.user_id
    where m.company_id=p_company_id and m.user_id=p_actor_id and m.role_key='company_admin'
      and m.is_active and m.deleted_at is null and c.deleted_at is null and p.deleted_at is null
  ) then raise exception 'not_authorized' using errcode='42501'; end if;
end $$;

create function public.save_hostaway_connection(p_company_id uuid,p_actor_id uuid,p_account_id text,
  p_access_token text,p_expires_at timestamptz,p_expected_revision bigint)
returns uuid language plpgsql security definer set search_path='' as $$
declare v public.pms_connections%rowtype; v_id uuid; v_secret uuid;
begin
  perform public.pms_require_setup_admin(p_company_id,p_actor_id);
  if p_account_id is null or p_account_id !~ '^[1-9][0-9]{0,17}$'
    or p_access_token is null or length(p_access_token) not between 16 and 16000
    or p_expires_at is null or p_expires_at<=now() or p_expires_at>now()+interval '3 years'
    or p_expected_revision is null or p_expected_revision<0 then
    raise exception 'invalid_connection' using errcode='22023';
  end if;
  perform 1 from public.companies where id=p_company_id for no key update;
  select * into v from public.pms_connections where company_id=p_company_id and provider='hostaway' for no key update;
  if coalesce(v.revision,0)<>p_expected_revision then raise exception 'stale_connection' using errcode='40001'; end if;
  if v.id is not null and v.account_id<>p_account_id then
    raise exception 'account_transfer_requires_review' using errcode='55000';
  end if;
  v_id:=coalesce(v.id,gen_random_uuid());
  if v.credential_id is null then
    v_secret:=vault.create_secret(p_access_token,'pms-hostaway-'||v_id::text,'Hostaway access token');
  else
    perform vault.update_secret(v.credential_id,p_access_token);
    v_secret:=v.credential_id;
  end if;
  insert into public.pms_connections(id,company_id,account_id,status,credential_id,credential_expires_at,created_by,updated_by)
    values(v_id,p_company_id,p_account_id,'connected',v_secret,p_expires_at,p_actor_id,p_actor_id)
    on conflict(company_id,provider) do update set status='connected',credential_id=excluded.credential_id,
      credential_expires_at=excluded.credential_expires_at,revision=public.pms_connections.revision+1,
      updated_by=p_actor_id,updated_at=now();
  insert into public.audit_events(company_id,actor_id,event_kind,entity_type,entity_id,metadata)
    values(p_company_id,p_actor_id,'pms_connection_saved','pms_connection',v_id,
      jsonb_build_object('provider','hostaway','account_id',p_account_id,'credential_rotated',v.id is not null));
  return v_id;
end $$;

create function public.read_hostaway_setup_token(p_company_id uuid,p_actor_id uuid,p_connection_id uuid,p_revision bigint)
returns text language plpgsql security definer set search_path='' as $$
declare v_secret text;
begin
  perform public.pms_require_setup_admin(p_company_id,p_actor_id);
  select s.decrypted_secret into v_secret from public.pms_connections c
    join vault.decrypted_secrets s on s.id=c.credential_id
    where c.id=p_connection_id and c.company_id=p_company_id and c.provider='hostaway'
      and c.revision=p_revision and c.status='connected' and c.credential_expires_at>now();
  if v_secret is null then raise exception 'connection_unavailable' using errcode='55000'; end if;
  return v_secret;
end $$;

create function public.disconnect_hostaway_connection(p_company_id uuid,p_actor_id uuid,p_connection_id uuid,p_revision bigint)
returns void language plpgsql security definer set search_path='' as $$
declare v public.pms_connections%rowtype;
begin
  perform public.pms_require_setup_admin(p_company_id,p_actor_id);
  perform 1 from public.companies where id=p_company_id for no key update;
  select * into v from public.pms_connections where id=p_connection_id and company_id=p_company_id for no key update;
  if v.id is null then raise exception 'connection_unavailable' using errcode='P0002'; end if;
  if v.revision<>p_revision or p_revision is null then raise exception 'stale_connection' using errcode='40001'; end if;
  update public.pms_connections set status='disconnected',credential_id=null,credential_expires_at=null,
    revision=revision+1,updated_by=p_actor_id,updated_at=now() where id=v.id;
  delete from vault.secrets where id=v.credential_id;
  insert into public.audit_events(company_id,actor_id,event_kind,entity_type,entity_id,metadata)
    values(p_company_id,p_actor_id,'pms_connection_disconnected','pms_connection',v.id,jsonb_build_object('provider','hostaway'));
end $$;

create function public.save_hostaway_mapping(p_company_id uuid,p_actor_id uuid,p_connection_id uuid,p_connection_revision bigint,
  p_listing_id text,p_unit_id text,p_property_id uuid,p_listing_name text,p_unit_name text,p_time_zone text,p_expected_revision bigint)
returns uuid language plpgsql security definer set search_path='' as $$
declare v public.pms_connections%rowtype; m public.pms_listing_mappings%rowtype; v_id uuid;
begin
  perform public.pms_require_setup_admin(p_company_id,p_actor_id);
  perform 1 from public.companies where id=p_company_id for no key update;
  select * into v from public.pms_connections where id=p_connection_id and company_id=p_company_id for no key update;
  if v.id is null or v.status<>'connected' or v.credential_expires_at<=now() then
    raise exception 'connection_unavailable' using errcode='55000';
  end if;
  if p_connection_revision is null or v.revision<>p_connection_revision then raise exception 'stale_connection' using errcode='40001'; end if;
  perform 1 from public.properties where id=p_property_id and company_id=p_company_id and deleted_at is null for share;
  if not found then raise exception 'property_unavailable' using errcode='42501'; end if;
  if exists (select 1 from public.pms_listing_mappings where connection_id=v.id and listing_id=p_listing_id
    and ((unit_id='0' and p_unit_id<>'0') or (unit_id<>'0' and p_unit_id='0'))) then
    raise exception 'listing_granularity_conflict' using errcode='23505';
  end if;
  select * into m from public.pms_listing_mappings
    where connection_id=v.id and listing_id=p_listing_id and unit_id=p_unit_id for no key update;
  if p_expected_revision is null or coalesce(m.revision,0)<>p_expected_revision then raise exception 'stale_mapping' using errcode='40001'; end if;
  v_id:=coalesce(m.id,gen_random_uuid());
  insert into public.pms_listing_mappings(id,company_id,connection_id,listing_id,unit_id,property_id,listing_name,unit_name,time_zone,verified_by)
    values(v_id,p_company_id,v.id,p_listing_id,p_unit_id,p_property_id,p_listing_name,p_unit_name,p_time_zone,p_actor_id)
    on conflict(connection_id,listing_id,unit_id) do update set property_id=excluded.property_id,
      listing_name=excluded.listing_name,unit_name=excluded.unit_name,time_zone=excluded.time_zone,
      revision=public.pms_listing_mappings.revision+1,verified_by=p_actor_id,verified_at=now();
  insert into public.audit_events(company_id,actor_id,event_kind,entity_type,entity_id,metadata)
    values(p_company_id,p_actor_id,'pms_mapping_verified','pms_mapping',v_id,
      jsonb_build_object('connection_id',v.id,'listing_id',p_listing_id,'unit_id',p_unit_id,
        'previous_property_id',m.property_id,'property_id',p_property_id));
  return v_id;
end $$;

revoke all on function public.pms_require_setup_admin(uuid,uuid),
  public.save_hostaway_connection(uuid,uuid,text,text,timestamptz,bigint),
  public.read_hostaway_setup_token(uuid,uuid,uuid,bigint),
  public.disconnect_hostaway_connection(uuid,uuid,uuid,bigint),
  public.save_hostaway_mapping(uuid,uuid,uuid,bigint,text,text,uuid,text,text,text,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.save_hostaway_connection(uuid,uuid,text,text,timestamptz,bigint),
  public.read_hostaway_setup_token(uuid,uuid,uuid,bigint),
  public.disconnect_hostaway_connection(uuid,uuid,uuid,bigint),
  public.save_hostaway_mapping(uuid,uuid,uuid,bigint,text,text,uuid,text,text,text,bigint) to service_role;

create policy pms_audit_rpc_only on public.audit_events as restrictive for insert to authenticated
  with check (event_kind not in ('pms_connection_saved','pms_connection_disconnected','pms_mapping_verified'));
