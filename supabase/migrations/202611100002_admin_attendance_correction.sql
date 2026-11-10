-- Admin-only attendance corrections with an audit trail.
create table if not exists public.attendance_adjustments (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.attendance_records(id) on delete cascade,
  worker_id uuid not null references public.profiles(id),
  work_date date not null,
  changed_by uuid not null references public.profiles(id),
  reason text not null,
  old_check_in_at timestamptz,
  old_check_out_at timestamptz,
  new_check_in_at timestamptz,
  new_check_out_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists attendance_adjustments_created_at_idx
  on public.attendance_adjustments(created_at desc);

alter table public.attendance_adjustments enable row level security;

drop policy if exists attendance_adjustments_admin_read on public.attendance_adjustments;
create policy attendance_adjustments_admin_read
  on public.attendance_adjustments for select to authenticated
  using (public.is_admin());

revoke all on public.attendance_adjustments from anon, authenticated;
grant select on public.attendance_adjustments to authenticated;

create or replace function public.admin_correct_attendance(
  p_worker_id uuid,
  p_work_date date,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.attendance_records;
  v_old_check_in timestamptz;
  v_old_check_out timestamptz;
  v_had_record boolean;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_adjustment_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Solo el administrador puede corregir asistencias.' using errcode = '42501';
  end if;
  if p_worker_id is null or p_work_date is null then
    raise exception 'Selecciona un trabajador y una fecha.' using errcode = '22023';
  end if;
  if length(v_reason) < 5 then
    raise exception 'Escribe un motivo de al menos 5 caracteres.' using errcode = '22023';
  end if;
  if p_check_out_at is not null and (p_check_in_at is null or p_check_out_at < p_check_in_at) then
    raise exception 'La salida debe tener una entrada previa y no puede ser anterior.' using errcode = '22023';
  end if;
  if p_check_in_at is not null and (p_check_in_at at time zone 'America/Lima')::date <> p_work_date then
    raise exception 'La hora de entrada no corresponde a la fecha elegida en Perú.' using errcode = '22023';
  end if;
  if p_check_out_at is not null and (p_check_out_at at time zone 'America/Lima')::date <> p_work_date then
    raise exception 'La hora de salida no corresponde a la fecha elegida en Perú.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_worker_id and role = 'worker' and is_active = true
  ) then
    raise exception 'El trabajador no existe o está inactivo.' using errcode = '22023';
  end if;

  select a.check_in_at, a.check_out_at
    into v_old_check_in, v_old_check_out
  from public.attendance_records a
  where a.worker_id = p_worker_id and a.work_date = p_work_date
  for update;
  v_had_record := found;

  if not v_had_record and p_check_in_at is null and p_check_out_at is null then
    raise exception 'No existe una marca para limpiar; ingresa una entrada o salida.' using errcode = '22023';
  end if;

  insert into public.attendance_records (worker_id, work_date, check_in_at, check_out_at)
  values (p_worker_id, p_work_date, p_check_in_at, p_check_out_at)
  on conflict (worker_id, work_date) do update
    set check_in_at = excluded.check_in_at,
        check_out_at = excluded.check_out_at
  returning * into v_record;

  insert into public.attendance_adjustments (
    attendance_id, worker_id, work_date, changed_by, reason,
    old_check_in_at, old_check_out_at, new_check_in_at, new_check_out_at
  ) values (
    v_record.id, p_worker_id, p_work_date, auth.uid(), v_reason,
    v_old_check_in, v_old_check_out, p_check_in_at, p_check_out_at
  ) returning id into v_adjustment_id;

  -- The attendance_records trigger automatically returns this row to sync_log as pending.
  return jsonb_build_object(
    'attendance_id', v_record.id,
    'adjustment_id', v_adjustment_id,
    'work_date', v_record.work_date,
    'check_in_at', v_record.check_in_at,
    'check_out_at', v_record.check_out_at
  );
end;
$$;

revoke all on function public.admin_correct_attendance(uuid, date, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.admin_correct_attendance(uuid, date, timestamptz, timestamptz, text) to authenticated;
