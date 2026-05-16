DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'loop_sync_state'
      AND policyname = 'loop_sync_state read app for upsert'
  ) THEN
    CREATE POLICY "loop_sync_state read app for upsert"
    ON public.loop_sync_state
    FOR SELECT
    TO anon, authenticated
    USING (true);
  END IF;
END $$;