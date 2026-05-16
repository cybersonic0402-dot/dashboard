-- App-level integration rows (user_id IS NULL) are workspace-wide connectors
-- (Xero, Shopify, Jortt, etc.) that the OAuth callbacks store without a
-- specific owner. The previous owner-only policies hid them from the
-- server's fetchers, which surfaced as PostgREST PGRST116 "Cannot coerce
-- the result to a single JSON object" when refreshing the Xero token.

CREATE POLICY "App reads workspace integrations"
  ON public.integrations
  FOR SELECT
  TO anon, authenticated
  USING (user_id IS NULL);

CREATE POLICY "App writes workspace integrations"
  ON public.integrations
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (user_id IS NULL);

CREATE POLICY "App updates workspace integrations"
  ON public.integrations
  FOR UPDATE
  TO anon, authenticated
  USING (user_id IS NULL)
  WITH CHECK (user_id IS NULL);

-- Clear the stale "auth failed" cache row so the next sync writes a fresh result.
DELETE FROM public.data_cache WHERE provider = 'xero' AND cache_key = 'accounting';