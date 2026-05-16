
-- shopify_orders: allow write from server (anon/auth used by worker)
CREATE POLICY "Sync can insert shopify_orders" ON public.shopify_orders
  FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Sync can update shopify_orders" ON public.shopify_orders
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- shopify_sync_state
CREATE POLICY "Sync can insert shopify_sync_state" ON public.shopify_sync_state
  FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Sync can update shopify_sync_state" ON public.shopify_sync_state
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- subscription_snapshots
CREATE POLICY "Sync can insert subscription_snapshots" ON public.subscription_snapshots
  FOR INSERT TO anon, authenticated WITH CHECK (true);
