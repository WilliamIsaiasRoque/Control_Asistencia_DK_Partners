-- Run once in Supabase SQL Editor after replacing both placeholders.
-- Keep the cron secret in Supabase Vault and in Edge Function secrets only.
select vault.create_secret(
  'https://YOUR_PROJECT_REF.supabase.co/functions/v1/sync-google-sheets',
  'sheets_sync_url'
);

select vault.create_secret(
  'REPLACE_WITH_THE_SAME_RANDOM_SECRET_SET_IN_SUPABASE_EDGE_SECRETS',
  'sheets_sync_secret'
);

select cron.schedule(
  'sync-google-sheets-every-5-minutes',
  '*/5 * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheets_sync_url' limit 1),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sheets_sync_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $$
);
