-- Ejecutar una sola vez después de desplegar send-attendance-reminders.
-- Antes de ejecutar, reemplaza el valor de REMINDER_CRON_SECRET por el mismo
-- valor guardado en Edge Function Secrets. No guardes el valor real en Git.

select vault.create_secret(
  'https://evnfjzomveojmxbvyeav.supabase.co/functions/v1/send-attendance-reminders',
  'attendance_reminders_url'
)
where not exists (
  select 1 from vault.secrets where name = 'attendance_reminders_url'
);

select vault.create_secret(
  'REPLACE_WITH_REMINDER_CRON_SECRET',
  'attendance_reminders_secret'
)
where not exists (
  select 1 from vault.secrets where name = 'attendance_reminders_secret'
);

select cron.unschedule(jobid)
from cron.job
where jobname = 'attendance-reminders-every-20-minutes';

select cron.schedule(
  'attendance-reminders-every-20-minutes',
  '*/20 * * * *',
  $$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'attendance_reminders_url'
        limit 1
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-reminder-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'attendance_reminders_secret'
          limit 1
        )
      ),
      body := '{}'::jsonb
    );
  $$
);
