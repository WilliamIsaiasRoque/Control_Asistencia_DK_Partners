-- Store each signed-in app installation's FCM token securely.
-- Device writes are exposed only through authenticated security-definer RPCs.

create table if not exists public.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  fcm_token text not null unique,
  platform text not null check (platform in ('android', 'ios')),
  device_label text,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_devices_token_not_empty
    check (length(btrim(fcm_token)) > 0)
);

create index if not exists push_devices_user_active_idx
  on public.push_devices (user_id, is_active);

alter table public.push_devices enable row level security;

revoke all on public.push_devices from anon, authenticated;
grant all on public.push_devices to service_role;

create or replace function public.register_push_device(
  p_fcm_token text,
  p_platform text,
  p_device_label text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_device_id uuid;
  v_token text := btrim(coalesce(p_fcm_token, ''));
begin
  if v_user_id is null then
    raise exception 'Inicia sesión para registrar este dispositivo.'
      using errcode = '28000';
  end if;

  if length(v_token) = 0 or length(v_token) > 4096 then
    raise exception 'El token del dispositivo no es válido.'
      using errcode = '22023';
  end if;

  if p_platform is null or p_platform not in ('android', 'ios') then
    raise exception 'La plataforma no es válida.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = v_user_id and is_active = true
  ) then
    raise exception 'La cuenta no está activa.'
      using errcode = '42501';
  end if;

  insert into public.push_devices (
    user_id, fcm_token, platform, device_label,
    is_active, last_seen_at, updated_at
  )
  values (
    v_user_id, v_token, p_platform,
    left(nullif(btrim(p_device_label), ''), 120),
    true, now(), now()
  )
  on conflict (fcm_token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        device_label = excluded.device_label,
        is_active = true,
        last_seen_at = now(),
        updated_at = now()
  returning id into v_device_id;

  return v_device_id;
end;
$$;

create or replace function public.unregister_push_device(p_fcm_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión para quitar este dispositivo.'
      using errcode = '28000';
  end if;

  update public.push_devices
  set is_active = false,
      updated_at = now()
  where user_id = auth.uid()
    and fcm_token = btrim(coalesce(p_fcm_token, ''));
end;
$$;

revoke all on function public.register_push_device(text, text, text)
  from public, anon;
grant execute on function public.register_push_device(text, text, text)
  to authenticated;

revoke all on function public.unregister_push_device(text)
  from public, anon;
grant execute on function public.unregister_push_device(text)
  to authenticated;
