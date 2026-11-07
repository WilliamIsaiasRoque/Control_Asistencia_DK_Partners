-- DK Partners attendance foundation. Apply with Supabase CLI or SQL Editor.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role text not null default 'worker' check (role in ('admin', 'worker')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.profiles(id),
  work_date date not null,
  check_in_at timestamptz,
  check_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_one_row_per_worker_day unique (worker_id, work_date),
  constraint attendance_exit_after_entry check (check_out_at is null or (check_in_at is not null and check_out_at >= check_in_at))
);

create table if not exists public.attendance_qr_sessions (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table if not exists public.sync_log (
  attendance_id uuid primary key references public.attendance_records(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'synced', 'error')),
  error text,
  intentos integer not null default 0 check (intentos >= 0),
  updated_at timestamptz not null default now()
);

create index if not exists attendance_records_work_date_idx on public.attendance_records(work_date);
create index if not exists sync_log_retry_idx on public.sync_log(status, updated_at);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active = true
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists attendance_set_updated_at on public.attendance_records;
create trigger attendance_set_updated_at before update on public.attendance_records
for each row execute function public.set_updated_at();

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users
for each row execute function public.create_profile_for_auth_user();

create or replace function public.queue_attendance_for_sheets()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.sync_log (attendance_id, status, error, intentos, updated_at)
  values (new.id, 'pending', null, 0, now())
  on conflict (attendance_id) do update
    set status = 'pending', error = null, intentos = 0, updated_at = now();
  return new;
end;
$$;

drop trigger if exists attendance_queue_sheets on public.attendance_records;
create trigger attendance_queue_sheets after insert or update of check_in_at, check_out_at
on public.attendance_records for each row
execute function public.queue_attendance_for_sheets();

create or replace function public.create_attendance_qr_session()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid;
  v_expires_at timestamptz := now() + interval '12 hours';
begin
  if not public.is_admin() then
    raise exception 'Solo el administrador puede generar el QR.' using errcode = '42501';
  end if;
  update public.attendance_qr_sessions set revoked_at = now() where revoked_at is null;
  insert into public.attendance_qr_sessions (created_by, expires_at)
  values (auth.uid(), v_expires_at)
  returning token into v_token;
  return jsonb_build_object('token', v_token, 'expires_at', v_expires_at);
end;
$$;

create or replace function public.record_attendance_scan(p_qr_token uuid)
returns public.attendance_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_work_date date := (now() at time zone 'America/Lima')::date;
  v_record public.attendance_records;
begin
  if v_user_id is null then
    raise exception 'Inicia sesión antes de marcar.' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.profiles where id = v_user_id and role = 'worker' and is_active = true
  ) then
    raise exception 'La cuenta no está habilitada para marcar asistencia.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.attendance_qr_sessions
    where token = p_qr_token and revoked_at is null and expires_at > now()
  ) then
    raise exception 'El QR venció o fue renovado. Escanea el código actual.' using errcode = '22023';
  end if;

  insert into public.attendance_records (worker_id, work_date, check_in_at)
  values (v_user_id, v_work_date, now())
  on conflict (worker_id, work_date) do update
    set check_out_at = now()
    where public.attendance_records.check_in_at is not null
      and public.attendance_records.check_out_at is null
      and public.attendance_records.check_in_at < now() - interval '30 seconds'
  returning * into v_record;

  if not found then
    raise exception 'Ya registraste entrada y salida hoy, o espera un momento antes de volver a escanear.' using errcode = '22023';
  end if;
  return v_record;
end;
$$;

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
    raise exception 'El rango de fechas no es válido.' using errcode = '22023';
  end if;
  insert into public.sync_log (attendance_id, status, error, intentos, updated_at)
  select id, 'pending', null, 0, now()
  from public.attendance_records
  where work_date between p_from_date and p_to_date
  on conflict (attendance_id) do update
    set status = 'pending', error = null, intentos = 0, updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.claim_pending_sheet_syncs(p_limit integer default 25)
returns table (attendance_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'Solo el sincronizador interno puede reclamar la cola.' using errcode = '42501';
  end if;
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

alter table public.profiles enable row level security;
alter table public.attendance_records enable row level security;
alter table public.attendance_qr_sessions enable row level security;
alter table public.sync_log enable row level security;

drop policy if exists profiles_read_self_or_admin on public.profiles;
create policy profiles_read_self_or_admin on public.profiles for select to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_admin_manage on public.profiles;
create policy profiles_admin_manage on public.profiles for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists attendance_read_self_or_admin on public.attendance_records;
create policy attendance_read_self_or_admin on public.attendance_records for select to authenticated
using (worker_id = auth.uid() or public.is_admin());

drop policy if exists qr_sessions_admin_read on public.attendance_qr_sessions;
create policy qr_sessions_admin_read on public.attendance_qr_sessions for select to authenticated
using (public.is_admin());

drop policy if exists sync_log_admin_read on public.sync_log;
create policy sync_log_admin_read on public.sync_log for select to authenticated
using (public.is_admin());

revoke all on public.attendance_records from anon, authenticated;
grant select on public.attendance_records to authenticated;
revoke all on public.sync_log from anon, authenticated;
grant select on public.sync_log to authenticated;
revoke all on public.attendance_qr_sessions from anon, authenticated;
grant select on public.attendance_qr_sessions to authenticated;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert, update, delete on public.profiles to authenticated;

revoke all on function public.create_attendance_qr_session() from public, anon;
grant execute on function public.create_attendance_qr_session() to authenticated;
revoke all on function public.record_attendance_scan(uuid) from public, anon;
grant execute on function public.record_attendance_scan(uuid) to authenticated;
revoke all on function public.queue_attendance_resync(date, date) from public, anon;
grant execute on function public.queue_attendance_resync(date, date) to authenticated;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.claim_pending_sheet_syncs(integer) from public, anon, authenticated;
grant execute on function public.claim_pending_sheet_syncs(integer) to service_role;
