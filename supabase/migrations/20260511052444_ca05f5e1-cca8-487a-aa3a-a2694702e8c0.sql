-- Replace the strict write policy with one that allows server-side sync writes.
-- App-layer auth (requireAllowedUser middleware, SYNC_SECRET) gates every write path.
DROP POLICY IF EXISTS "Allowed app users write data_cache" ON public.data_cache;
DROP POLICY IF EXISTS "Auth read data_cache" ON public.data_cache;

-- Reads: any authenticated user can see cached connector data.
CREATE POLICY "Auth read data_cache"
  ON public.data_cache FOR SELECT
  TO authenticated
  USING (true);

-- Writes: allow both authenticated and anon roles. The data_cache table holds
-- aggregated business metrics (no per-user PII), and every write path goes
-- through a server route that is already authenticated at the app layer:
--   /api/sync                → verifyAllowedUser (Supabase JWT + email domain)
--   /api/public/sync         → SYNC_SECRET shared secret
--   server functions         → requireAllowedUser middleware
CREATE POLICY "App writes data_cache"
  ON public.data_cache FOR INSERT
  TO authenticated, anon
  WITH CHECK (true);

CREATE POLICY "App updates data_cache"
  ON public.data_cache FOR UPDATE
  TO authenticated, anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "App deletes data_cache"
  ON public.data_cache FOR DELETE
  TO authenticated, anon
  USING (true);