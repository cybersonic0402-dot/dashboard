
create table if not exists public.shopify_orders (
  id text primary key,
  store_code text not null,
  shop_domain text not null,
  order_number bigint,
  customer_id text,
  customer_lifetime_orders integer,
  financial_status text,
  fulfillment_status text,
  currency text,
  total_price numeric(14,2),
  subtotal_price numeric(14,2),
  total_refunded numeric(14,2),
  total_discounts numeric(14,2),
  total_tax numeric(14,2),
  total_shipping numeric(14,2),
  processed_at timestamptz,
  shopify_created_at timestamptz not null,
  shopify_updated_at timestamptz not null,
  raw jsonb,
  synced_at timestamptz not null default now()
);
create index if not exists shopify_orders_store_created_idx on public.shopify_orders (store_code, shopify_created_at desc);
create index if not exists shopify_orders_store_updated_idx on public.shopify_orders (store_code, shopify_updated_at);
create index if not exists shopify_orders_customer_idx on public.shopify_orders (customer_id);

alter table public.shopify_orders enable row level security;
create policy "Authenticated can read shopify_orders"
  on public.shopify_orders for select
  to authenticated
  using (true);

create table if not exists public.shopify_sync_state (
  store_code text primary key,
  shop_domain text not null,
  last_updated_at timestamptz,
  last_cursor text,
  backfill_complete boolean not null default false,
  total_orders integer not null default 0,
  last_run_at timestamptz,
  last_run_status text,
  last_run_message text,
  updated_at timestamptz not null default now()
);

alter table public.shopify_sync_state enable row level security;
create policy "Authenticated can read shopify_sync_state"
  on public.shopify_sync_state for select
  to authenticated
  using (true);

create trigger shopify_sync_state_touch
  before update on public.shopify_sync_state
  for each row execute function public.touch_updated_at();

create table if not exists public.subscription_snapshots (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  store_code text not null,
  taken_at timestamptz not null default now(),
  payload jsonb not null
);
create index if not exists subscription_snapshots_idx
  on public.subscription_snapshots (provider, store_code, taken_at desc);

alter table public.subscription_snapshots enable row level security;
create policy "Authenticated can read subscription_snapshots"
  on public.subscription_snapshots for select
  to authenticated
  using (true);
