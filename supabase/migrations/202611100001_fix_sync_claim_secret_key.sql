-- Secret API keys map to the service_role Postgres role without carrying a JWT role claim.
-- The function's EXECUTE grant is the authorization boundary; remove the JWT-only check.
create or replace function public.claim_pending_sheet_syncs(p_limit integer default 25)
returns table (attendance_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    with candidates as (
      select l.attendance_id
      from public.sync_log l
      where l.status in ('pending', 'error')
         or (l.status = 'processing' and l.updated_at < now() - interval '10 minutes')
      order by l.updated_at asc
      for update skip locked
      limit greatest(1, least(coalesce(p_limit, 25), 100))
    ), claimed as (
      update public.sync_log l
      set status = 'processing', error = null, intentos = l.intentos + 1, updated_at = now()
      from candidates c
      where l.attendance_id = c.attendance_id
      returning l.attendance_id
    )
    select claimed.attendance_id from claimed;
end;
$$;

revoke all on function public.claim_pending_sheet_syncs(integer) from public, anon, authenticated;
grant execute on function public.claim_pending_sheet_syncs(integer) to service_role;
