-- Record accepted and rejected geofence evaluations for diagnostics.
-- Failed attempts store only distance/accuracy metrics, never coordinates.

create table if not exists public.attendance_location_attempts (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.profiles(id),
  attendance_id uuid references public.attendance_records(id) on delete set null,
  event_type text not null check (event_type in ('check_in', 'check_out')),
  outcome text not null check (outcome in ('accepted', 'rejected')),
  reason text,
  distance_m double precision check (distance_m is null or distance_m >= 0),
  accuracy_m double precision check (accuracy_m is null or accuracy_m > 0),
  radius_m integer,
  max_accuracy_m integer,
  created_at timestamptz not null default now()
);

create index if not exists attendance_location_attempts_created_idx
  on public.attendance_location_attempts(created_at desc);
create index if not exists attendance_location_attempts_worker_created_idx
  on public.attendance_location_attempts(worker_id, created_at desc);

alter table public.attendance_location_attempts enable row level security;
revoke all on public.attendance_location_attempts from anon, authenticated;
grant select on public.attendance_location_attempts to authenticated;
drop policy if exists attendance_location_attempts_admin_read on public.attendance_location_attempts;
create policy attendance_location_attempts_admin_read
  on public.attendance_location_attempts for select to authenticated
  using (public.is_admin());

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
  v_settings public.attendance_location_settings;
  v_record public.attendance_records;
  v_distance_m double precision;
  v_action text;
  v_error text;
  v_reason text;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'Inicia sesión antes de marcar.');
  end if;
  if not exists (
    select 1 from public.profiles
    where id = v_user_id and role = 'worker' and is_active = true
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

  select * into v_settings
  from public.attendance_location_settings
  where id = 1;
  if not found then
    insert into public.attendance_location_attempts
      (worker_id, event_type, outcome, reason, accuracy_m)
    values
      (v_user_id, v_action, 'rejected', 'location_not_configured',
       case when p_accuracy_m > 0 then p_accuracy_m else null end);
    return jsonb_build_object('ok', false, 'error', 'El administrador todavía debe configurar la ubicación del local.', 'reason', 'location_not_configured');
  end if;

  if p_latitude is null or p_latitude not between -90 and 90
     or p_longitude is null or p_longitude not between -180 and 180
     or p_accuracy_m is null or p_accuracy_m <= 0 then
    insert into public.attendance_location_attempts
      (worker_id, event_type, outcome, reason, accuracy_m, radius_m, max_accuracy_m)
    values
      (v_user_id, v_action, 'rejected', 'invalid_location',
       case when p_accuracy_m > 0 then p_accuracy_m else null end,
       v_settings.radius_m, v_settings.max_accuracy_m);
    return jsonb_build_object('ok', false, 'error', 'El teléfono no entregó una ubicación válida. Activa la ubicación e inténtalo otra vez.', 'reason', 'invalid_location');
  end if;

  v_distance_m := 2 * 6371008.8 * asin(sqrt(least(1::double precision,
    power(sin(radians(p_latitude - v_settings.latitude) / 2), 2)
    + cos(radians(v_settings.latitude)) * cos(radians(p_latitude))
    * power(sin(radians(p_longitude - v_settings.longitude) / 2), 2)
  )));

  if p_accuracy_m > v_settings.max_accuracy_m or v_distance_m > v_settings.radius_m then
    v_reason := case
      when p_accuracy_m > v_settings.max_accuracy_m and v_distance_m > v_settings.radius_m then 'low_accuracy_and_outside_radius'
      when p_accuracy_m > v_settings.max_accuracy_m then 'low_accuracy'
      else 'outside_radius'
    end;
    v_error := case
      when p_accuracy_m > v_settings.max_accuracy_m then 'La ubicación llegó con poca precisión. Activa ubicación precisa, espera unos segundos e inténtalo otra vez.'
      else 'La ubicación detectada está fuera del radio permitido del local.'
    end;
    insert into public.attendance_location_attempts
      (worker_id, event_type, outcome, reason, distance_m, accuracy_m, radius_m, max_accuracy_m)
    values
      (v_user_id, v_action, 'rejected', v_reason, v_distance_m, p_accuracy_m,
       v_settings.radius_m, v_settings.max_accuracy_m);
    return jsonb_build_object(
      'ok', false, 'error', v_error, 'reason', v_reason,
      'distance_m', v_distance_m, 'accuracy_m', p_accuracy_m,
      'radius_m', v_settings.radius_m, 'max_accuracy_m', v_settings.max_accuracy_m
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
      (worker_id, attendance_id, event_type, outcome, reason, distance_m, accuracy_m, radius_m, max_accuracy_m)
    select v_user_id, a.id, v_action, 'rejected', 'attendance_already_completed_or_too_soon',
           v_distance_m, p_accuracy_m, v_settings.radius_m, v_settings.max_accuracy_m
    from public.attendance_records a
    where a.worker_id = v_user_id and a.work_date = v_work_date;
    return jsonb_build_object('ok', false, 'error', 'Ya registraste entrada y salida hoy, o espera un momento antes de volver a marcar.', 'reason', 'attendance_already_completed_or_too_soon');
  end if;

  v_action := case when v_record.check_out_at is null then 'check_in' else 'check_out' end;
  insert into public.attendance_location_events
    (attendance_id, worker_id, event_type, latitude, longitude, accuracy_m, distance_m)
  values
    (v_record.id, v_user_id, v_action, p_latitude, p_longitude, p_accuracy_m, v_distance_m);
  insert into public.attendance_location_attempts
    (worker_id, attendance_id, event_type, outcome, distance_m, accuracy_m, radius_m, max_accuracy_m)
  values
    (v_user_id, v_record.id, v_action, 'accepted', v_distance_m, p_accuracy_m,
     v_settings.radius_m, v_settings.max_accuracy_m);

  return jsonb_build_object('ok', true, 'event', v_action, 'record', to_jsonb(v_record));
end;
$$;

revoke all on function public.record_attendance_with_location(double precision, double precision, double precision) from public, anon;
grant execute on function public.record_attendance_with_location(double precision, double precision, double precision) to authenticated;
