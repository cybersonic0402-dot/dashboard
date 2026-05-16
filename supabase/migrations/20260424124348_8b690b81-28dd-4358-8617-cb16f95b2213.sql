DELETE FROM public.integrations a USING public.integrations b WHERE a.provider = b.provider AND a.id < b.id;
ALTER TABLE public.integrations ADD CONSTRAINT integrations_provider_key UNIQUE (provider);