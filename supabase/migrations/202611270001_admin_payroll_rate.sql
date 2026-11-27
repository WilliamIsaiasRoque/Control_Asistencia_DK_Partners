-- Store the hourly rate behind admin-only row-level security.
-- Payroll figures are calculated by the web dashboard and are not written to attendance or Google Sheets.
create table if not exists public.attendance_payroll_settings (
  id boolean primary key default true check (id = true),
  hourly_rate numeric(8, 2) not null default 6.25 check (hourly_rate >= 0),
  updated_at timestamptz not null default now()
);

insert into public.attendance_payroll_settings (id, hourly_rate)
values (true, 6.25)
on conflict (id) do nothing;

alter table public.attendance_payroll_settings enable row level security;

drop policy if exists attendance_payroll_settings_admin_read on public.attendance_payroll_settings;
create policy attendance_payroll_settings_admin_read
  on public.attendance_payroll_settings
  for select
  to authenticated
  using (public.is_admin());

revoke all on public.attendance_payroll_settings from anon, authenticated;
grant select on public.attendance_payroll_settings to authenticated;
