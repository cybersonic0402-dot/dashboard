-- Remove any prior schedule with the same name to keep this idempotent
SELECT cron.unschedule('zapply-scheduled-sync-30min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'zapply-scheduled-sync-30min');

SELECT cron.schedule(
  'zapply-scheduled-sync-30min',
  '*/30 * * * *',
  $$SELECT net.http_post(
    url:='https://coktedrgtpecruympsvv.supabase.co/functions/v1/scheduled-sync',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNva3RlZHJndHBlY3J1eW1wc3Z2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMjM5NDYsImV4cCI6MjA5MjU5OTk0Nn0.nNeS6X7dF9AAPo6kUZyoNMQEzd6V8rKYAPwdwXciooE"}'::jsonb,
    body:='{}'::jsonb
  ) AS request_id;$$
);