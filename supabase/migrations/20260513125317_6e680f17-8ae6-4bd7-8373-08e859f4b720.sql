CREATE TABLE IF NOT EXISTS public.loop_sync_state (
  market text NOT NULL,
  status text NOT NULL,
  page_no integer NOT NULL DEFAULT 1,
  done boolean NOT NULL DEFAULT false,
  total_fetched integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market, status)
);

ALTER TABLE public.loop_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "loop_sync_state read auth" ON public.loop_sync_state FOR SELECT TO authenticated USING (true);
CREATE POLICY "loop_sync_state all service" ON public.loop_sync_state FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER loop_sync_state_touch BEFORE UPDATE ON public.loop_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();