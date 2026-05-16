-- Add owner column to integrations, cash_positions, inventory_positions, app_settings
-- and lock RLS policies to owner-only access. The server admin client bypasses RLS,
-- so existing server-side code keeps working. New rows created via the admin client
-- will have user_id NULL unless explicitly set; that's acceptable because no client
-- can read those rows directly.

ALTER TABLE public.integrations
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.cash_positions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.inventory_positions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Drop the existing permissive read on app_settings — replace with owner-scoped read.
DROP POLICY IF EXISTS "Auth read app_settings" ON public.app_settings;

-- Owner-scoped policies
CREATE POLICY "Owners read app_settings" ON public.app_settings
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owners write app_settings" ON public.app_settings
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners update app_settings" ON public.app_settings
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners delete app_settings" ON public.app_settings
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Owners read integrations" ON public.integrations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owners write integrations" ON public.integrations
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners update integrations" ON public.integrations
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners delete integrations" ON public.integrations
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Owners read cash_positions" ON public.cash_positions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owners write cash_positions" ON public.cash_positions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners update cash_positions" ON public.cash_positions
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners delete cash_positions" ON public.cash_positions
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Owners read inventory_positions" ON public.inventory_positions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owners write inventory_positions" ON public.inventory_positions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners update inventory_positions" ON public.inventory_positions
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners delete inventory_positions" ON public.inventory_positions
  FOR DELETE TO authenticated USING (auth.uid() = user_id);