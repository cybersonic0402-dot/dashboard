DELETE FROM public.data_cache
WHERE provider = 'shopify'
  AND cache_key = 'repeat_funnel';