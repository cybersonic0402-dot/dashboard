
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  perform cron.unschedule('shopify-nightly-sync');
exception when others then null;
end $$;

select cron.schedule(
  'shopify-nightly-sync',
  '0 3 * * *',
  $$
  select net.http_post(
    url := 'https://zapply.codestrokes.com/api/public/nightly-sync',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) as request_id;
  $$
);
