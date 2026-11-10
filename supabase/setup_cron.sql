-- Ejecutar una sola vez en Supabase SQL Editor.
select vault.create_secret(
  'https://evnfjzomveojmxbvyeav.supabase.co/functions/v1/sync-google-sheets',
  'sheets_sync_url'
);

select vault.create_secret(
  'REPLACE_WITH_SYNC_CRON_SECRET',
  'sheets_sync_secret'
);

select cron.schedule(
  'sync-google-sheets-every-5-minutes',
  '*/5 * * * *',
  $$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'sheets_sync_url'
        limit 1
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'sheets_sync_secret'
          limit 1
        )
      ),
      body := '{}'::jsonb
    );
  $$
);