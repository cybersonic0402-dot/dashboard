-- Add unique constraint required for upsert onConflict
ALTER TABLE public.data_cache
  DROP CONSTRAINT IF EXISTS data_cache_provider_cache_key_key;
ALTER TABLE public.data_cache
  ADD CONSTRAINT data_cache_provider_cache_key_key UNIQUE (provider, cache_key);

-- Replace authenticated-only policies with permissive ones so the
-- background sync (running without a user JWT) can populate the cache.
DROP POLICY IF EXISTS "Auth users read cache" ON public.data_cache;
DROP POLICY IF EXISTS "Auth users write cache" ON public.data_cache;

CREATE POLICY "Anyone read cache"
  ON public.data_cache
  FOR SELECT
  USING (true);

CREATE POLICY "Anyone write cache"
  ON public.data_cache
  FOR ALL
  USING (true)
  WITH CHECK (true);