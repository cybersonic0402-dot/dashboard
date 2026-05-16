
-- Cash positions (manual entry)
CREATE TABLE public.cash_positions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'bank',
  currency TEXT NOT NULL DEFAULT 'EUR',
  balance_eur NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.cash_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth read cash_positions" ON public.cash_positions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Auth write cash_positions" ON public.cash_positions FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Inventory positions (manual entry / FFC)
CREATE TABLE public.inventory_positions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'NL',
  pieces NUMERIC NOT NULL DEFAULT 0,
  unit_cost_eur NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.inventory_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth read inventory_positions" ON public.inventory_positions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Auth write inventory_positions" ON public.inventory_positions FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- App settings (key/value)
CREATE TABLE public.app_settings (
  key TEXT NOT NULL PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth read app_settings" ON public.app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Auth write app_settings" ON public.app_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_cash_positions_updated BEFORE UPDATE ON public.cash_positions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_inventory_positions_updated BEFORE UPDATE ON public.inventory_positions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_app_settings_updated BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Seed min cash buffer setting
INSERT INTO public.app_settings (key, value, description)
VALUES ('min_cash_buffer_eur', '{"amount": 50000}'::jsonb, 'Minimum cash buffer in EUR (used in Forecast)')
ON CONFLICT (key) DO NOTHING;
