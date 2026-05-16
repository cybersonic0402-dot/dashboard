-- Allow the public sync worker role to read rows needed by PostgREST upsert.
-- Supabase upsert uses ON CONFLICT/UPDATE semantics, which require a matching read policy when RLS is enabled.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'shopify_orders'
      AND policyname = 'Sync can read shopify_orders for upsert'
  ) THEN
    CREATE POLICY "Sync can read shopify_orders for upsert"
    ON public.shopify_orders
    FOR SELECT
    TO anon, authenticated
    USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'shopify_sync_state'
      AND policyname = 'Sync can read shopify_sync_state for upsert'
  ) THEN
    CREATE POLICY "Sync can read shopify_sync_state for upsert"
    ON public.shopify_sync_state
    FOR SELECT
    TO anon, authenticated
    USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'subscription_snapshots'
      AND policyname = 'Sync can read subscription_snapshots for upsert'
  ) THEN
    CREATE POLICY "Sync can read subscription_snapshots for upsert"
    ON public.subscription_snapshots
    FOR SELECT
    TO anon, authenticated
    USING (true);
  END IF;
END $$;