-- Two tables to persist all Loop subscription data per market.
-- Top-level scalars are columns; nested objects/arrays kept losslessly in jsonb.
-- raw column holds the entire original API object so no field is ever lost.

CREATE TABLE IF NOT EXISTS public."UK_loop" (
  id bigint PRIMARY KEY,
  shopify_id bigint,
  origin_order_shopify_id bigint,
  created_at timestamptz,
  updated_at timestamptz,
  order_note text,
  total_line_item_price numeric,
  total_line_item_discounted_price numeric,
  delivery_price numeric,
  currency_code text,
  status text,
  cancellation_reason text,
  cancellation_comment text,
  completed_orders_count integer,
  paused_at timestamptz,
  cancelled_at timestamptz,
  is_prepaid boolean,
  is_marked_for_cancellation boolean,
  next_billing_date_epoch bigint,
  last_payment_status text,
  last_inventory_action text,
  delivery_method jsonb,
  billing_policy jsonb,
  delivery_policy jsonb,
  shipping_address jsonb,
  lines jsonb,
  attributes jsonb,
  raw jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public."US_loop" (
  id bigint PRIMARY KEY,
  shopify_id bigint,
  origin_order_shopify_id bigint,
  created_at timestamptz,
  updated_at timestamptz,
  order_note text,
  total_line_item_price numeric,
  total_line_item_discounted_price numeric,
  delivery_price numeric,
  currency_code text,
  status text,
  cancellation_reason text,
  cancellation_comment text,
  completed_orders_count integer,
  paused_at timestamptz,
  cancelled_at timestamptz,
  is_prepaid boolean,
  is_marked_for_cancellation boolean,
  next_billing_date_epoch bigint,
  last_payment_status text,
  last_inventory_action text,
  delivery_method jsonb,
  billing_policy jsonb,
  delivery_policy jsonb,
  shipping_address jsonb,
  lines jsonb,
  attributes jsonb,
  raw jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS uk_loop_status_idx       ON public."UK_loop" (status);
CREATE INDEX IF NOT EXISTS uk_loop_created_at_idx   ON public."UK_loop" (created_at);
CREATE INDEX IF NOT EXISTS uk_loop_cancelled_at_idx ON public."UK_loop" (cancelled_at);
CREATE INDEX IF NOT EXISTS us_loop_status_idx       ON public."US_loop" (status);
CREATE INDEX IF NOT EXISTS us_loop_created_at_idx   ON public."US_loop" (created_at);
CREATE INDEX IF NOT EXISTS us_loop_cancelled_at_idx ON public."US_loop" (cancelled_at);

ALTER TABLE public."UK_loop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."US_loop" ENABLE ROW LEVEL SECURITY;

-- Same policy shape as shopify_orders (sync-written tables in this project)
CREATE POLICY "Authenticated can read UK_loop" ON public."UK_loop"
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Sync can insert UK_loop" ON public."UK_loop"
  FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Sync can update UK_loop" ON public."UK_loop"
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Sync can read UK_loop for upsert" ON public."UK_loop"
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Authenticated can read US_loop" ON public."US_loop"
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Sync can insert US_loop" ON public."US_loop"
  FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Sync can update US_loop" ON public."US_loop"
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Sync can read US_loop for upsert" ON public."US_loop"
  FOR SELECT TO anon, authenticated USING (true);