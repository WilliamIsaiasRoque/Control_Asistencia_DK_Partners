-- Permit an exact 10 m radius and activate it for the configured store.
-- GPS quality remains an independent limit; this migration uses 10 m as well.

alter table public.attendance_location_settings
  drop constraint if exists attendance_location_settings_radius_m_check;

alter table public.attendance_location_settings
  add constraint attendance_location_settings_radius_m_check
  check (radius_m between 10 and 2000);

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
  if p_radius_m is null or p_radius_m not between 10 and 2000 then
    raise exception 'El radio debe estar entre 10 y 2000 metros.' using errcode = '22023';
  end if;
  if p_max_accuracy_m is null or p_max_accuracy_m not between 10 and 1000 then
    raise exception 'La precisión máxima debe estar entre 10 y 1000 metros.' using errcode = '22023';
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

-- Tighten the current setting to the requested 10 m / 10 m thresholds.
update public.attendance_location_settings
set radius_m = 10,
    max_accuracy_m = 10,
    updated_at = now()
where id = 1;

revoke all on function public.set_attendance_location_settings(double precision, double precision, integer, integer) from public, anon;
grant execute on function public.set_attendance_location_settings(double precision, double precision, integer, integer) to authenticated;
