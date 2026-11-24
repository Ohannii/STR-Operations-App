-- Primary allocations are independent of pack authors and investor identities.
-- All writes go through authenticated RPCs; no service-role or client DML.
alter table public.properties add column primary_inspector_revision bigint not null default 0 check (primary_inspector_revision>=0);
-- Keep the new internal revision outside the property form's INSERT grant.
revoke insert on public.properties from authenticated;
grant insert(company_id,name,address,unit_reference,bedrooms,notes) on public.properties to authenticated;
create unique index uq_property_primary_inspector on public.property_assignments(property_id)
  where role_at_property = 'primary_inspector' and deleted_at is null;
alter table public.property_assignments add constraint assignment_property_company_fk
  foreign key(property_id, company_id) references public.properties(id, company_id);
revoke all on public.property_assignments from public, anon, authenticated, service_role;
grant select on public.property_assignments to authenticated;
-- Existing audit clients may still append their other event kinds. Allocation
-- history can be appended only by the guarded definer RPCs below.
create policy "inspection audit is RPC only" on public.audit_events as restrictive
  for insert to authenticated with check (event_kind not in
    ('primary_inspector_reassigned','inspection_reassignment_policy_changed','turnover_schedule_changed'));

create table public.inspection_settings (
  company_id uuid primary key references public.companies(id),
  managers_only boolean not null default false,
  revision bigint not null default 0
);
alter table public.inspection_settings enable row level security;
revoke all on public.inspection_settings from public, anon, authenticated, service_role;
grant select on public.inspection_settings to authenticated;
create policy "members read inspection settings" on public.inspection_settings for select to authenticated
  using (public.is_company_member(company_id));

create unique index uq_pack_id_company_property on public.evidence_packs(id,company_id,property_id);
create table public.turnover_jobs (
  id uuid primary key,
  company_id uuid not null references public.companies(id),
  property_id uuid not null,
  due_on date not null,
  checkout_at timestamptz,
  next_arrival_at timestamptz,
  source text not null default 'manual' check (source = 'manual'),
  pack_id uuid unique,
  cancelled_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  revision bigint not null default 0,
  foreign key(property_id, company_id) references public.properties(id, company_id),
  foreign key(pack_id, company_id, property_id) references public.evidence_packs(id, company_id, property_id),
  check (next_arrival_at is null or checkout_at is null or next_arrival_at >= checkout_at)
);
create index ix_turnover_jobs_company_due on public.turnover_jobs(company_id, due_on);
-- Distinct turnovers can share a unit/date when their checkout times differ.
-- A manual retry with a new nonce cannot duplicate an identical time slot.
create unique index uq_turnover_manual_checkout on public.turnover_jobs(company_id,property_id,checkout_at)
  where cancelled_at is null and checkout_at is not null;
create unique index uq_turnover_manual_day on public.turnover_jobs(company_id,property_id,due_on)
  where cancelled_at is null and checkout_at is null;
alter table public.turnover_jobs enable row level security;
revoke all on public.turnover_jobs from public, anon, authenticated, service_role;
grant select on public.turnover_jobs to authenticated;
create policy "operations read turnover jobs" on public.turnover_jobs for select to authenticated
  using (public.has_company_role(company_id,array['company_admin','gm','ops_manager','maintenance_coordinator'])
    or (public.has_company_role(company_id,array['inspector']) and (
      exists(select 1 from public.property_assignments a where a.property_id=turnover_jobs.property_id
        and a.company_id=turnover_jobs.company_id and a.role_at_property='primary_inspector' and a.deleted_at is null and a.user_id=auth.uid())
      or exists(select 1 from public.evidence_packs ep where ep.id=turnover_jobs.pack_id and ep.company_id=turnover_jobs.company_id
        and (ep.started_by=auth.uid() or ep.submitted_by=auth.uid())))));

