CREATE TABLE IF NOT EXISTS public.integrations (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider      TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  metadata      JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS integrations_provider_unique
  ON public.integrations(provider);

CREATE TABLE IF NOT EXISTS public.data_cache (
  provider    TEXT NOT NULL,
  cache_key   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (provider, cache_key)
);

ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_cache    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Auth users read integrations" ON public.integrations;
DROP POLICY IF EXISTS "Auth users write integrations" ON public.integrations;
DROP POLICY IF EXISTS "Auth users read cache" ON public.data_cache;
DROP POLICY IF EXISTS "Auth users write cache" ON public.data_cache;

CREATE POLICY "Auth users read integrations"
  ON public.integrations FOR SELECT TO authenticated USING (true);

CREATE POLICY "Auth users write integrations"
  ON public.integrations FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Auth users read cache"
  ON public.data_cache FOR SELECT TO authenticated USING (true);

CREATE POLICY "Auth users write cache"
  ON public.data_cache FOR ALL TO authenticated USING (true) WITH CHECK (true);