-- Let active admins mark their own attendance in the app, without sending it to Google Sheets.

-- Assign current active admins to every active location, including hidden internal locations.
insert into public.attendance_location_site_workers (site_id, worker_id)
select s.id, p.id
from public.attendance_location_sites s
cross join public.profiles p
where s.is_active = true and p.role = 'admin' and p.is_active = true
on conflict do nothing;

-- Newly activated or added sites are also available to active admins.
create or replace function public.assign_active_locations_to_admins()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active then
    insert into public.attendance_location_site_workers (site_id, worker_id)
    select new.id, p.id from public.profiles p
    where p.role = 'admin' and p.is_active = true
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_location_sites_assign_admins on public.attendance_location_sites;
create trigger attendance_location_sites_assign_admins
after insert or update of is_active on public.attendance_location_sites
for each row execute function public.assign_active_locations_to_admins();

-- Ensure future active admins and workers receive all active locations.
create or replace function public.assign_default_location_to_worker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role in ('worker', 'admin') and new.is_active then
    insert into public.attendance_location_site_workers (site_id, worker_id)
    select id, new.id from public.attendance_location_sites where is_active = true
    on conflict do nothing;
  end if;
  return new;
end;
$$;

-- Keep admin marks in attendance_records but out of the Google Sheets queue.
create or replace function public.queue_attendance_for_sheets()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.profiles p where p.id = new.worker_id and p.role = 'admin') then
    delete from public.sync_log where attendance_id = new.id;
    return new;
  end if;
  insert into public.sync_log (attendance_id, status, error, intentos, updated_at)
  values (new.id, 'pending', null, 0, now())
  on conflict (attendance_id) do update
    set status = 'pending', error = null, intentos = 0, updated_at = now();
  return new;
end;
$$;

