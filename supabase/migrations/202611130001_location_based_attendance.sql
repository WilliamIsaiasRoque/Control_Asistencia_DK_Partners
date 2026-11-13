-- Location-gated attendance for the DK Partners web app.
-- The browser requests location only when the worker confirms a mark.

create table if not exists public.attendance_location_settings (
  id smallint primary key default 1 check (id = 1),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_m integer not null default 150 check (radius_m between 25 and 2000),
  max_accuracy_m integer not null default 150 check (max_accuracy_m between 10 and 1000),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.attendance_location_events (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance_records(id) on delete cascade,
  worker_id uuid not null references public.profiles(id),
  event_type text not null check (event_type in ('check_in', 'check_out')),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy_m double precision not null check (accuracy_m > 0),
  distance_m double precision not null check (distance_m >= 0),
  created_at timestamptz not null default now()
);

create index if not exists attendance_location_events_worker_created_idx
  on public.attendance_location_events(worker_id, created_at desc);

alter table public.attendance_location_settings enable row level security;
alter table public.attendance_location_events enable row level security;

revoke all on public.attendance_location_settings from anon, authenticated;
revoke all on public.attendance_location_events from anon, authenticated;
grant select on public.attendance_location_events to authenticated;

drop policy if exists attendance_location_events_read_self_or_admin on public.attendance_location_events;
drop policy if exists attendance_location_events_read_admin on public.attendance_location_events;
create policy attendance_location_events_read_admin
  on public.attendance_location_events for select to authenticated
  using (public.is_admin());

create or replace function public.get_attendance_location_settings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.attendance_location_settings;
begin
  if not public.is_admin() then
    raise exception 'Solo el administrador puede consultar la ubicación configurada.' using errcode = '42501';
  end if;

  select * into v_settings
  from public.attendance_location_settings
  where id = 1;

  if not found then
    return jsonb_build_object(
      'configured', false,
      'latitude', null,
      'longitude', null,
      'radius_m', 150,
      'max_accuracy_m', 150,
      'updated_at', null
    );
  end if;

  return jsonb_build_object(
    'configured', true,
    'latitude', v_settings.latitude,
    'longitude', v_settings.longitude,
    'radius_m', v_settings.radius_m,
    'max_accuracy_m', v_settings.max_accuracy_m,
    'updated_at', v_settings.updated_at
  );
end;
$$;

create or replace function public.set_attendance_location_settings(
  p_latitude double precision,
  p_longitude double precision,
  p_radius_m integer default 150,
  p_max_accuracy_m integer default 150
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.attendance_location_settings;
begin
  if not public.is_admin() then
    raise exception 'Solo el administrador puede cambiar la ubicación del local.' using errcode = '42501';
  end if;
  if p_latitude is null or p_latitude not between -90 and 90
     or p_longitude is null or p_longitude not between -180 and 180 then
    raise exception 'Las coordenadas no son válidas.' using errcode = '22023';
  end if;
  if p_radius_m is null or p_radius_m not between 25 and 2000 then
    raise exception 'El radio debe estar entre 25 y 2000 metros.' using errcode = '22023';
  end if;
  if p_max_accuracy_m is null or p_max_accuracy_m not between 10 and 1000 then
    raise exception 'La precisión máxima debe estar entre 10 y 1000 metros.' using errcode = '22023';
  end if;
  if p_max_accuracy_m > p_radius_m then
    raise exception 'La precisión máxima no puede ser mayor que el radio permitido.' using errcode = '22023';
  end if;

  insert into public.attendance_location_settings
    (id, latitude, longitude, radius_m, max_accuracy_m, updated_by, updated_at)
  values
    (1, p_latitude, p_longitude, p_radius_m, p_max_accuracy_m, auth.uid(), now())
  on conflict (id) do update set
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    radius_m = excluded.radius_m,
    max_accuracy_m = excluded.max_accuracy_m,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
  returning * into v_settings;

  return jsonb_build_object(
    'configured', true,
    'latitude', v_settings.latitude,
    'longitude', v_settings.longitude,
    'radius_m', v_settings.radius_m,
    'max_accuracy_m', v_settings.max_accuracy_m,
    'updated_at', v_settings.updated_at
  );
end;
$$;

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
  if p_latitude is null or p_latitude not between -90 and 90
     or p_longitude is null or p_longitude not between -180 and 180
     or p_accuracy_m is null or p_accuracy_m <= 0 then
    return jsonb_build_object('ok', false, 'error', 'El teléfono no entregó una ubicación válida. Activa la ubicación e inténtalo otra vez.');
  end if;

  select * into v_settings
  from public.attendance_location_settings
  where id = 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'El administrador todavía debe configurar la ubicación del local.');
  end if;
  if p_accuracy_m > v_settings.max_accuracy_m then
    return jsonb_build_object('ok', false, 'error', 'La ubicación llegó con poca precisión. Activa el GPS, espera unos segundos e inténtalo otra vez.');
  end if;

  v_distance_m := 2 * 6371008.8 * asin(sqrt(least(1::double precision,
    power(sin(radians(p_latitude - v_settings.latitude) / 2), 2)
    + cos(radians(v_settings.latitude)) * cos(radians(p_latitude))
    * power(sin(radians(p_longitude - v_settings.longitude) / 2), 2)
  )));

  if v_distance_m > v_settings.radius_m then
    return jsonb_build_object('ok', false, 'error', 'Estás fuera del área permitida del local. Acércate al establecimiento para marcar.');
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
    return jsonb_build_object('ok', false, 'error', 'Ya registraste entrada y salida hoy, o espera un momento antes de volver a marcar.');
  end if;

  v_action := case when v_record.check_out_at is null then 'check_in' else 'check_out' end;
  insert into public.attendance_location_events
    (attendance_id, worker_id, event_type, latitude, longitude, accuracy_m, distance_m)
  values
    (v_record.id, v_user_id, v_action, p_latitude, p_longitude, p_accuracy_m, v_distance_m);

  return jsonb_build_object('ok', true, 'event', v_action, 'record', to_jsonb(v_record));
end;
$$;

revoke all on function public.get_attendance_location_settings() from public, anon;
grant execute on function public.get_attendance_location_settings() to authenticated;
revoke all on function public.set_attendance_location_settings(double precision, double precision, integer, integer) from public, anon;
grant execute on function public.set_attendance_location_settings(double precision, double precision, integer, integer) to authenticated;
revoke all on function public.record_attendance_with_location(double precision, double precision, double precision) from public, anon;
grant execute on function public.record_attendance_with_location(double precision, double precision, double precision) to authenticated;

-- Once the location flow is enabled, old QR/code RPCs must not bypass its check.
revoke all on function public.record_attendance_scan(uuid) from public, anon, authenticated;
revoke all on function public.record_attendance_code(text) from public, anon, authenticated;
