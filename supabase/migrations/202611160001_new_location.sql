-- Add Repuestport as an internal attendance location.
-- It is active for attendance validation, but hidden from the admin location list.

alter table public.attendance_location_sites
  add column if not exists is_visible boolean not null default true;

insert into public.attendance_location_sites
  (code, name, latitude, longitude, radius_m, max_accuracy_m, is_active, is_visible)
values
  ('repuestport', 'Repuestport', -16.395697070916633, -71.52375131553474, 25, 25, true, false)
on conflict (code) do update set
  name = excluded.name,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  radius_m = excluded.radius_m,
  max_accuracy_m = excluded.max_accuracy_m,
  is_active = true,
  is_visible = false,
  updated_at = now();

-- Allow every current active worker to mark at Repuestport.
insert into public.attendance_location_site_workers (site_id, worker_id)
select s.id, p.id
from public.attendance_location_sites s
cross join public.profiles p
where s.code = 'repuestport'
  and s.is_active = true
  and p.role = 'worker'
  and p.is_active = true
on conflict do nothing;

-- Also assign the hidden point to workers created or activated in the future.
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
    where code in ('av-union-619', 'calle-puno-564', 'repuestport')
      and is_active = true
    on conflict do nothing;
  end if;
  return new;
end;
$$;
