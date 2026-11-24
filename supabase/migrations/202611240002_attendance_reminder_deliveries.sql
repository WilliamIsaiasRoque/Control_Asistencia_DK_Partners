-- Track each scheduled reminder per device and prevent duplicate delivery.

create table if not exists public.attendance_reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.push_devices(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  work_date date not null,
  reminder_slot time not null check (
    reminder_slot in (
      time '17:00', time '17:20', time '17:40', time '18:00', time '18:20'
    )
  ),
  status text not null default 'sending'
    check (status in ('sending', 'sent', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_reminder_one_per_device_slot
    unique (device_id, work_date, reminder_slot)
);

create index if not exists attendance_reminder_user_date_idx
  on public.attendance_reminder_deliveries (user_id, work_date, reminder_slot);

alter table public.attendance_reminder_deliveries enable row level security;
revoke all on public.attendance_reminder_deliveries from anon, authenticated;
grant all on public.attendance_reminder_deliveries to service_role;

create or replace function public.claim_attendance_reminder(
  p_device_id uuid,
  p_work_date date,
  p_reminder_slot time
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_delivery_id uuid;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'Solo el servicio de notificaciones puede reclamar avisos.'
      using errcode = '42501';
  end if;

  if p_work_date is null or p_reminder_slot is null or p_reminder_slot not in (
    time '17:00', time '17:20', time '17:40', time '18:00', time '18:20'
  ) then
    raise exception 'La fecha u horario del aviso no es válido.'
      using errcode = '22023';
  end if;

  select d.user_id into v_user_id
  from public.push_devices d
  join public.profiles p on p.id = d.user_id and p.is_active = true
  where d.id = p_device_id and d.is_active = true;

  if v_user_id is null or not exists (
    select 1 from public.attendance_records a
    where a.worker_id = v_user_id
      and a.work_date = p_work_date
      and a.check_in_at is not null
      and a.check_out_at is null
  ) then
    return null;
  end if;

  insert into public.attendance_reminder_deliveries as existing_delivery (
    device_id, user_id, work_date, reminder_slot, status, attempts
  )
  values (p_device_id, v_user_id, p_work_date, p_reminder_slot, 'sending', 1)
  on conflict (device_id, work_date, reminder_slot) do update
    set status = 'sending',
        attempts = existing_delivery.attempts + 1,
        last_error = null,
        updated_at = now()
    where existing_delivery.status = 'failed'
       or (
         existing_delivery.status = 'sending'
         and existing_delivery.updated_at < now() - interval '10 minutes'
       )
  returning id into v_delivery_id;

  return v_delivery_id;
end;
$$;

revoke all on function public.claim_attendance_reminder(uuid, date, time)
  from public, anon, authenticated;
grant execute on function public.claim_attendance_reminder(uuid, date, time)
  to service_role;
