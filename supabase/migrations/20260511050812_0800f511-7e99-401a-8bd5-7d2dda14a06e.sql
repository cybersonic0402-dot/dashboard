CREATE POLICY "Allowed app users write data_cache"
ON public.data_cache
FOR ALL
TO authenticated
USING (
  lower(coalesce(auth.jwt() ->> 'email', '')) LIKE '%@zapply.nl'
  OR lower(coalesce(auth.jwt() ->> 'email', '')) LIKE '%@codestrokes.com'
)
WITH CHECK (
  lower(coalesce(auth.jwt() ->> 'email', '')) LIKE '%@zapply.nl'
  OR lower(coalesce(auth.jwt() ->> 'email', '')) LIKE '%@codestrokes.com'
);