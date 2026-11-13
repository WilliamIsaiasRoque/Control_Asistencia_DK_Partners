-- Allow an employee to start a day again when an admin previously cleared
-- both attendance times but kept the unique worker/day row for auditability.

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
    select 1 from public.profiles
    where id = v_user_id and role = 'worker' and is_active = true
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
    set check_in_at = case
          when public.attendance_records.check_in_at is null then now()
          else public.attendance_records.check_in_at
        end,
        check_out_at = case
          when public.attendance_records.check_in_at is not null
            and public.attendance_records.check_out_at is null
            and public.attendance_records.check_in_at < now() - interval '30 seconds'
          then now()
          else public.attendance_records.check_out_at
        end
    where public.attendance_records.check_in_at is null
       or (public.attendance_records.check_out_at is null
           and public.attendance_records.check_in_at < now() - interval '30 seconds')
  returning * into v_record;

  if not found then
    raise exception 'Ya registraste entrada y salida hoy, o espera un momento antes de volver a marcar.' using errcode = '22023';
  end if;
  return v_record;
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
    select 1 from public.profiles
    where id = v_user_id and role = 'worker' and is_active = true
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
    set check_in_at = case
          when public.attendance_records.check_in_at is null then now()
          else public.attendance_records.check_in_at
        end,
        check_out_at = case
          when public.attendance_records.check_in_at is not null
            and public.attendance_records.check_out_at is null
            and public.attendance_records.check_in_at < now() - interval '30 seconds'
          then now()
          else public.attendance_records.check_out_at
        end
    where public.attendance_records.check_in_at is null
       or (public.attendance_records.check_out_at is null
           and public.attendance_records.check_in_at < now() - interval '30 seconds')
  returning * into v_record;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Ya registraste entrada y salida hoy, o espera un momento antes de volver a marcar.');
  end if;
  return jsonb_build_object('ok', true, 'record', to_jsonb(v_record));
end;
$$;

revoke all on function public.record_attendance_scan(uuid) from public, anon;
grant execute on function public.record_attendance_scan(uuid) to authenticated;
revoke all on function public.record_attendance_code(text) from public, anon;
grant execute on function public.record_attendance_code(text) to authenticated;