-- Narrow, tenant-scoped read model. Names only; no guest or credential data.
create function public.inspection_workspace(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_company_role(p_company,
    array['company_admin','gm','ops_manager','maintenance_coordinator','inspector']) then
    raise exception 'not allowed' using errcode='42501';
  end if;
  return jsonb_build_object(
    'managers_only', coalesce((select managers_only from public.inspection_settings where company_id=p_company),false),
    'settings_revision', coalesce((select revision from public.inspection_settings where company_id=p_company),0),
    'properties', coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'name',p.name,'address',p.address,'unit_reference',p.unit_reference,
      'revision',p.primary_inspector_revision,'inspector_id',a.user_id,
      'inspector_name',pr.full_name,'inspector_active',coalesce(cm.is_active and cm.deleted_at is null and pr.deleted_at is null
        and cm.role_key in ('company_admin','gm','ops_manager','maintenance_coordinator','inspector'),false)))
      from public.properties p
      left join public.property_assignments a on a.property_id=p.id and a.company_id=p_company
        and a.role_at_property='primary_inspector' and a.deleted_at is null
      left join public.profiles pr on pr.id=a.user_id
      left join public.company_memberships cm on cm.company_id=p_company and cm.user_id=a.user_id
      where p.company_id=p_company and p.deleted_at is null),'[]'::jsonb),
    'inspectors',coalesce((select jsonb_agg(jsonb_build_object('id',cm.user_id,'name',p.full_name,'role',cm.role_key)
      order by p.full_name nulls last,cm.user_id)
      from public.company_memberships cm join public.profiles p on p.id=cm.user_id
      where cm.company_id=p_company and cm.is_active and cm.deleted_at is null and p.deleted_at is null
        and cm.role_key in ('company_admin','gm','ops_manager','maintenance_coordinator','inspector')),'[]'::jsonb),
    'history',coalesce((select jsonb_agg(x) from (
      select ae.id,ae.entity_id as property_id,actor.full_name as actor,
        ae.before->>'inspector_id' as previous_id,ae.after->>'inspector_id' as next_id,
        prev.full_name as previous,nxt.full_name as next,ae.created_at as at
      from public.audit_events ae
      left join public.profiles actor on actor.id=ae.actor_id
      left join public.profiles prev on prev.id::text=ae.before->>'inspector_id'
      left join public.profiles nxt on nxt.id::text=ae.after->>'inspector_id'
      where ae.company_id=p_company and ae.event_kind='primary_inspector_reassigned' and ae.entity_type='property'
      order by ae.created_at desc,ae.id desc limit 50
    ) x),'[]'::jsonb)
  );
end;
$$;

