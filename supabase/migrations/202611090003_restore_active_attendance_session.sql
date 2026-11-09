-- Let the admin panel restore the current QR and 4-digit code after a refresh.
create or replace function public.get_current_attendance_session()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session jsonb;
begin
  if not public.is_admin() then
    raise exception 'Solo el administrador puede consultar el QR y la clave vigentes.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'token', token,
    'access_code', access_code,
    'expires_at', expires_at
  )
  into v_session
  from public.attendance_qr_sessions
  where revoked_at is null and expires_at > now()
  order by created_at desc
  limit 1;

  return v_session;
end;
$$;

revoke all on function public.get_current_attendance_session() from public, anon;
grant execute on function public.get_current_attendance_session() to authenticated;
