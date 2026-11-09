-- Add a 4-digit manual alternative to the shared QR attendance session.
-- The QR token and short code belong to the same active session.
alter table public.attendance_qr_sessions
  add column if not exists access_code text;

create table if not exists public.attendance_code_attempts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0)
);

alter table public.attendance_code_attempts enable row level security;
revoke all on public.attendance_code_attempts from anon, authenticated;

create or replace function public.create_attendance_qr_session()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token uuid;
  v_code text;
  v_expires_at timestamptz := now() + interval '12 hours';
begin
  if not public.is_admin() then
    raise exception 'Solo el administrador puede generar el QR y la clave.' using errcode = '42501';
  end if;

  update public.attendance_qr_sessions set revoked_at = now() where revoked_at is null;
  loop
    v_code := lpad(floor(random() * 10000)::integer::text, 4, '0');
    exit when not exists (
      select 1 from public.attendance_qr_sessions
      where access_code = v_code and revoked_at is null and expires_at > now()
    );
  end loop;

  insert into public.attendance_qr_sessions (created_by, expires_at, access_code)
  values (auth.uid(), v_expires_at, v_code)
  returning token into v_token;

  return jsonb_build_object('token', v_token, 'access_code', v_code, 'expires_at', v_expires_at);
end;
$$;

create or replace function public.record_attendance_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_work_date date := (now() at time zone 'America/Lima')::date;
  v_record public.attendance_records;
  v_attempts integer;
  v_code_valid boolean;
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'Inicia sesión antes de marcar.');
  end if;
  if not exists (
    select 1 from public.profiles where id = v_user_id and role = 'worker' and is_active = true
  ) then
    return jsonb_build_object('ok', false, 'error', 'La cuenta no está habilitada para marcar asistencia.');
  end if;

  select exists (
    select 1 from public.attendance_qr_sessions
    where access_code = p_code and revoked_at is null and expires_at > now()
  ) into v_code_valid;

  if not v_code_valid then
    insert into public.attendance_code_attempts (user_id, window_started_at, attempts)
    values (v_user_id, now(), 1)
    on conflict (user_id) do update
      set attempts = case
            when public.attendance_code_attempts.window_started_at < now() - interval '15 minutes' then 1
            else public.attendance_code_attempts.attempts + 1
          end,
          window_started_at = case
            when public.attendance_code_attempts.window_started_at < now() - interval '15 minutes' then now()
            else public.attendance_code_attempts.window_started_at
          end
    returning attempts into v_attempts;

    if v_attempts > 5 then
      return jsonb_build_object('ok', false, 'error', 'Demasiados intentos. Espera 15 minutos o pide una clave nueva al administrador.');
    end if;
    return jsonb_build_object('ok', false, 'error', 'La clave no es válida o ya venció. Pide la clave vigente al administrador.');
  end if;

  delete from public.attendance_code_attempts where user_id = v_user_id;
  insert into public.attendance_records (worker_id, work_date, check_in_at)
  values (v_user_id, v_work_date, now())
  on conflict (worker_id, work_date) do update
    set check_out_at = now()
    where public.attendance_records.check_in_at is not null
      and public.attendance_records.check_out_at is null
      and public.attendance_records.check_in_at < now() - interval '30 seconds'
  returning * into v_record;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Ya registraste entrada y salida hoy, o espera un momento antes de volver a marcar.');
  end if;
  return jsonb_build_object('ok', true, 'record', to_jsonb(v_record));
end;
$$;

revoke all on function public.create_attendance_qr_session() from public, anon;
grant execute on function public.create_attendance_qr_session() to authenticated;
revoke all on function public.record_attendance_code(text) from public, anon;
grant execute on function public.record_attendance_code(text) to authenticated;
