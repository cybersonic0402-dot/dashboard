// Persistent Shopify order sync.
//
// Stores EVERY order from NL/UK/US into `public.shopify_orders` so dashboards
// can compute true all-time aggregates instead of being limited to a 5-year
// or 40-page fetch window.
//
// Strategy
//   - Per store we keep a row in `shopify_sync_state` with the highest
//     `updated_at` we've ingested so far + a backfill cursor.
//   - Each invocation pages forward through Shopify GraphQL Admin
//     (sortKey: UPDATED_AT, ascending) starting from `last_updated_at`.
//   - We upsert into `shopify_orders` in batches of 250 (page size).
//   - When `hasNextPage` is false the store is marked `backfill_complete`.
//   - Subsequent nightly runs fetch only the new updated_at delta.
//
// A single invocation intentionally processes a small chunk per store so the
// public HTTP endpoint returns before the platform/request client times out.
// Re-run the endpoint until every store returns `hasMore: false`.

import { createClient } from "@supabase/supabase-js";
import {
  fetchJuoRaw,
  fetchLoopRaw,
  SHOPIFY_API_VERSION,
} from "./fetchers.server";

const PAGE_SIZE = 250;
const DEFAULT_MAX_PAGES_PER_STORE = 1; // 250 orders/store/call; safe for manual Postman runs

const STORES = [
  { code: "NL", storeKey: "SHOPIFY_NL_STORE" },
  { code: "UK", storeKey: "SHOPIFY_UK_STORE" },
  { code: "US", storeKey: "SHOPIFY_US_STORE" },
] as const;

function adminClient() {
  const url = process.env.SUPABASE_URL || (import.meta as any).env?.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase admin creds missing for order sync");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function getShopifyToken(store: string): Promise<string | null> {
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret || !store) return null;

  const sb = adminClient();
  const provider = `shopify_${store.replace(".myshopify.com", "")}`;
  const { data: row } = await sb
    .from("integrations")
    .select("access_token, expires_at")
    .eq("provider", provider)
    .maybeSingle();
  if (row?.access_token) {
    const expires = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    if (!expires || expires > Date.now() + 60_000) return row.access_token as string;
  }

  // Mint a new token via Shopify OAuth client_credentials.
  try {
    const res = await fetch(`https://${store}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    if (!json.access_token) return null;
    await sb.from("integrations").upsert(
      {
        provider,
        access_token: json.access_token,
        refresh_token: null,
        expires_at: json.expires_in
          ? new Date(Date.now() + Number(json.expires_in) * 1000).toISOString()
          : null,
        updated_at: new Date().toISOString(),
        metadata: { shop_domain: store, source: "order-sync" },
      },
      { onConflict: "provider" },
    );
    return json.access_token as string;
  } catch (err: any) {
    console.error(`order-sync token ${store}:`, err?.message);
    return null;
  }
}

const ORDERS_GQL = (since: string, cursor: string | null) => `{
  orders(first:${PAGE_SIZE}, sortKey:UPDATED_AT, reverse:false, ${cursor ? `after:"${cursor}",` : ""}query:"updated_at:>='${since}'") {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id
      name
      createdAt
      updatedAt
      processedAt
      displayFinancialStatus
      displayFulfillmentStatus
      currencyCode
      totalPriceSet      { shopMoney { amount currencyCode } }
      subtotalPriceSet   { shopMoney { amount } }
      totalRefundedSet   { shopMoney { amount } }
      totalDiscountsSet  { shopMoney { amount } }
      totalTaxSet        { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      customer { id numberOfOrders }
    }}
  }
}`;

function toNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function parseOrderNumber(name: string | null | undefined): number | null {
  if (!name) return null;
  const m = /(\d+)/.exec(String(name));
  return m ? Number(m[1]) : null;
}

interface StoreSyncResult {
  store: string;
  storeCode: string;
  pages: number;
  upserts: number;
  hasMore: boolean;
  lastUpdatedAt: string | null;
  backfillComplete: boolean;
  error?: string;
}

async function syncStore(
  sb: ReturnType<typeof adminClient>,
  storeCode: string,
  store: string,
  maxPages: number,
): Promise<StoreSyncResult> {
  const result: StoreSyncResult = {
    store,
    storeCode,
    pages: 0,
    upserts: 0,
    hasMore: false,
    lastUpdatedAt: null,
    backfillComplete: false,
  };

  const token = await getShopifyToken(store);
  if (!token) {
    result.error = "no shopify token";
    return result;
  }

  // Read state — start from epoch on first run.
  const { data: state } = await sb
    .from("shopify_sync_state")
    .select("last_updated_at, backfill_complete, total_orders")
    .eq("store_code", storeCode)
    .maybeSingle();
  const since = state?.last_updated_at
    ? new Date(state.last_updated_at).toISOString()
    : "2018-01-01T00:00:00Z";
  let totalOrders = state?.total_orders ?? 0;

  let cursor: string | null = null;
  let hasNextPage = true;
  let highestUpdated = state?.last_updated_at ?? null;

  try {
    while (hasNextPage && result.pages < maxPages) {
      const res = await fetch(
        `https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: ORDERS_GQL(since, cursor) }),
        },
      );
      if (!res.ok) {
        result.error = `shopify http ${res.status}`;
        break;
      }
      const json: any = await res.json();
      if (json.errors) {
        result.error = json.errors[0]?.message ?? "graphql error";
        break;
      }
      const page = json.data?.orders ?? {};
      const edges: any[] = page.edges ?? [];
      hasNextPage = page.pageInfo?.hasNextPage ?? false;
      cursor = page.pageInfo?.endCursor ?? null;
      result.pages++;

      if (edges.length === 0) break;

      const rows = edges.map(({ node: o }) => {
        if (!highestUpdated || o.updatedAt > highestUpdated) highestUpdated = o.updatedAt;
        return {
          id: o.id,
          store_code: storeCode,
          shop_domain: store,
          order_number: parseOrderNumber(o.name),
          customer_id: o.customer?.id ?? null,
          customer_lifetime_orders: o.customer?.numberOfOrders
            ? Number(o.customer.numberOfOrders)
            : null,
          financial_status: o.displayFinancialStatus ?? null,
          fulfillment_status: o.displayFulfillmentStatus ?? null,
          currency: o.totalPriceSet?.shopMoney?.currencyCode ?? o.currencyCode ?? null,
          total_price: toNum(o.totalPriceSet?.shopMoney?.amount),
          subtotal_price: toNum(o.subtotalPriceSet?.shopMoney?.amount),
          total_refunded: toNum(o.totalRefundedSet?.shopMoney?.amount),
          total_discounts: toNum(o.totalDiscountsSet?.shopMoney?.amount),
          total_tax: toNum(o.totalTaxSet?.shopMoney?.amount),
          total_shipping: toNum(o.totalShippingPriceSet?.shopMoney?.amount),
          processed_at: o.processedAt ?? null,
          shopify_created_at: o.createdAt,
          shopify_updated_at: o.updatedAt,
          raw: o,
          synced_at: new Date().toISOString(),
        };
      });

      const { error: upsertErr, count } = await sb
        .from("shopify_orders")
        .upsert(rows, { onConflict: "id", count: "estimated" });
      if (upsertErr) {
        result.error = `upsert: ${upsertErr.message}`;
        break;
      }
      result.upserts += rows.length;
      totalOrders = (state?.total_orders ?? 0) + result.upserts;
    }

    result.hasMore = hasNextPage;
    result.lastUpdatedAt = highestUpdated;
    result.backfillComplete = !hasNextPage;

    // Persist state.
    await sb.from("shopify_sync_state").upsert(
      {
        store_code: storeCode,
        shop_domain: store,
        last_updated_at: highestUpdated,
        last_cursor: cursor,
        backfill_complete: result.backfillComplete || (state?.backfill_complete ?? false),
        total_orders: totalOrders,
        last_run_at: new Date().toISOString(),
        last_run_status: result.error ? "error" : "ok",
        last_run_message: result.error
          ? result.error
          : `${result.upserts} orders in ${result.pages} pages` +
            (result.hasMore ? " (more pending)" : " (caught up)"),
      },
      { onConflict: "store_code" },
    );
  } catch (err: any) {
    result.error = err?.message ?? String(err);
    await sb.from("shopify_sync_state").upsert(
      {
        store_code: storeCode,
        shop_domain: store,
        last_run_at: new Date().toISOString(),
        last_run_status: "error",
        last_run_message: result.error,
      },
      { onConflict: "store_code" },
    );
  }

  return result;
}