-- Company -> actor/target memberships -> sorted properties is the common lock
-- order. Revision checks reject stale bulk forms atomically (including A-B-A).
create function public.assign_primary_inspectors(p_company uuid, p_changes jsonb, p_inspector uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_role text; v_managers boolean; v_entry jsonb; v_property public.properties%rowtype;
  v_before uuid; v_count integer := 0;
begin
  if auth.uid() is null then raise exception 'not allowed' using errcode='42501'; end if;
  perform 1 from public.companies where id=p_company and deleted_at is null for update;
  if not found then raise exception 'not allowed' using errcode='42501'; end if;
  select role_key into v_role from public.company_memberships
    where company_id=p_company and user_id=auth.uid() and is_active and deleted_at is null for share;
  select coalesce((select managers_only from public.inspection_settings where company_id=p_company),false) into v_managers;
  if v_role is null or v_role not in ('company_admin','gm','ops_manager','maintenance_coordinator','inspector')
    or (v_managers and v_role='inspector') then
    raise exception 'not allowed' using errcode='42501';
  end if;
  if p_changes is null or jsonb_typeof(p_changes)<>'array'
    or jsonb_array_length(p_changes) not between 1 and 200 then
    raise exception 'invalid selection' using errcode='22023';
  end if;
  if (select count(distinct value->>'property_id') from jsonb_array_elements(p_changes)) <> jsonb_array_length(p_changes) then
    raise exception 'duplicate property' using errcode='22023';
  end if;
  if p_inspector is not null then
    perform 1 from public.company_memberships cm join public.profiles pr on pr.id=cm.user_id
      where cm.company_id=p_company and cm.user_id=p_inspector and cm.is_active and cm.deleted_at is null
        and pr.deleted_at is null and cm.role_key in ('company_admin','gm','ops_manager','maintenance_coordinator','inspector')
      for share of cm,pr;
    if not found then raise exception 'inspector unavailable' using errcode='22023'; end if;
  end if;
  for v_entry in select value from jsonb_array_elements(p_changes) order by value->>'property_id' loop
    select * into v_property from public.properties where id=(v_entry->>'property_id')::uuid
      and company_id=p_company and deleted_at is null for update;
    if not found then raise exception 'property unavailable' using errcode='42501'; end if;
    if (v_entry->>'revision') is null or v_property.primary_inspector_revision <> (v_entry->>'revision')::bigint then
      raise exception 'assignment changed; reload' using errcode='40001';
    end if;
    select user_id into v_before from public.property_assignments where property_id=v_property.id
      and role_at_property='primary_inspector' and deleted_at is null;
    if v_before is not distinct from p_inspector then continue; end if;
    update public.property_assignments set deleted_at=now() where property_id=v_property.id
      and role_at_property='primary_inspector' and deleted_at is null;
    if p_inspector is not null then
      insert into public.property_assignments(company_id,property_id,user_id,role_at_property)
        values(p_company,v_property.id,p_inspector,'primary_inspector')
        on conflict(property_id,user_id,role_at_property) do update set deleted_at=null;
    end if;
    update public.properties set primary_inspector_revision=primary_inspector_revision+1 where id=v_property.id;
    insert into public.audit_events(company_id,actor_id,event_kind,entity_type,entity_id,before,after)
      values(p_company,auth.uid(),'primary_inspector_reassigned','property',v_property.id,
        jsonb_build_object('inspector_id',v_before),jsonb_build_object('inspector_id',p_inspector));
    v_count:=v_count+1;
  end loop;
  return v_count;
end;
$$;

create function public.set_inspection_reassignment_policy(p_company uuid,p_managers_only boolean,p_revision bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old boolean; v_revision bigint;
begin
  if auth.uid() is null then raise exception 'not allowed' using errcode='42501'; end if;
  perform 1 from public.companies where id=p_company and deleted_at is null for update;
  if not found then raise exception 'not allowed' using errcode='42501'; end if;
  perform 1 from public.company_memberships where company_id=p_company and user_id=auth.uid()
    and is_active and deleted_at is null and role_key in ('company_admin','gm','ops_manager','maintenance_coordinator') for share;
  if not found then raise exception 'not allowed' using errcode='42501'; end if;
  select coalesce((select managers_only from public.inspection_settings where company_id=p_company),false),
    coalesce((select revision from public.inspection_settings where company_id=p_company),0) into v_old,v_revision;
  if p_managers_only is null or p_revision is null then raise exception 'invalid policy' using errcode='22023'; end if;
  if v_revision<>p_revision then raise exception 'policy changed; reload' using errcode='40001'; end if;
  if v_old=p_managers_only then return; end if;
  insert into public.inspection_settings(company_id,managers_only,revision) values(p_company,p_managers_only,1)
    on conflict(company_id) do update set managers_only=excluded.managers_only,revision=inspection_settings.revision+1;
  insert into public.audit_events(company_id,actor_id,event_kind,entity_type,entity_id,before,after)
    values(p_company,auth.uid(),'inspection_reassignment_policy_changed','company',p_company,
      jsonb_build_object('managers_only',v_old),jsonb_build_object('managers_only',p_managers_only));
end;
$$;

create function public.schedule_turnover(p_company uuid,p_id uuid,p_property uuid,p_due date,
  p_checkout timestamptz default null,p_arrival timestamptz default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_job public.turnover_jobs%rowtype;
begin
  if auth.uid() is null then raise exception 'not allowed' using errcode='42501'; end if;
  perform 1 from public.company_memberships where company_id=p_company and user_id=auth.uid()
    and is_active and deleted_at is null and role_key in ('company_admin','gm','ops_manager','maintenance_coordinator') for share;
  if not found then raise exception 'not allowed' using errcode='42501'; end if;
  perform 1 from public.properties where id=p_property and company_id=p_company and deleted_at is null for share;
  if not found then raise exception 'property unavailable' using errcode='42501'; end if;
  if p_due is null or p_id is null or (p_checkout is not null and p_arrival<p_checkout) then
    raise exception 'invalid schedule' using errcode='22023';
  end if;
  -- The caller holds the same nonce across retries, not just repeated taps.
  insert into public.turnover_jobs(id,company_id,property_id,due_on,checkout_at,next_arrival_at,created_by)
    values(p_id,p_company,p_property,p_due,p_checkout,p_arrival,auth.uid()) on conflict(id) do nothing;
  select * into v_job from public.turnover_jobs where id=p_id;
  if v_job.cancelled_at is not null then raise exception 'schedule cancelled' using errcode='55000'; end if;
  if v_job.company_id<>p_company or v_job.created_by<>auth.uid() or v_job.property_id<>p_property
    or v_job.due_on<>p_due or v_job.checkout_at is distinct from p_checkout or v_job.next_arrival_at is distinct from p_arrival then
    raise exception 'schedule retry changed' using errcode='23505';
  end if;
  return p_id;
end;
$$;

create function public.update_turnover_schedule(p_company uuid,p_id uuid,p_revision bigint,p_due date,p_cancel boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare v_job public.turnover_jobs%rowtype;
begin
  if auth.uid() is null or not public.has_company_role(p_company,
    array['company_admin','gm','ops_manager','maintenance_coordinator']) then
    raise exception 'not allowed' using errcode='42501';
  end if;
  select * into v_job from public.turnover_jobs where id=p_id and company_id=p_company for update;
  if not found then raise exception 'not allowed' using errcode='42501'; end if;
  if p_revision is null or v_job.revision<>p_revision then raise exception 'schedule changed; reload' using errcode='40001'; end if;
  if v_job.pack_id is not null or v_job.cancelled_at is not null then
    raise exception 'inspection already started or cancelled' using errcode='55000';
  end if;
  if p_due is null or p_cancel is null then raise exception 'invalid schedule' using errcode='22023'; end if;
  if p_due=v_job.due_on and not p_cancel then return; end if;
  update public.turnover_jobs set due_on=p_due,cancelled_at=case when p_cancel then now() else null end,revision=revision+1 where id=p_id;
  insert into public.audit_events(company_id,actor_id,event_kind,entity_type,entity_id,before,after)
    values(p_company,auth.uid(),'turnover_schedule_changed','turnover_job',p_id,
      jsonb_build_object('due_on',v_job.due_on),jsonb_build_object('due_on',p_due,'cancelled',p_cancel));
end;
$$;

-- One explicit job -> one ordinary photo pack. Never adopt an unrelated draft
-- or infer completion by apartment/date. The existing caption submit RPC is
-- unchanged and remains the only finalisation path.
create function public.start_turnover_job(p_company uuid,p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_job public.turnover_jobs%rowtype; v_pack uuid;
begin
  if auth.uid() is null then raise exception 'not allowed' using errcode='42501'; end if;
  perform 1 from public.company_memberships where company_id=p_company and user_id=auth.uid()
    and is_active and deleted_at is null and role_key in ('company_admin','gm','ops_manager','maintenance_coordinator','inspector') for share;
  if not found then raise exception 'not allowed' using errcode='42501'; end if;
  select * into v_job from public.turnover_jobs where id=p_id and company_id=p_company for update;
  if not found or v_job.cancelled_at is not null then raise exception 'inspection unavailable' using errcode='42501'; end if;
  perform 1 from public.properties where id=v_job.property_id and company_id=p_company and deleted_at is null for share;
  if not found then raise exception 'property unavailable' using errcode='42501'; end if;
  if v_job.pack_id is not null then
    perform 1 from public.evidence_packs where id=v_job.pack_id and company_id=p_company and property_id=v_job.property_id and deleted_at is null;
    if not found then raise exception 'pack unavailable' using errcode='55000'; end if;
    return v_job.pack_id;
  end if;
  if exists(select 1 from public.evidence_packs where property_id=v_job.property_id and pack_type='pre_arrival'
    and status='draft' and deleted_at is null) then
    raise exception 'existing draft' using errcode='55000';
  end if;
  insert into public.evidence_packs(company_id,property_id,pack_type,started_by)
    values(p_company,v_job.property_id,'pre_arrival',auth.uid()) returning id into v_pack;
  update public.turnover_jobs set pack_id=v_pack,revision=revision+1 where id=p_id;
  insert into public.audit_events(company_id,actor_id,event_kind,entity_type,entity_id,metadata)
    values(p_company,auth.uid(),'evidence_pack_start','evidence_pack',v_pack,
      jsonb_build_object('property_id',v_job.property_id,'turnover_job_id',p_id));
  return v_pack;
end;
$$;

create function public.inspection_workboard(p_company uuid,p_all boolean default false,p_property uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.has_company_role(p_company,
    array['company_admin','gm','ops_manager','maintenance_coordinator','inspector']) then
    raise exception 'not allowed' using errcode='42501';
  end if;
  if p_all and not public.has_company_role(p_company,array['company_admin','gm','ops_manager','maintenance_coordinator']) then
    raise exception 'not allowed' using errcode='42501';
  end if;
  if p_property is not null and not exists(select 1 from public.properties where id=p_property and company_id=p_company and deleted_at is null) then
    raise exception 'property unavailable' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',j.id,'property_id',j.property_id,'due_on',j.due_on,'checkout_at',j.checkout_at,
    'next_arrival_at',j.next_arrival_at,'source',j.source,'cancelled_at',j.cancelled_at,'revision',j.revision,
    'pack_id',ep.id,'pack_deleted',ep.deleted_at is not null,'pack_status',ep.status,
    'started_by',ep.started_by,'starter_name',starter.full_name,
    'submitted_by',ep.submitted_by,'submitter_name',submitter.full_name,'submitted_at',ep.submitted_at)
    order by j.due_on,j.id)
    from public.turnover_jobs j
    join public.properties p on p.id=j.property_id and p.company_id=j.company_id and p.deleted_at is null
    left join public.property_assignments a on a.property_id=j.property_id and a.role_at_property='primary_inspector' and a.deleted_at is null
    left join public.evidence_packs ep on ep.id=j.pack_id and ep.company_id=j.company_id and ep.property_id=j.property_id
    left join public.profiles starter on starter.id=ep.started_by
    left join public.profiles submitter on submitter.id=ep.submitted_by
    where j.company_id=p_company and (
      (p_property is not null and j.property_id=p_property)
      or (p_property is null and (p_all or a.user_id=auth.uid() or ep.started_by=auth.uid() or ep.submitted_by=auth.uid())))
      -- Retain all unfinished work; bound terminal history to 30 days.
      and ((j.cancelled_at is null and (ep.status is distinct from 'submitted' or ep.deleted_at is not null))
        or greatest(j.cancelled_at,ep.submitted_at) >= now()-interval '30 days')), '[]'::jsonb);
end;
$$;

-- Default function grants are PUBLIC in Postgres; explicitly close every RPC.
revoke all on function public.inspection_workspace(uuid), public.assign_primary_inspectors(uuid,jsonb,uuid),
  public.set_inspection_reassignment_policy(uuid,boolean,bigint), public.schedule_turnover(uuid,uuid,uuid,date,timestamptz,timestamptz),
  public.update_turnover_schedule(uuid,uuid,bigint,date,boolean), public.start_turnover_job(uuid,uuid),
  public.inspection_workboard(uuid,boolean,uuid) from public,anon,authenticated,service_role;
grant execute on function public.inspection_workspace(uuid), public.assign_primary_inspectors(uuid,jsonb,uuid),
  public.set_inspection_reassignment_policy(uuid,boolean,bigint), public.schedule_turnover(uuid,uuid,uuid,date,timestamptz,timestamptz),
  public.update_turnover_schedule(uuid,uuid,bigint,date,boolean), public.start_turnover_job(uuid,uuid),
  public.inspection_workboard(uuid,boolean,uuid) to authenticated;
