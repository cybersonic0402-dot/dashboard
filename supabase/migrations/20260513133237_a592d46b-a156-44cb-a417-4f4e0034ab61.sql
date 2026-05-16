DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_roles'
      AND policyname = 'Admins can read roles'
  ) THEN
    CREATE POLICY "Admins can read roles"
    ON public.user_roles
    FOR SELECT
    TO authenticated
    USING (public.has_role(auth.uid(), 'admin'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_roles'
      AND policyname = 'Service role can manage roles'
  ) THEN
    CREATE POLICY "Service role can manage roles"
    ON public.user_roles
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $$;

INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::public.app_role
FROM auth.users
WHERE lower(email) IN (
  'divy@codestrokes.com',
  'mike@zapply.nl',
  'shubham@codestrokes.com',
  'finance@zapply.nl',
  'david@zapply.nl'
)
ON CONFLICT (user_id, role) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.loop_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_group_id uuid NOT NULL DEFAULT gen_random_uuid(),
  market text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  total_fetched integer NOT NULL DEFAULT 0,
  rows_upserted integer NOT NULL DEFAULT 0,
  pages_fetched integer NOT NULL DEFAULT 0,
  outcome text NOT NULL DEFAULT 'running',
  last_error text,
  per_status jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS loop_sync_runs_market_started_at_idx
ON public.loop_sync_runs (market, started_at DESC);

CREATE INDEX IF NOT EXISTS loop_sync_runs_run_group_id_idx
ON public.loop_sync_runs (run_group_id);

ALTER TABLE public.loop_sync_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'loop_sync_runs'
      AND policyname = 'Admins can read loop sync runs'
  ) THEN
    CREATE POLICY "Admins can read loop sync runs"
    ON public.loop_sync_runs
    FOR SELECT
    TO authenticated
    USING (public.has_role(auth.uid(), 'admin'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'loop_sync_runs'
      AND policyname = 'Service role can manage loop sync runs'
  ) THEN
    CREATE POLICY "Service role can manage loop sync runs"
    ON public.loop_sync_runs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.loop_sync_errors (
  market text NOT NULL,
  status text NOT NULL,
  last_error text,
  retry_count integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (market, status)
);

CREATE INDEX IF NOT EXISTS loop_sync_errors_last_seen_at_idx
ON public.loop_sync_errors (last_seen_at DESC);

ALTER TABLE public.loop_sync_errors ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'loop_sync_errors'
      AND policyname = 'Admins can read loop sync errors'
  ) THEN
    CREATE POLICY "Admins can read loop sync errors"
    ON public.loop_sync_errors
    FOR SELECT
    TO authenticated
    USING (public.has_role(auth.uid(), 'admin'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'loop_sync_errors'
      AND policyname = 'Service role can manage loop sync errors'
  ) THEN
    CREATE POLICY "Service role can manage loop sync errors"
    ON public.loop_sync_errors
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $$;

ALTER TABLE public.loop_sync_state
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'loop_sync_state'
      AND policyname = 'loop_sync_state service can manage'
  ) THEN
    CREATE POLICY "loop_sync_state service can manage"
    ON public.loop_sync_state
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
  END IF;
END $$;