-- Manual re-sync also includes workers only.
create or replace function public.queue_attendance_resync(p_from_date date, p_to_date date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'Solo el administrador puede re-sincronizar.' using errcode = '42501';
  end if;
  if p_from_date is null or p_to_date is null or p_from_date > p_to_date then
    raise exception 'El rango de fechas no es valido.' using errcode = '22023';
  end if;
  insert into public.sync_log (attendance_id, status, error, intentos, updated_at)
  select a.id, 'pending', null, 0, now()
  from public.attendance_records a
  join public.profiles p on p.id = a.worker_id
  where a.work_date between p_from_date and p_to_date and p.role = 'worker'
  on conflict (attendance_id) do update
    set status = 'pending', error = null, intentos = 0, updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Remove legacy admin rows from the export queue, preserving attendance data.
delete from public.sync_log l
using public.attendance_records a, public.profiles p
where a.id = l.attendance_id and p.id = a.worker_id and p.role = 'admin';


create or replace function public.record_attendance_with_location(
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_m double precision
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_work_date date := (now() at time zone 'America/Lima')::date;
  v_now timestamptz := now();
  v_record public.attendance_records;
  v_action text;
  v_candidate record;
  v_nearest record;
  v_site record;
  v_has_nearest boolean := false;
  v_has_site boolean := false;
  v_reason text;
  v_error text;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'Inicia sesión antes de marcar.');
  end if;
  if not exists (
    select 1 from public.profiles
    where id = v_user_id and role in ('worker', 'admin') and is_active = true
  ) then
    return jsonb_build_object('ok', false, 'error', 'La cuenta no está habilitada para marcar asistencia.');
  end if;

  select * into v_record
  from public.attendance_records
  where worker_id = v_user_id and work_date = v_work_date;
  v_action := case
    when v_record.check_in_at is not null and v_record.check_out_at is null then 'check_out'
    else 'check_in'
  end;

  if p_latitude is null or p_latitude not between -90 and 90
     or p_longitude is null or p_longitude not between -180 and 180
     or p_accuracy_m is null or p_accuracy_m <= 0 then
    insert into public.attendance_location_attempts
      (worker_id, event_type, outcome, reason, accuracy_m)
    values (v_user_id, v_action, 'rejected', 'invalid_location',
      case when p_accuracy_m > 0 then p_accuracy_m else null end);
    return jsonb_build_object('ok', false, 'error', 'El teléfono no entregó una ubicación válida. Activa ubicación e inténtalo otra vez.', 'reason', 'invalid_location');
  end if;

  for v_candidate in
    select s.id, s.name, s.radius_m, s.max_accuracy_m,
      2 * 6371008.8 * asin(sqrt(least(1::double precision,
        power(sin(radians(p_latitude - s.latitude) / 2), 2)
        + cos(radians(s.latitude)) * cos(radians(p_latitude))
        * power(sin(radians(p_longitude - s.longitude) / 2), 2)
      ))) as distance_m
    from public.attendance_location_sites s
    join public.attendance_location_site_workers sw on sw.site_id = s.id
    where sw.worker_id = v_user_id and s.is_active = true
    order by distance_m
  loop
    if not v_has_nearest then
      v_nearest := v_candidate;
      v_has_nearest := true;
    end if;
    if v_candidate.distance_m <= v_candidate.radius_m
       and p_accuracy_m <= v_candidate.max_accuracy_m then
      v_site := v_candidate;
      v_has_site := true;
      exit;
    end if;
  end loop;

  if not v_has_nearest then
    insert into public.attendance_location_attempts
      (worker_id, event_type, outcome, reason, accuracy_m)
    values (v_user_id, v_action, 'rejected', 'no_assigned_location', p_accuracy_m);
    return jsonb_build_object('ok', false, 'error', 'Tu cuenta no tiene una ubicación autorizada asignada. Contacta al administrador.', 'reason', 'no_assigned_location');
  end if;

  if not v_has_site then
    v_site := v_nearest;
    v_reason := case
      when p_accuracy_m > v_site.max_accuracy_m and v_site.distance_m > v_site.radius_m then 'low_accuracy_and_outside_radius'
      when p_accuracy_m > v_site.max_accuracy_m then 'low_accuracy'
      else 'outside_radius'
    end;
    v_error := case
      when p_accuracy_m > v_site.max_accuracy_m then 'La ubicación llegó con poca precisión. Activa ubicación precisa, espera unos segundos e inténtalo otra vez.'
      else 'La ubicación detectada está fuera del radio permitido de tus locales autorizados.'
    end;
    insert into public.attendance_location_attempts
      (worker_id, event_type, outcome, reason, site_id, site_name, distance_m, accuracy_m, radius_m, max_accuracy_m)
    values
      (v_user_id, v_action, 'rejected', v_reason, v_site.id, v_site.name,
       v_site.distance_m, p_accuracy_m, v_site.radius_m, v_site.max_accuracy_m);
    return jsonb_build_object(
      'ok', false, 'error', v_error, 'reason', v_reason,
      'site_name', v_site.name, 'distance_m', v_site.distance_m, 'accuracy_m', p_accuracy_m,
      'radius_m', v_site.radius_m, 'max_accuracy_m', v_site.max_accuracy_m
    );
  end if;

  insert into public.attendance_records (worker_id, work_date, check_in_at)
  values (v_user_id, v_work_date, v_now)
  on conflict (worker_id, work_date) do update
    set check_in_at = case
          when public.attendance_records.check_in_at is null then v_now
          else public.attendance_records.check_in_at
        end,
        check_out_at = case
          when public.attendance_records.check_in_at is not null
            and public.attendance_records.check_out_at is null
            and public.attendance_records.check_in_at < v_now - interval '30 seconds'
          then v_now
          else public.attendance_records.check_out_at
        end
    where public.attendance_records.check_in_at is null
       or (public.attendance_records.check_out_at is null
           and public.attendance_records.check_in_at < v_now - interval '30 seconds')
  returning * into v_record;

  if not found then
    insert into public.attendance_location_attempts
      (worker_id, attendance_id, event_type, outcome, reason, site_id, site_name, distance_m, accuracy_m, radius_m, max_accuracy_m)
    select v_user_id, a.id, v_action, 'rejected', 'attendance_already_completed_or_too_soon',
           v_site.id, v_site.name, v_site.distance_m, p_accuracy_m, v_site.radius_m, v_site.max_accuracy_m
    from public.attendance_records a
    where a.worker_id = v_user_id and a.work_date = v_work_date;
    return jsonb_build_object('ok', false, 'error', 'Ya registraste entrada y salida hoy, o espera un momento antes de volver a marcar.', 'reason', 'attendance_already_completed_or_too_soon');
  end if;

  v_action := case when v_record.check_out_at is null then 'check_in' else 'check_out' end;
  insert into public.attendance_location_events
    (attendance_id, worker_id, event_type, latitude, longitude, accuracy_m, distance_m, site_id)
  values
    (v_record.id, v_user_id, v_action, p_latitude, p_longitude, p_accuracy_m, v_site.distance_m, v_site.id);
  insert into public.attendance_location_attempts
    (worker_id, attendance_id, event_type, outcome, site_id, site_name, distance_m, accuracy_m, radius_m, max_accuracy_m)
  values
    (v_user_id, v_record.id, v_action, 'accepted', v_site.id, v_site.name,
     v_site.distance_m, p_accuracy_m, v_site.radius_m, v_site.max_accuracy_m);

  return jsonb_build_object('ok', true, 'event', v_action, 'site_name', v_site.name, 'record', to_jsonb(v_record));
end;
$$;


revoke all on function public.record_attendance_with_location(double precision, double precision, double precision) from public, anon;
grant execute on function public.record_attendance_with_location(double precision, double precision, double precision) to authenticated;