export async function syncAllShopifyOrders(maxPagesPerStore = DEFAULT_MAX_PAGES_PER_STORE): Promise<StoreSyncResult[]> {
  const sb = adminClient();
  const maxPages = Math.max(1, Math.min(10, Math.floor(maxPagesPerStore)));
  return Promise.all(STORES.map(async ({ code, storeKey }) => {
    const store = process.env[storeKey];
    if (!store) {
      return {
        store: "(unset)",
        storeCode: code,
        pages: 0,
        upserts: 0,
        hasMore: false,
        lastUpdatedAt: null,
        backfillComplete: false,
        error: `env ${storeKey} not set`,
      };
    }
    return syncStore(sb, code, store, maxPages);
  }));
}

export async function snapshotSubscriptions(): Promise<{ provider: string; ok: boolean; message?: string }[]> {
  const sb = adminClient();
  const results: { provider: string; ok: boolean; message?: string }[] = [];

  for (const [provider, fetcher] of [
    ["loop", fetchLoopRaw],
    ["juo", fetchJuoRaw],
  ] as const) {
    try {
      const data = await fetcher();
      if (!data) {
        results.push({ provider, ok: false, message: "no data" });
        continue;
      }
      // Group by store_code if rows expose it, else single snapshot.
      const rows = Array.isArray(data) ? data : [data];
      const byStore = new Map<string, any[]>();
      for (const row of rows) {
        const r = row as any;
        const code = (r?.market ?? r?.store ?? r?.storeCode ?? "ALL") as string;
        if (!byStore.has(code)) byStore.set(code, []);
        byStore.get(code)!.push(row);
      }
      const takenAt = new Date().toISOString();
      const inserts = Array.from(byStore.entries()).map(([code, payload]) => ({
        provider,
        store_code: code,
        taken_at: takenAt,
        payload,
      }));
      const { error } = await sb.from("subscription_snapshots").insert(inserts);
      if (error) {
        results.push({ provider, ok: false, message: error.message });
      } else {
        results.push({ provider, ok: true, message: `${inserts.length} snapshots` });
      }
    } catch (err: any) {
      results.push({ provider, ok: false, message: err?.message ?? String(err) });
    }
  }
  return results;
}
