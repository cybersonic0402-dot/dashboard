-- All app access for these tables uses the service-role admin client server-side.
-- Removing client-facing policies makes them inaccessible from the browser
-- without breaking server-side reads/writes (service role bypasses RLS).

-- integrations: OAuth tokens — no client access at all.
DROP POLICY IF EXISTS "Auth users read integrations" ON public.integrations;
DROP POLICY IF EXISTS "Auth users write integrations" ON public.integrations;

-- cash_positions: financial balances — no client access.
DROP POLICY IF EXISTS "Auth read cash_positions" ON public.cash_positions;
DROP POLICY IF EXISTS "Auth write cash_positions" ON public.cash_positions;

-- inventory_positions: no client access.
DROP POLICY IF EXISTS "Auth read inventory_positions" ON public.inventory_positions;
DROP POLICY IF EXISTS "Auth write inventory_positions" ON public.inventory_positions;

-- app_settings: keep authenticated read for any future client UI; remove write.
DROP POLICY IF EXISTS "Auth write app_settings" ON public.app_settings;