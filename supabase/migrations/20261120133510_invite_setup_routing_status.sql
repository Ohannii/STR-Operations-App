-- Read-only routing hint for the signed-in identity. Invitation rows/tokens
-- remain private; this helper neither accepts an invitation nor grants access.
create function public.get_my_invitation_setup_status()
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email','')));
  v_inv public.invitations%rowtype;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode='42501';
  end if;
  select * into v_inv from public.invitations
    where deleted_at is null and email=v_email
      and (auth_user_id=v_uid or auth_user_id is null)
    order by created_at desc, id desc limit 1;
  if not found then return 'none'; end if;
  if v_inv.revoked_at is not null then return 'revoked'; end if;
  if v_inv.accepted_at is not null then return 'accepted'; end if;
  if v_inv.expires_at is not null and v_inv.expires_at<now() then return 'expired'; end if;
  return 'pending';
end;
$$;
revoke all on function public.get_my_invitation_setup_status() from public, anon, service_role;
grant execute on function public.get_my_invitation_setup_status() to authenticated;
