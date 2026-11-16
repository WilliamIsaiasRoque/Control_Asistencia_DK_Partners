-- Allow every active worker to mark attendance at either authorized location.
-- Keep the former single location as Av. Union and add Calle Puno.

create table if not exists public.attendance_location_sites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_m integer not null default 25 check (radius_m between 10 and 2000),
  max_accuracy_m integer not null default 25 check (max_accuracy_m between 10 and 1000),
  is_active boolean not null default true,
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.attendance_location_site_workers (
  site_id uuid not null references public.attendance_location_sites(id) on delete cascade,
  worker_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (site_id, worker_id)
);

alter table public.attendance_location_events
  add column if not exists site_id uuid references public.attendance_location_sites(id) on delete set null;
alter table public.attendance_location_attempts
  add column if not exists site_id uuid references public.attendance_location_sites(id) on delete set null,
  add column if not exists site_name text;

alter table public.attendance_location_sites enable row level security;
alter table public.attendance_location_site_workers enable row level security;
revoke all on public.attendance_location_sites from anon, authenticated;
revoke all on public.attendance_location_site_workers from anon, authenticated;
grant select on public.attendance_location_sites to authenticated;
grant select on public.attendance_location_site_workers to authenticated;
drop policy if exists attendance_location_sites_admin_read on public.attendance_location_sites;
create policy attendance_location_sites_admin_read
  on public.attendance_location_sites for select to authenticated
  using (public.is_admin());
drop policy if exists attendance_location_site_workers_admin_read on public.attendance_location_site_workers;
create policy attendance_location_site_workers_admin_read
  on public.attendance_location_site_workers for select to authenticated
  using (public.is_admin());

-- Preserve the current Av. Union point and its thresholds for everyone.
insert into public.attendance_location_sites
  (code, name, latitude, longitude, radius_m, max_accuracy_m, is_active)
select 'av-union-619', 'Av. Unión 619', latitude, longitude, radius_m, max_accuracy_m, true
from public.attendance_location_settings
where id = 1
on conflict (code) do update set
  name = excluded.name,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  radius_m = excluded.radius_m,
  max_accuracy_m = excluded.max_accuracy_m,
  is_active = true,
  updated_at = now();

-- Calle Puno is the second authorized site for every active worker.
insert into public.attendance_location_sites
  (code, name, latitude, longitude, radius_m, max_accuracy_m, is_active)
values
  ('calle-puno-564', 'Calle Puno 564', -16.397627310200185, -71.52072751564343, 25, 25, true)
on conflict (code) do update set
  name = excluded.name,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  radius_m = 25,
  max_accuracy_m = 25,
  is_active = true,
  updated_at = now();

-- Make Av. Union available to every current active worker.
insert into public.attendance_location_site_workers (site_id, worker_id)
select s.id, p.id
from public.attendance_location_sites s
cross join public.profiles p
where s.code = 'av-union-619'
  and p.role = 'worker'
  and p.is_active = true
on conflict do nothing;

-- Grant Calle Puno to every current active worker, including Shantal.
insert into public.attendance_location_site_workers (site_id, worker_id)
select s.id, p.id
from public.attendance_location_sites s
cross join public.profiles p
where s.code = 'calle-puno-564'
  and p.role = 'worker'
  and p.is_active = true
on conflict do nothing;

create or replace function public.assign_default_location_to_worker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'worker' and new.is_active then
    insert into public.attendance_location_site_workers (site_id, worker_id)
    select id, new.id
    from public.attendance_location_sites
    where code in ('av-union-619', 'calle-puno-564')
      and is_active = true
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_assign_default_location on public.profiles;
create trigger profiles_assign_default_location
  after insert or update of role, is_active on public.profiles
  for each row execute function public.assign_default_location_to_worker();

create or replace function public.save_attendance_location_site(
  p_site_id uuid,
  p_name text,
  p_latitude double precision,
  p_longitude double precision,
  p_radius_m integer,
  p_max_accuracy_m integer,
  p_is_active boolean,
  p_worker_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_site_id uuid;
  v_code text;
begin
  if not public.is_admin() then
    raise exception 'Solo el administrador puede gestionar ubicaciones.' using errcode = '42501';
  end if;
  if p_name is null or length(trim(p_name)) < 3 then
    raise exception 'Escribe un nombre de al menos 3 caracteres.' using errcode = '22023';
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
  if coalesce(cardinality(p_worker_ids), 0) = 0 then
    raise exception 'Asigna al menos un trabajador a esta ubicación.' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_worker_ids) as selected(worker_id)
    where not exists (
      select 1 from public.profiles p
      where p.id = selected.worker_id and p.role = 'worker' and p.is_active = true
    )
  ) then
    raise exception 'Solo puedes asignar trabajadores activos.' using errcode = '22023';
  end if;

  if p_site_id is null then
    v_code := 'custom-' || replace(gen_random_uuid()::text, '-', '');
    insert into public.attendance_location_sites
      (code, name, latitude, longitude, radius_m, max_accuracy_m, is_active, updated_by)
    values
      (v_code, trim(p_name), p_latitude, p_longitude, p_radius_m, p_max_accuracy_m, coalesce(p_is_active, true), auth.uid())
    returning id into v_site_id;
  else
    update public.attendance_location_sites
    set name = trim(p_name),
        latitude = p_latitude,
        longitude = p_longitude,
        radius_m = p_radius_m,
        max_accuracy_m = p_max_accuracy_m,
        is_active = coalesce(p_is_active, true),
        updated_by = auth.uid(),
        updated_at = now()
    where id = p_site_id
    returning id into v_site_id;
    if v_site_id is null then
      raise exception 'No se encontró esa ubicación.' using errcode = 'P0002';
    end if;
  end if;

  delete from public.attendance_location_site_workers where site_id = v_site_id;
  insert into public.attendance_location_site_workers (site_id, worker_id)
  select v_site_id, selected.worker_id
  from (select distinct unnest(p_worker_ids) as worker_id) as selected;

  return v_site_id;
end;
$$;

revoke all on function public.save_attendance_location_site(uuid, text, double precision, double precision, integer, integer, boolean, uuid[]) from public, anon;
grant execute on function public.save_attendance_location_site(uuid, text, double precision, double precision, integer, integer, boolean, uuid[]) to authenticated;

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
