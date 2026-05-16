drop policy if exists "Auth read data_cache" on public.data_cache;

create policy "App reads data_cache"
on public.data_cache
for select
to anon, authenticated
using (true);