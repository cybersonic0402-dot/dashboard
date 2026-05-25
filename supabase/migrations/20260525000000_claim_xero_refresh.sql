-- claim_xero_refresh: cross-instance lock that prevents concurrent serverless
-- invocations from refreshing the same Xero refresh_token in parallel. Xero
-- treats simultaneous use of one refresh_token as token-reuse abuse and
-- revokes the entire token family, forcing a full re-auth.
--
-- Callers expect: rpc("claim_xero_refresh", { lock_ttl_seconds: 30 })
-- Returns true  → caller won the lock and should refresh.
-- Returns false → another invocation holds the lock; caller should wait
--                 (see useNewerXeroTokenIfAvailable in fetchers.server.ts).
--
-- The lock is stored as `metadata.refresh_lock_at` on the xero integrations
-- row. It is released by the refresh-success path which writes
-- `refresh_lock_at: null` into metadata, or auto-expires after lock_ttl_seconds.

CREATE OR REPLACE FUNCTION public.claim_xero_refresh(lock_ttl_seconds integer DEFAULT 30)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _now timestamptz := NOW();
  _claimed boolean := false;
BEGIN
  -- Atomic compare-and-set: only the first caller within the TTL window
  -- gets the UPDATE to match a row. Postgres serializes concurrent UPDATEs
  -- on the same row, so exactly one of N racing callers sees a row affected.
  UPDATE public.integrations
     SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{refresh_lock_at}',
           to_jsonb(_now::text)
         ),
         updated_at = _now
   WHERE provider = 'xero'
     AND (
       metadata->>'refresh_lock_at' IS NULL
       OR (metadata->>'refresh_lock_at')::timestamptz
            < _now - make_interval(secs => GREATEST(lock_ttl_seconds, 1))
     )
   RETURNING true INTO _claimed;

  RETURN COALESCE(_claimed, false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_xero_refresh(integer) TO service_role, authenticated;
