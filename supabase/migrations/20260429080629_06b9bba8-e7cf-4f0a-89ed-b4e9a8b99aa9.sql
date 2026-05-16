UPDATE data_cache AS target
SET payload = src.payload,
    fetched_at = src.fetched_at
FROM (
  SELECT payload, fetched_at
  FROM data_cache
  WHERE provider = 'triplewhale'
    AND cache_key LIKE 'summary_%'
    AND jsonb_typeof(payload) = 'array'
    AND jsonb_array_length(payload) > 0
  ORDER BY fetched_at DESC
  LIMIT 1
) AS src
WHERE target.provider = 'triplewhale'
  AND target.cache_key = 'summary'
  AND (target.payload->>'__empty' = 'true' OR target.payload->>'__error' = 'true');