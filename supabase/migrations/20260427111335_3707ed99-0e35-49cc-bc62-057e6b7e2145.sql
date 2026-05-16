-- Allow anon role to read/write integrations (matches data_cache pattern)
DROP POLICY IF EXISTS "Anyone read integrations" ON public.integrations;
DROP POLICY IF EXISTS "Anyone write integrations" ON public.integrations;

CREATE POLICY "Anyone read integrations"
  ON public.integrations FOR SELECT
  USING (true);

CREATE POLICY "Anyone write integrations"
  ON public.integrations FOR ALL
  USING (true)
  WITH CHECK (true);