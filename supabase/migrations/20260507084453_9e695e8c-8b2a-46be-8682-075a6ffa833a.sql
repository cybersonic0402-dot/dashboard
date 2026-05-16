-- Remove public access on sensitive tables (tokens + cached PII).
-- All app access goes through supabaseAdmin server-side which bypasses RLS.
DROP POLICY IF EXISTS "Anyone read integrations" ON public.integrations;
DROP POLICY IF EXISTS "Anyone write integrations" ON public.integrations;
DROP POLICY IF EXISTS "Anyone read cache" ON public.data_cache;
DROP POLICY IF EXISTS "Anyone write cache" ON public.data_cache;

-- Lock down data_cache to authenticated reads only; no client writes.
CREATE POLICY "Auth read data_cache"
  ON public.data_cache FOR SELECT
  TO authenticated
  USING (true);