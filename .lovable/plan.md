## Goal

Persist every Loop subscription (UK + US) into Supabase so the dashboard reads from the database instead of hitting Loop on every render. Juo stays as-is (live API, no DB).

## Database — 2 new tables

Create `public."UK_loop"` and `public."US_loop"` (quoted identifiers to preserve casing as requested).

Each table has one row per Loop subscription, with **all top-level scalar fields as real columns** and **all nested objects/arrays kept losslessly in a `raw jsonb` column** (so nothing is lost — `lines[]`, `attributes[]`, `discounts[]`, `shippingAddress`, `billingPolicy`, `deliveryPolicy`, `deliveryMethod`, etc. are queryable via JSONB).

Columns (same for both tables):

```
id                              bigint  PRIMARY KEY      -- Loop "id"
shopify_id                      bigint
origin_order_shopify_id         bigint
created_at                      timestamptz
updated_at                      timestamptz
order_note                      text
total_line_item_price           numeric
total_line_item_discounted_price numeric
delivery_price                  numeric
currency_code                   text
status                          text
cancellation_reason             text
cancellation_comment            text
completed_orders_count          integer
paused_at                       timestamptz
cancelled_at                    timestamptz
is_prepaid                      boolean
is_marked_for_cancellation      boolean
next_billing_date_epoch         bigint
last_payment_status             text
last_inventory_action           text
delivery_method                 jsonb         -- {code,title}
billing_policy                  jsonb         -- {interval,intervalCount,...}
delivery_policy                 jsonb         -- {interval,intervalCount}
shipping_address                jsonb         -- full address
lines                           jsonb         -- array of line items + discounts
attributes                      jsonb         -- array of {key,value}
raw                             jsonb  NOT NULL -- the entire original API object
synced_at                       timestamptz NOT NULL DEFAULT now()
```

Indexes: `(status)`, `(created_at)`, `(cancelled_at)`.

RLS: enable, with `authenticated` SELECT + `anon/authenticated` INSERT/UPDATE (same shape as `shopify_orders` in this project, which is the existing pattern for sync-written tables).

## Sync logic — Loop fetcher with full pagination + rate limiting

New file `src/server/loop-sync.server.ts`:

- One function `syncLoopStore(market: "UK" | "US", apiKey)` that:
  1. Iterates `status=ACTIVE` then `status=CANCELLED`, paging `pageNo=1..N` with `pageSize=100`.
  2. Stops when `pageInfo.hasNextPage === false` (no arbitrary `MAX_PAGES` cap).
  3. Enforces **2 requests per 3 seconds**: a small token-bucket / `await sleep(1500)` between each request (per market — each market has its own key/bucket so the two markets still run in parallel).
  4. On HTTP 429, exponential backoff (3s → 6s → 12s, max 3 retries) before giving up.
  5. Upserts each subscription into the correct table (`UK_loop` or `US_loop`) keyed on `id`, mapping scalars to columns and storing the full object in `raw`.
  6. Returns `{ inserted, updated, totalFetched }`.

Trigger surfaces (no new external endpoint required):
- Add a call in `src/routes/api.sync.ts` so the existing manual sync runs the Loop DB sync.
- Add it to the nightly job in `src/routes/api.public.nightly-sync.ts`.

## Dashboard reads from DB instead of API

- Add `fetchLoopFromDb()` in `src/server/fetchers.server.ts` that reads both tables and computes the same shape currently returned by `fetchLoopStore` (`mrr`, `activeSubs`, `newThisMonth`, `churnedThisMonth`, `arpu`, `churnRate`, `currency`, per market) — using SQL aggregates so it's instant.
- Replace `fetchLoopRaw` / `fetchLoopForRange` consumers to use the DB-backed version. Range filter becomes a simple `WHERE created_at`/`cancelled_at BETWEEN from AND to`.
- Juo path is **untouched** — keeps fetching live from the Juo API.

## Implementation order

1. `supabase--migration` to create both tables + RLS + indexes.
2. Wait for user to apply migration → types.ts regenerates.
3. Add `src/server/loop-sync.server.ts` (paginated + rate-limited writer).
4. Wire it into `api.sync.ts` and `api.public.nightly-sync.ts`.
5. Add `fetchLoopFromDb` and switch `FinanceDashboard` / range fetchers to read from DB.
6. Trigger one full sync, verify row counts in both tables match Loop totals.

## Notes / assumptions

- Table names use the exact casing you requested (`UK_loop`, `US_loop`); they will need to be quoted in every SQL query (`from('UK_loop')` works fine in the JS client). If you'd prefer the Postgres-friendly `loop_uk` / `loop_us`, say so and I'll switch.
- Loop's pagination cap per page is 100; with 2 req / 3s that's ~67 subs/sec per market — fine for the volumes this account has.
- Storing `raw jsonb` guarantees zero data loss even if Loop adds new fields later.