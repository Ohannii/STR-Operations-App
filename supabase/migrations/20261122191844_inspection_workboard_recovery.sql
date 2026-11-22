-- Follow-up to the already-applied workboard migration. Preserve pack evidence,
-- authorship and permanent allocations; only managers can cancel a discarded visit.
-- NO KEY UPDATE still serialises allocation writers without blocking child FKs.


create or replace function public.assign_primary_inspectors(p_company uuid, p_changes jsonb, p_inspector uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_role text; v_managers boolean; v_entry jsonb; v_property public.properties%rowtype;
  v_before uuid; v_count integer := 0;
begin
  if auth.uid() is null then raise exception 'not allowed' using errcode='42501'; end if;
  perform 1 from public.companies where id=p_company and deleted_at is null for no key update;
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
      and company_id=p_company and deleted_at is null for no key update;
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

create or replace function public.set_inspection_reassignment_policy(p_company uuid,p_managers_only boolean,p_revision bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old boolean; v_revision bigint;
begin
  if auth.uid() is null then raise exception 'not allowed' using errcode='42501'; end if;
  perform 1 from public.companies where id=p_company and deleted_at is null for no key update;
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

create or replace function public.update_turnover_schedule(p_company uuid,p_id uuid,p_revision bigint,p_due date,p_cancel boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare v_job public.turnover_jobs%rowtype; v_deleted timestamptz; v_status text;
begin
  if auth.uid() is null or not public.has_company_role(p_company,
    array['company_admin','gm','ops_manager','maintenance_coordinator']) then
    raise exception 'not allowed' using errcode='42501';
  end if;
  select * into v_job from public.turnover_jobs where id=p_id and company_id=p_company for update;
  if not found then raise exception 'not allowed' using errcode='42501'; end if;
  if p_revision is null or v_job.revision<>p_revision then raise exception 'schedule changed; reload' using errcode='40001'; end if;
  if p_due is null or p_cancel is null then raise exception 'invalid schedule' using errcode='22023'; end if;
  if v_job.cancelled_at is not null then
    raise exception 'inspection already cancelled' using errcode='55000';
  end if;
  if v_job.pack_id is not null then
    select deleted_at,status into v_deleted,v_status from public.evidence_packs
      where id=v_job.pack_id and company_id=p_company and property_id=v_job.property_id for share;
    if not found or not p_cancel or v_deleted is null or v_status<>'draft' then
      raise exception 'inspection already started' using errcode='55000';
    end if;
  end if;
  if p_due=v_job.due_on and not p_cancel then return; end if;
  update public.turnover_jobs set due_on=case when p_cancel then v_job.due_on else p_due end,cancelled_at=case when p_cancel then now() else null end,revision=revision+1 where id=p_id;
  insert into public.audit_events(company_id,actor_id,event_kind,entity_type,entity_id,before,after)
    values(p_company,auth.uid(),'turnover_schedule_changed','turnover_job',p_id,
      jsonb_build_object('due_on',v_job.due_on),
      jsonb_build_object('due_on',case when p_cancel then v_job.due_on else p_due end,'cancelled',p_cancel,'pack_id',v_job.pack_id));
end;
$$;

-- One shared definition for the RPC and direct-table RLS. Reading memberships
-- through the caller's RLS would mistake another inspector for an unavailable one.
create function public.inspection_has_available_primary(p_company uuid,p_property uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and public.has_company_role(p_company,
    array['company_admin','gm','ops_manager','maintenance_coordinator','inspector'])
    and exists (
      select 1 from public.property_assignments a
      join public.properties p on p.id=a.property_id and p.company_id=a.company_id and p.deleted_at is null
      join public.company_memberships cm on cm.company_id=a.company_id and cm.user_id=a.user_id
        and cm.is_active and cm.deleted_at is null
        and cm.role_key in ('company_admin','gm','ops_manager','maintenance_coordinator','inspector')
      join public.profiles pr on pr.id=a.user_id and pr.deleted_at is null
      where a.company_id=p_company and a.property_id=p_property
        and a.role_at_property='primary_inspector' and a.deleted_at is null
    );
$$;
revoke all on function public.inspection_has_available_primary(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.inspection_has_available_primary(uuid,uuid) to authenticated;

alter policy "operations read turnover jobs" on public.turnover_jobs
  using (public.has_company_role(company_id,array['company_admin','gm','ops_manager','maintenance_coordinator'])
    or (public.has_company_role(company_id,array['inspector']) and (
      exists(select 1 from public.property_assignments a where a.property_id=turnover_jobs.property_id
        and a.company_id=turnover_jobs.company_id and a.role_at_property='primary_inspector' and a.deleted_at is null and a.user_id=auth.uid())
      or exists(select 1 from public.evidence_packs ep where ep.id=turnover_jobs.pack_id and ep.company_id=turnover_jobs.company_id
        and (ep.started_by=auth.uid() or ep.submitted_by=auth.uid()))
      or (cancelled_at is null and not public.inspection_has_available_primary(company_id,property_id)
        and not exists(select 1 from public.evidence_packs ep where ep.id=turnover_jobs.pack_id
          and ep.status='submitted' and ep.deleted_at is null)))));


create or replace function public.inspection_workboard(p_company uuid,p_all boolean default false,p_property uuid default null) returns jsonb
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
      or (p_property is null and (p_all or a.user_id=auth.uid() or ep.started_by=auth.uid() or ep.submitted_by=auth.uid()
        or (j.cancelled_at is null and (ep.status is distinct from 'submitted' or ep.deleted_at is not null)
          and not public.inspection_has_available_primary(j.company_id,j.property_id)))))
      -- Retain all unfinished work; bound terminal history to 30 days.
      and ((j.cancelled_at is null and (ep.status is distinct from 'submitted' or ep.deleted_at is not null))
        or greatest(j.cancelled_at,ep.submitted_at) >= now()-interval '30 days')), '[]'::jsonb);
end;
$$;

alter policy "inspection audit is RPC only" on public.audit_events
  with check (event_kind not in ('primary_inspector_reassigned','inspection_reassignment_policy_changed',
    'turnover_schedule_changed','turnover_scheduled'));


create or replace function public.schedule_turnover(p_company uuid,p_id uuid,p_property uuid,p_due date,
  p_checkout timestamptz default null,p_arrival timestamptz default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_job public.turnover_jobs%rowtype; v_inserted integer;
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
  get diagnostics v_inserted = row_count;
  select * into v_job from public.turnover_jobs where id=p_id;
  if v_job.cancelled_at is not null then raise exception 'schedule cancelled' using errcode='55000'; end if;
  if v_job.company_id<>p_company or v_job.created_by<>auth.uid() or v_job.property_id<>p_property
    or v_job.due_on<>p_due or v_job.checkout_at is distinct from p_checkout or v_job.next_arrival_at is distinct from p_arrival then
    raise exception 'schedule retry changed' using errcode='23505';
  end if;
  if v_inserted=1 then
    insert into public.audit_events(company_id,actor_id,event_kind,entity_type,entity_id,metadata)
      values(p_company,auth.uid(),'turnover_scheduled','turnover_job',p_id,
        jsonb_build_object('property_id',p_property,'due_on',p_due,'checkout_at',p_checkout,'next_arrival_at',p_arrival));
  end if;
  return p_id;
end;
$$;
