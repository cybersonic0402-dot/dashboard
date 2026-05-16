/**
 * Server-side data fetchers — called directly from page.tsx (no internal HTTP round-trips).
 * Each fetcher returns null when the source is not configured or errors.
 */
import { createClient as createSupabaseJS } from "@supabase/supabase-js";
import { resolveSupabaseServiceKey, resolveSupabaseUrl } from "./supabase-env.server";

// ─── helpers ─────────────────────────────────────────────────────────────────

function startOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

// Service-role Supabase client — no cookies, works anywhere server-side.
// In the TanStack Worker runtime, process.env may not contain the Supabase
// keys, so we read VITE_* values via import.meta.env at MODULE TOP LEVEL.
// Vite inlines these as string literals at build time, so the Worker bundle
// always has them available regardless of runtime env injection.
// The integrations + data_cache tables have permissive RLS for this use case.
function serviceClient() {
  const url = resolveSupabaseUrl();
  const key = resolveSupabaseServiceKey();
  if (!url || !key) {
    throw new Error(`Supabase creds missing in fetchers (url=${!!url}, key=${!!key})`);
  }
  return createSupabaseJS(url, key, { auth: { persistSession: false } });
}

// ─── Shopify ─────────────────────────────────────────────────────────────────
//
// Uses Shopify OAuth2 client_credentials grant (no user redirect needed).
// Pin a single explicit Admin API version. 2025-01 reaches end-of-life Jan 2026
// and Shopify silently forwards stale callers to the latest stable schema —
// pin to current to avoid silent field drops.
export const SHOPIFY_API_VERSION = "2026-01" as const;
// Requires: SHOPIFY_APP_CLIENT_ID + SHOPIFY_APP_CLIENT_SECRET in .env.local
//           App must be installed in each store (done in Shopify Partner Dashboard).
// Tokens (~24h TTL) are cached in Supabase integrations table and auto-refreshed.
//
// Confirmed working on all 4 stores: zapply-nl, zapplyde, zapply-usa, zapplygermany

const SHOPIFY_STORES = [
  { code: "NL", flag: "🇳🇱", name: "Netherlands", storeKey: "SHOPIFY_NL_STORE" },
  { code: "UK", flag: "🇬🇧", name: "United Kingdom", storeKey: "SHOPIFY_UK_STORE" },
  {
    code: "US",
    flag: "🇺🇸",
    name: "United States",
    storeKey: "SHOPIFY_US_STORE",
    status: "scaling",
  },
  
] as const;

async function getShopifyToken(store: string): Promise<string | null> {
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret || !store) return null;

  const provider = `shopify_${store.replace(".myshopify.com", "")}`;

  // 1. Use cached token from Supabase if still valid (with 10-min buffer)
  try {
    const supabase = serviceClient();
    const { data } = await supabase
      .from("integrations")
      .select("access_token, expires_at, metadata")
      .eq("provider", provider)
      .single();

    if (data?.access_token) {
      const expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : Infinity;
      const scopes = String((data.metadata as any)?.scopes ?? "");
      if (expiresAt > Date.now() + 10 * 60 * 1000 && scopes.includes("read_all_orders")) {
        return data.access_token;
      }
    }
  } catch {
    // Supabase unavailable — fall through to fresh grant
  }

  // 2. Client credentials grant — no redirect needed, app must be installed in store
  try {
    const res = await fetch(`https://${store}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`Shopify client_credentials ${store} ${res.status}:`, body.slice(0, 200));
      return null;
    }

    const { access_token, expires_in } = await res.json();
    if (!access_token) return null;

    // 3. Cache the fresh token in Supabase
    const expiresAt = new Date(Date.now() + ((expires_in ?? 86400) - 600) * 1000).toISOString();
    await serviceClient()
      .from("integrations")
      .upsert(
        {
          provider,
          access_token,
          expires_at: expiresAt,
          updated_at: new Date().toISOString(),
          metadata: { shop_domain: store, source: "client_credentials", scopes: "read_orders,read_all_orders" },
        },
        { onConflict: "provider" },
      );

    return access_token;
  } catch (err: any) {
    console.error(`Shopify token refresh ${store}:`, err.message);
    return null;
  }
}

// Paginated GQL — one page, with optional cursor for subsequent pages
const SHOPIFY_GQL_PAGE = (since: string, cursor: string | null, until?: string | null) => `{
  orders(first:250, sortKey:CREATED_AT, reverse:false, ${cursor ? `after:"${cursor}",` : ""}query:"created_at:>=${since}${until ? ` created_at:<=${until}` : ""} financial_status:paid") {
    pageInfo { hasNextPage endCursor }
    edges { node {
      totalPriceSet    { shopMoney { amount currencyCode } }
      totalDiscountsSet{ shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      createdAt
      customer { id numberOfOrders }
    }}
  }
}`;

// Aggregate all orders for a store using cursor pagination (max 40 pages = 10,000 orders)
async function fetchShopifyAllOrders(
  store: string,
  token: string,
  since: string,
  maxPages = 40,
  until?: string | null,
) {
  let revenue = 0,
    refunds = 0,
    discounts = 0,
    orderCount = 0,
    currency = "EUR";
  const customerIds = new Set<string>();
  const monthlySums: Record<string, { revenue: number; orders: number; refunds: number }> = {};
  let cursor: string | null = null;
  let hasNextPage = true;
  let page = 0;

  while (hasNextPage && page < maxPages) {
    const res: Response = await fetch(`https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: SHOPIFY_GQL_PAGE(since, cursor, until) }),
    });
    if (!res.ok) break;
    const json = await res.json();
    if (json.errors) {
      console.error("Shopify GQL:", json.errors[0]?.message);
      break;
    }

    const page_data = json.data?.orders ?? {};
    const edges: any[] = page_data.edges ?? [];
    hasNextPage = page_data.pageInfo?.hasNextPage ?? false;
    cursor = page_data.pageInfo?.endCursor ?? null;
    page++;

    for (const { node: o } of edges) {
      const r = parseFloat(o.totalPriceSet.shopMoney.amount);
      const rf = parseFloat(o.totalRefundedSet.shopMoney.amount);
      const dc = parseFloat(o.totalDiscountsSet.shopMoney.amount);
      // Shopify "Total sales" = orders − returns. Subtract refunds from revenue
      // so our number aligns with the figure shown in Shopify Analytics.
      const net = r - rf;
      revenue += net;
      refunds += rf;
      discounts += dc;
      orderCount++;
      currency = o.totalPriceSet.shopMoney.currencyCode;
      if (o.customer?.id) customerIds.add(o.customer.id);
      const mk = new Date(o.createdAt)
        .toLocaleDateString("en-US", { month: "short", year: "2-digit" })
        .replace(" ", " '");
      if (!monthlySums[mk]) monthlySums[mk] = { revenue: 0, orders: 0, refunds: 0 };
      monthlySums[mk].revenue += net;
      monthlySums[mk].refunds += rf;
      monthlySums[mk].orders += 1;
    }
  }

  return {
    revenue,
    refunds,
    discounts,
    orderCount,
    currency,
    uniqueCustomers: customerIds.size,
    monthlySums,
    truncated: hasNextPage,
  };
}

export async function fetchShopifyMarkets(fromDate?: string, toDate?: string) {
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
  if (!clientId) return null;

  const since = `${fromDate ?? startOfMonth()}T00:00:00Z`;
  const until = toDate ? `${toDate}T23:59:59Z` : null; // passed into GQL query filter

  const results = await Promise.all(
    SHOPIFY_STORES.map(async ({ code, flag, name, storeKey, status }: any) => {
      const store = process.env[storeKey];
      if (!store) return { code, flag, name, status: status ?? null, live: false };

      const token = await getShopifyToken(store);
      if (!token) return { code, flag, name, status: status ?? null, live: false };

      try {
        const agg = await fetchShopifyAllOrders(store, token, since, 180, until);
        const { revenue, refunds, discounts, orderCount, currency, uniqueCustomers, truncated } =
          agg;
        const aov = orderCount > 0 ? revenue / orderCount : 0;
        if (truncated) console.warn(`Shopify ${code}: revenue capped at 180 pages (45,000 orders)`);
        // Convert to EUR for cross-store aggregation. Keep native values too.
        const fxRate = await getEurRate(
          currency,
          since.slice(0, 10),
          (until ?? new Date().toISOString()).slice(0, 10),
        );
        const revenueEUR = +(revenue * fxRate).toFixed(2);
        const refundsEUR = +(refunds * fxRate).toFixed(2);
        return {
          code,
          flag,
          name,
          revenue: revenueEUR,
          refunds: refundsEUR,
          discounts,
          revenueNative: revenue,
          refundsNative: refunds,
          orders: orderCount,
          aov,
          currency,
          fxRate,
          newCustomers: uniqueCustomers,
          truncated,
          status: status ?? null,
          live: true,
        };
      } catch (err: any) {
        console.error(`Shopify ${code} fetch failed:`, err.message);
        return { code, flag, name, status: status ?? null, live: false, error: err.message };
      }
    }),
  );

  const hasAnyLive = results.some((r: any) => r.live);
  return hasAnyLive ? results : null;
}

// Today's orders per market, bucketed by hour (Amsterdam time = UTC+2)
export async function fetchShopifyToday() {
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
  if (!clientId) return null;

  const todayStart = `${today()}T00:00:00Z`;

  const markets = await Promise.all(
    SHOPIFY_STORES.map(async ({ code, flag, name, storeKey, status }: any) => {
      const store = process.env[storeKey];
      if (!store) return { code, flag, name, live: false };
      const token = await getShopifyToken(store);
      if (!token) return { code, flag, name, live: false };

      try {
        let revenue = 0,
          refunds = 0,
          orders = 0;
        let currency = "EUR";
        const hourlyRev: number[] = Array(24).fill(0);
        const hourlyOrd: number[] = Array(24).fill(0);
        let cursor: string | null = null;
        let hasNextPage = true;
        let page = 0;

        while (hasNextPage && page < 5) {
          const res: Response = await fetch(`https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
            body: JSON.stringify({ query: SHOPIFY_GQL_PAGE(todayStart, cursor) }),
            cache: "no-store",
          });
          if (!res.ok) break;
          const json = await res.json();
          if (json.errors) break;
          const page_data = json.data?.orders ?? {};
          const edges: any[] = page_data.edges ?? [];
          hasNextPage = page_data.pageInfo?.hasNextPage ?? false;
          cursor = page_data.pageInfo?.endCursor ?? null;
          page++;

          for (const { node: o } of edges) {
            const r = parseFloat(o.totalPriceSet.shopMoney.amount);
            const rf = parseFloat(o.totalRefundedSet.shopMoney.amount);
            // Net of refunds — matches Shopify Analytics "Total sales".
            const net = r - rf;
            revenue += net;
            refunds += rf;
            orders++;
            currency = o.totalPriceSet.shopMoney.currencyCode;
            // Amsterdam = UTC+2 (CEST, valid Apr-Oct)
            const hour = (new Date(o.createdAt).getUTCHours() + 2) % 24;
            hourlyRev[hour] += net;
            hourlyOrd[hour]++;
          }
        }

        const hourly = hourlyRev.map((rev, h) => ({
          hour: h,
          revenue: +rev.toFixed(2),
          orders: hourlyOrd[h],
        }));
        const fxRate = await getEurRate(currency, today(), today());
        const revenueEUR = +(revenue * fxRate).toFixed(2);
        const refundsEUR = +(refunds * fxRate).toFixed(2);
        return {
          code,
          flag,
          name,
          revenue: revenueEUR,
          refunds: refundsEUR,
          revenueNative: +revenue.toFixed(2),
          refundsNative: +refunds.toFixed(2),
          orders,
          aov: orders > 0 ? +(revenueEUR / orders).toFixed(2) : 0,
          currency,
          fxRate,
          hourly,
          live: true,
        };
      } catch (err: any) {
        console.error(`Shopify today ${code}:`, err.message);
        return { code, flag, name, live: false };
      }
    }),
  );

  return markets.some((m: any) => m.live) ? { markets, fetchedAt: new Date().toISOString() } : null;
}

// Last 6 months of order aggregates — all Shopify stores, converted to EUR.
export async function fetchShopifyMonthly() {
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
  if (!clientId) return null;

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const since = `${sixMonthsAgo.toISOString().split("T")[0]}T00:00:00Z`;
  const sinceDay = since.slice(0, 10);

  try {
    const perStore = await Promise.all(
      SHOPIFY_STORES.map(async ({ code, storeKey }: any) => {
        const store = process.env[storeKey];
        if (!store)
          return {
            code,
            monthlySums: {} as Record<string, { revenue: number; orders: number; refunds: number }>,
          };
        const token = await getShopifyToken(store);
        if (!token) return { code, monthlySums: {} };
        const { monthlySums, truncated } = await fetchShopifyAllOrders(store, token, since, 240);
        if (truncated) console.warn(`Shopify monthly ${code}: capped at 240 pages (60,000 orders)`);
        return { code, monthlySums };
      }),
    );

    const merged: Record<
      string,
      {
        revenue: number;
        orders: number;
        refunds: number;
        byMarket: Record<string, { revenue: number; orders: number; refunds: number }>;
      }
    > = {};
    for (const storeRow of perStore) {
      for (const [month, row] of Object.entries(
        storeRow.monthlySums as Record<
          string,
          { revenue: number; orders: number; refunds: number }
        >,
      )) {
        if (!merged[month]) merged[month] = { revenue: 0, orders: 0, refunds: 0, byMarket: {} };
        const endDay = new Date(`1 ${month.replace("'", "20")}`);
        endDay.setMonth(endDay.getMonth() + 1, 0);
        const sourceCurrency = MARKET_CURRENCY[storeRow.code] ?? "EUR";
        const fxRate = await getEurRate(
          sourceCurrency,
          sinceDay,
          endDay.toISOString().split("T")[0],
        );
        const revenue = +(row.revenue * fxRate).toFixed(2);
        const refunds = +(row.refunds * fxRate).toFixed(2);
        merged[month].revenue += revenue;
        merged[month].orders += row.orders;
        merged[month].refunds += refunds;
        merged[month].byMarket[storeRow.code] = { revenue, orders: row.orders, refunds };
      }
    }

    return Object.entries(merged)
      .sort(
        ([a], [b]) =>
          new Date("1 " + a.replace("'", "20")).getTime() -
          new Date("1 " + b.replace("'", "20")).getTime(),
      )
      .map(([month, data]) => ({ month, ...data, calcVersion: 2 }));
  } catch {
    return null;
  }
}

// Fetch Shopify per-market monthly + daily revenue for a specific calendar year.
// Used by the Growth Plan year selector — runs on demand (not cached) so any
// year (including older years) can be inspected.
export async function fetchShopifyGrowthYear(year: number) {
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
  if (!clientId) return null;

  const sinceDay = `${year}-01-01`;
  const untilDay = `${year}-12-31`;
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const lastActualMonthIdx = year === currentYear ? now.getUTCMonth() : 11;
  const monthIndices = Array.from({ length: lastActualMonthIdx + 1 }, (_, i) => i);

  const mapWithConcurrency = async <T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ) => {
    const results: R[] = [];
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        results[current] = await fn(items[current]);
      }
    });
    await Promise.all(workers);
    return results;
  };

  const monthWindow = (monthIdx: number) => {
    const month = String(monthIdx + 1).padStart(2, "0");
    const endDay = String(new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate()).padStart(2, "0");
    return {
      since: `${year}-${month}-01T00:00:00Z`,
      until: `${year}-${month}-${endDay}T23:59:59Z`,
    };
  };

  try {
    const perStore = await Promise.all(
      SHOPIFY_STORES.map(async ({ code, storeKey }: any) => {
        const store = process.env[storeKey];
        if (!store) return { code, monthlySums: {}, dailySums: {} };
        const token = await getShopifyToken(store);
        if (!token) return { code, monthlySums: {}, dailySums: {} };

        const monthResults = await mapWithConcurrency(monthIndices, 1, async (monthIdx) => {
          const { since, until } = monthWindow(monthIdx);
          const monthlySums: Record<string, { revenue: number; orders: number; refunds: number }> = {};
          const dailySums: Record<string, { revenue: number; orders: number }> = {};
          let cursor: string | null = null;
          let hasNextPage = true;
          let page = 0;
          const maxPages = 120;

          while (hasNextPage && page < maxPages) {
            // Throttle-aware fetch with up to 4 retries on 429 / GQL THROTTLED errors
            let res: Response | null = null;
            let json: any = null;
            let attempt = 0;
            while (attempt < 5) {
              res = await fetch(`https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
                method: "POST",
                headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
                body: JSON.stringify({ query: SHOPIFY_GQL_PAGE(since, cursor, until) }),
                cache: "no-store",
              });
              if (res.status === 429 || res.status === 502 || res.status === 503) {
                const wait = Math.min(8000, 500 * Math.pow(2, attempt));
                await new Promise((r) => setTimeout(r, wait));
                attempt++;
                continue;
              }
              if (!res.ok) break;
              json = await res.json();
              const throttled =
                json?.errors?.[0]?.extensions?.code === "THROTTLED" ||
                /throttle/i.test(json?.errors?.[0]?.message ?? "");
              if (throttled) {
                const wait = Math.min(8000, 500 * Math.pow(2, attempt));
                await new Promise((r) => setTimeout(r, wait));
                attempt++;
                json = null;
                continue;
              }
              break;
            }
            if (!res || !res.ok || !json) {
              console.warn(
                `Shopify growth-month ${year}-${monthIdx + 1} ${code}: gave up after ${attempt} retries (status=${res?.status})`,
              );
              break;
            }
            if (json.errors) {
              console.error(`Shopify growth-month ${year}-${monthIdx + 1} ${code}:`, json.errors[0]?.message);
              break;
            }
            const pageData = json.data?.orders ?? {};
            const edges: any[] = pageData.edges ?? [];
            hasNextPage = pageData.pageInfo?.hasNextPage ?? false;
            cursor = pageData.pageInfo?.endCursor ?? null;
            page++;

            for (const { node: o } of edges) {
              const r = parseFloat(o.totalPriceSet.shopMoney.amount);
              const rf = parseFloat(o.totalRefundedSet.shopMoney.amount);
              const net = r - rf;
              const created = new Date(o.createdAt);
              const mk = created
                .toLocaleDateString("en-US", { month: "short", year: "2-digit" })
                .replace(" ", " '");
              if (!monthlySums[mk]) monthlySums[mk] = { revenue: 0, orders: 0, refunds: 0 };
              monthlySums[mk].revenue += net;
              monthlySums[mk].refunds += rf;
              monthlySums[mk].orders += 1;
              const dayKey = amsterdamDateKey(o.createdAt);
              if (!dailySums[dayKey]) dailySums[dayKey] = { revenue: 0, orders: 0 };
              dailySums[dayKey].revenue += net;
              dailySums[dayKey].orders += 1;
            }
          }

          if (hasNextPage) {
            console.warn(`Shopify growth-month ${year}-${monthIdx + 1} ${code}: capped at ${maxPages} pages`);
          }
          return { monthlySums, dailySums };
        });

        const monthlySums: Record<string, { revenue: number; orders: number; refunds: number }> = {};
        const dailySums: Record<string, { revenue: number; orders: number }> = {};
        for (const result of monthResults) {
          for (const [k, v] of Object.entries(result.monthlySums)) {
            if (!monthlySums[k]) monthlySums[k] = { revenue: 0, orders: 0, refunds: 0 };
            monthlySums[k].revenue += v.revenue;
            monthlySums[k].refunds += v.refunds;
            monthlySums[k].orders += v.orders;
          }
          for (const [k, v] of Object.entries(result.dailySums)) {
            if (!dailySums[k]) dailySums[k] = { revenue: 0, orders: 0 };
            dailySums[k].revenue += v.revenue;
            dailySums[k].orders += v.orders;
          }
        }

        const sourceCurrency = MARKET_CURRENCY[code] ?? "EUR";
        const fxRate = await getEurRate(sourceCurrency, sinceDay, untilDay);
        const monthlyEur: Record<string, { revenue: number; orders: number; refunds: number }> = {};
        for (const [k, v] of Object.entries(monthlySums)) {
          monthlyEur[k] = {
            revenue: +(v.revenue * fxRate).toFixed(2),
            orders: v.orders,
            refunds: +(v.refunds * fxRate).toFixed(2),
          };
        }
        const dailyEur: Record<string, { revenue: number; orders: number }> = {};
        for (const [k, v] of Object.entries(dailySums)) {
          dailyEur[k] = { revenue: +(v.revenue * fxRate).toFixed(2), orders: v.orders };
        }
        return { code, monthlySums: monthlyEur, dailySums: dailyEur };
      }),
    );

    // Build shopifyMonthly-shaped rows and shopifyDaily.byMarket
    const merged: Record<
      string,
      {
        revenue: number;
        orders: number;
        refunds: number;
        byMarket: Record<string, { revenue: number; orders: number; refunds: number }>;
      }
    > = {};
    for (const storeRow of perStore) {
      for (const [month, row] of Object.entries(storeRow.monthlySums)) {
        if (!merged[month]) merged[month] = { revenue: 0, orders: 0, refunds: 0, byMarket: {} };
        merged[month].revenue += row.revenue;
        merged[month].orders += row.orders;
        merged[month].refunds += row.refunds;
        merged[month].byMarket[storeRow.code] = row;
      }
    }
    const shopifyMonthly = Object.entries(merged)
      .sort(
        ([a], [b]) =>
          new Date("1 " + a.replace("'", "20")).getTime() -
          new Date("1 " + b.replace("'", "20")).getTime(),
      )
      .map(([month, d]) => ({ month, ...d, calcVersion: 2 }));

    const dailyByMarket: Record<string, Record<string, { revenue: number; orders: number }>> = {};
    const mergedDaily: Record<string, { revenue: number; orders: number }> = {};
    for (const s of perStore) {
      dailyByMarket[s.code] = s.dailySums;
      for (const [k, v] of Object.entries(s.dailySums)) {
        if (!mergedDaily[k]) mergedDaily[k] = { revenue: 0, orders: 0 };
        mergedDaily[k].revenue += v.revenue;
        mergedDaily[k].orders += v.orders;
      }
    }

    const returnedMonths = new Set(shopifyMonthly.map((m: any) => m.month));
    const expectedMonths = Array.from({ length: lastActualMonthIdx + 1 }, (_, i) =>
      new Date(Date.UTC(year, i, 1)).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).replace(" ", " '")
    );
    const missingActualMonths = expectedMonths.filter((m) => !returnedMonths.has(m));

    if (missingActualMonths.length > 0) {
      const fallbackRows = await fetchTripleWhaleGrowthMonths(year, missingActualMonths);
      for (const row of fallbackRows) {
        if (!returnedMonths.has(row.month)) {
          shopifyMonthly.push(row);
          returnedMonths.add(row.month);
        }
      }
      shopifyMonthly.sort(
        (a: any, b: any) =>
          new Date("1 " + a.month.replace("'", "20")).getTime() -
          new Date("1 " + b.month.replace("'", "20")).getTime(),
      );
    }

    const dailyDates = Object.keys(mergedDaily).sort();
    const finalReturnedMonths = shopifyMonthly.map((m: any) => m.month);

    return {
      year,
      shopifyMonthly,
      shopifyDaily: {
        daily: mergedDaily,
        byMarket: dailyByMarket,
        calcVersion: 2,
        fetchedAt: new Date().toISOString(),
      },
      coverage: {
        dataStart: dailyDates[0] ?? null,
        dataEnd: dailyDates.at(-1) ?? null,
        returnedMonths: finalReturnedMonths,
        missingMonths: expectedMonths.filter((m) => !finalReturnedMonths.includes(m)),
      },
    };
  } catch (err: any) {
    console.error(`fetchShopifyGrowthYear ${year} failed:`, err?.message);
    return null;
  }
}

// ─── Triple Whale ─────────────────────────────────────────────────────────────
//
// CONFIRMED WORKING — POST https://api.triplewhale.com/api/v2/summary-page/get-data
// Returns 698 metrics; all IDs below verified from live API response April 2026.

const TW_SHOPS = [
  { market: "NL", flag: "🇳🇱", envKeys: ["SHOPIFY_NL_STORE"] },
  { market: "UK", flag: "🇬🇧", envKeys: ["SHOPIFY_UK_STORE"] },
  { market: "US", flag: "🇺🇸", envKeys: ["SHOPIFY_US_STORE", "TRIPLE_WHALE_SHOP_US"] },
  
] as const;

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function twMetric(metrics: any[], id: string): number | null {
  const m = metrics.find((x: any) => x.id === id);
  return toNumber(m?.values?.current);
}

const MARKET_CURRENCY: Record<string, string> = {
  NL: "EUR",
  UK: "GBP",
  US: "USD",
  EU: "EUR",
};

const fxCache = new Map<string, Promise<number>>();
// Last-known-good rate per currency. Populated on every successful fetch; used
// as a graceful fallback when Frankfurter is unreachable. NEVER fabricate 1.0
// for non-EUR currencies — that silently corrupts UK/US revenue totals.
const fxLastGood = new Map<string, { rate: number; at: number }>();

async function getEurRate(currency: string, start: string, end: string): Promise<number> {
  if (currency === "EUR") return 1;
  const key = `${currency}|${start}|${end}`;
  const cached = fxCache.get(key);
  if (cached) return cached;

  const task = (async () => {
    try {
      const path = start === end ? start : `${start}..${end}`;
      // frankfurter.app now redirects to frankfurter.dev/v1/ — use the new URL directly
      const url = `https://api.frankfurter.dev/v1/${path}?base=${currency}&symbols=EUR`;
      const res = await fetch(url, { cache: "no-store", redirect: "follow" });
      if (res.ok) {
        const data = await res.json();
        const rates = data.rates ?? {};
        // Single-day response: { rates: { EUR: 0.92 } }
        // Range response: { rates: { "2026-04-01": { EUR: 0.92 }, ... } }
        const direct = toNumber(rates.EUR);
        if (direct !== null && direct > 0) {
          fxLastGood.set(currency, { rate: direct, at: Date.now() });
          return direct;
        }
        const series = Object.values(rates)
          .map((r: any) => toNumber(r?.EUR))
          .filter((n): n is number => typeof n === "number" && n > 0);
        if (series.length > 0) {
          const avg = series.reduce((a, b) => a + b, 0) / series.length;
          fxLastGood.set(currency, { rate: avg, at: Date.now() });
          return avg;
        }
        console.warn(
          `FX ${currency}->EUR: no rates in response`,
          JSON.stringify(data).slice(0, 200),
        );
      } else {
        console.warn(`FX ${currency}->EUR: HTTP ${res.status} from ${url}`);
      }
    } catch (err: any) {
      console.warn(`FX ${currency}->EUR failed:`, err?.message);
    }
    // Fall back to last-known-good rate rather than 1.0 (which would silently
    // misrepresent UK/US revenue at parity with EUR).
    const lkg = fxLastGood.get(currency);
    if (lkg) {
      console.warn(
        `FX ${currency}->EUR: using last-known-good rate ${lkg.rate} from ${new Date(lkg.at).toISOString()}`,
      );
      return lkg.rate;
    }
    throw new Error(`FX rate unavailable for ${currency} and no last-known-good cached`);
  })();

  fxCache.set(key, task);
  // Don't poison the cache with a rejected promise — drop on failure so the
  // next call retries Frankfurter.
  task.catch(() => fxCache.delete(key));
  return task;
}

function tripleWhaleTodayHour(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Amsterdam",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return Math.min(25, Math.max(1, (Number.isFinite(hour) ? hour : 0) + 1));
}

async function fetchTripleWhaleGrowthMonths(year: number, monthLabels: string[]) {
  const apiKey = process.env.TRIPLE_WHALE_API_KEY;
  if (!apiKey || monthLabels.length === 0) return [];

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const rows: Record<string, { month: string; revenue: number; orders: number; refunds: number; byMarket: Record<string, { revenue: number; orders: number; refunds: number }>; calcVersion: number; source: string }> = {};
  for (const label of monthLabels) rows[label] = { month: label, revenue: 0, orders: 0, refunds: 0, byMarket: {}, calcVersion: 3, source: "triplewhale_fallback" };

  const planned = TW_SHOPS.map(({ market, envKeys }: any) => {
    const shop = (envKeys as string[]).map((k) => process.env[k]).find(Boolean);
    return shop ? { market, shop } : null;
  }).filter(Boolean) as Array<{ market: string; shop: string }>;

  for (const label of monthLabels) {
    const match = label.match(/^([A-Za-z]{3})\s+'(\d{2})$/);
    const monthIdx = match ? monthNames.findIndex((m) => m.toLowerCase() === match[1].toLowerCase()) : -1;
    if (monthIdx < 0) continue;
    const month = String(monthIdx + 1).padStart(2, "0");
    const endDay = String(new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate()).padStart(2, "0");
    const start = `${year}-${month}-01`;
    const end = `${year}-${month}-${endDay}`;

    await Promise.all(planned.map(async ({ market, shop }) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8_000);
        const res = await fetch("https://api.triplewhale.com/api/v2/summary-page/get-data", {
          method: "POST",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ shopDomain: shop, period: { start, end }, todayHour: tripleWhaleTodayHour() }),
          signal: ctrl.signal,
          cache: "no-store",
        }).finally(() => clearTimeout(timer));
        if (!res.ok) return;
        const data = await res.json();
        const metrics = data.metrics ?? [];
        const fxRate = await getEurRate(MARKET_CURRENCY[market] ?? "EUR", start, end);
        const revenue = (twMetric(metrics, "netSales") ?? twMetric(metrics, "sales") ?? 0) * fxRate;
        const orders = Math.round(twMetric(metrics, "shopifyOrders") ?? 0);
        if (revenue <= 0 && orders <= 0) return;
        const row = rows[label];
        const marketRow = { revenue: +revenue.toFixed(2), orders, refunds: 0 };
        row.byMarket[market] = marketRow;
        row.revenue += marketRow.revenue;
        row.orders += marketRow.orders;
      } catch (err: any) {
        console.warn(`TW growth fallback ${market} ${label}:`, err?.message);
      }
    }));
  }

  return Object.values(rows)
    .filter((r) => r.revenue > 0 || r.orders > 0)
    .map((r) => ({ ...r, revenue: +r.revenue.toFixed(2) }));
}

// Triple Whale: Summary Page endpoint
// POST https://api.triplewhale.com/api/v2/summary-page/get-data
// Docs: https://triplewhale.readme.io/reference/get-summary-page-data
// Returns 698 metrics for a given shopDomain + period.
import { startProgress, markStore, finishProgress } from "./progress.server";

// ─── Triple Whale Orcabase SQL — true shipping cost ─────────────────────────
// POST https://api.triplewhale.com/api/v2/orcabase/api/sql
// Returns SUM(shipping_costs) per shop in the shop's source currency.
// We convert to EUR using the standard FX helper.
async function fetchTripleWhaleShippingForShop(
  shop: string,
  market: string,
  start: string,
  end: string,
  apiKey: string,
): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch("https://api.triplewhale.com/api/v2/orcabase/api/sql", {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        period: { startDate: start, endDate: end },
        shopId: shop,
        query:
          "SELECT SUM(shipping_costs) AS shipping_cost FROM orders_table WHERE platform = 'shopify'",
      }),
      signal: ctrl.signal,
      cache: "no-store",
    }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      console.warn(`TW shipping ${market} ${res.status}`);
      return null;
    }
    const json: any = await res.json();
    // Response can be { data: [...] }, { rows: [...] } or { results: [...] }.
    const rows: any[] =
      (Array.isArray(json) ? json : null) ??
      json?.data ?? json?.rows ?? json?.results ?? json?.result?.rows ?? [];
    const first = rows[0];
    if (!first) return 0;
    const raw =
      first.shipping_cost ?? first.ShippingCost ?? first.SHIPPING_COST ??
      first.shipping_costs ?? first[Object.keys(first)[0]];
    const num = toNumber(raw);
    if (num == null) return null;
    // Triple Whale's shipping_costs column is already normalized to EUR
    // by TW for all shops — do NOT apply an additional FX conversion.
    return +num.toFixed(2);
  } catch (err: any) {
    console.warn(`TW shipping ${market}:`, err?.message);
    return null;
  }
}

// ─── Shopify Admin GraphQL — ShopifyQL Analytics: refunded_payments ────────
// Equivalent to the Triple Whale Moby query:
//   FROM payments SHOW refunded_payments SINCE x UNTIL y
// Endpoint: POST /admin/api/{version}/graphql.json
// Field:    Query.shopifyqlQuery(query: String!): ShopifyqlResponse
// Docs:     https://shopify.dev/docs/api/admin-graphql/latest/queries/shopifyqlQuery
//
// Returned amount is in the shop's payout currency (NL=EUR, UK=GBP, US=USD).
// Refunds in Shopify Analytics are negative numbers; we return the absolute
// EUR-converted value so the UI can render it as a positive refund total.
async function fetchShopifyRefundsForShop(
  store: string,
  market: string,
  start: string,
  end: string,
): Promise<{ refunds: number | null; native: number | null; currency: string; raw?: any; error?: string }> {
  const token = await getShopifyToken(store);
  if (!token) return { refunds: null, native: null, currency: MARKET_CURRENCY[market] ?? "EUR", error: "no_token" };
  // Mirrors the Shopify "Returns over time" admin report. We try a list of
  // ShopifyQL queries (newest schema first) and use the first one that
  // returns rows — Shopify's available metrics differ by store/version.
  const candidates = [
    `FROM sales SHOW returns SINCE ${start} UNTIL ${end}`,
    `FROM orders SHOW returns SINCE ${start} UNTIL ${end}`,
    `FROM sales SHOW total_returns SINCE ${start} UNTIL ${end}`,
    `FROM payments SHOW refunded_payments SINCE ${start} UNTIL ${end}`,
  ];
  const gql = `query($q: String!) {
    shopifyqlQuery(query: $q) {
      parseErrors
      tableData {
        columns { name dataType displayName }
        rows
      }
    }
  }`;
  const sourceCurrency = MARKET_CURRENCY[market] ?? "EUR";
  let lastError: string | undefined;
  let lastQuery: string | undefined;
  for (const shopifyql of candidates) {
    lastQuery = shopifyql;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetch(`https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: gql, variables: { q: shopifyql } }),
        signal: ctrl.signal,
        cache: "no-store",
      }).finally(() => clearTimeout(timer));
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastError = `http_${res.status}: ${text.slice(0, 160)}`;
        console.warn(`Shopify refunds ${market} ${shopifyql} → ${lastError}`);
        continue;
      }
      const json: any = await res.json();
      if (json.errors?.length) {
        lastError = json.errors[0]?.message ?? "graphql_error";
        console.warn(`Shopify refunds ${market} ${shopifyql} GQL: ${lastError}`);
        continue;
      }
      const r = json?.data?.shopifyqlQuery;
      if (Array.isArray(r?.parseErrors) && r.parseErrors.length) {
        lastError = String(r.parseErrors[0]);
        // try next candidate query
        continue;
      }
      const rows: any = r?.tableData?.rows ?? [];
      let nativeSum = 0;
      const flat = Array.isArray(rows) ? rows : [];
      for (const row of flat) {
        const cell = Array.isArray(row) ? row[row.length - 1] : row;
        const n = toNumber(cell);
        if (n != null) nativeSum += n;
      }
      const native = +Math.abs(nativeSum).toFixed(2);
      const fxRate = await getEurRate(sourceCurrency, start, end);
      const eur = +(native * fxRate).toFixed(2);
      return { refunds: eur, native, currency: sourceCurrency, raw: rows, query: shopifyql } as any;
    } catch (err: any) {
      lastError = err?.message ?? "exception";
      console.warn(`Shopify refunds ${market} ${shopifyql} threw: ${lastError}`);
    }
  }
  return {
    refunds: null,
    native: null,
    currency: sourceCurrency,
    error: lastError ?? "all_queries_failed",
    raw: { triedQuery: lastQuery },
  };
}

// Back-compat shim — TW row enrichment still calls this name.
async function fetchTripleWhaleRefundsForShop(
  shop: string,
  market: string,
  start: string,
  end: string,
  _apiKey: string,
): Promise<number | null> {
  const r = await fetchShopifyRefundsForShop(shop, market, start, end);
  return r.refunds;
}

export async function fetchTripleWhaleRefunds(start: string, end: string) {
  const planned = TW_SHOPS.map(({ market, envKeys }: any) => {
    const shop = (envKeys as string[]).map((k) => process.env[k]).find(Boolean);
    return shop ? { market, shop } : null;
  }).filter(Boolean) as Array<{ market: string; shop: string }>;
  const out: Record<string, number | null> = {};
  await Promise.all(
    planned.map(async ({ market, shop }) => {
      const r = await fetchShopifyRefundsForShop(shop, market, start, end);
      out[market] = r.refunds;
    }),
  );
  return out;
}

// Verbose variant — returns native amount, currency, and raw row data so the
// debug endpoint can show exactly what Shopify ShopifyQL Analytics returned.
export async function fetchShopifyRefundsBreakdown(start: string, end: string) {
  const planned = TW_SHOPS.map(({ market, envKeys }: any) => {
    const shop = (envKeys as string[]).map((k) => process.env[k]).find(Boolean);
    return shop ? { market, shop } : null;
  }).filter(Boolean) as Array<{ market: string; shop: string }>;
  const out: Record<string, any> = {};
  await Promise.all(
    planned.map(async ({ market, shop }) => {
      const r = await fetchShopifyRefundsForShop(shop, market, start, end);
      out[market] = { shop, ...r, query: `FROM payments SHOW refunded_payments SINCE ${start} UNTIL ${end}` };
    }),
  );
  return out;
}

export async function fetchTripleWhaleShipping(start: string, end: string) {
  const apiKey = process.env.TRIPLE_WHALE_API_KEY;
  if (!apiKey) return null;
  const planned = TW_SHOPS.map(({ market, envKeys }: any) => {
    const shop = (envKeys as string[]).map((k) => process.env[k]).find(Boolean);
    return shop ? { market, shop } : null;
  }).filter(Boolean) as Array<{ market: string; shop: string }>;
  const out: Record<string, number | null> = {};
  await Promise.all(
    planned.map(async ({ market, shop }) => {
      out[market] = await fetchTripleWhaleShippingForShop(shop, market, start, end, apiKey);
    }),
  );
  return out;
}

// Per-month shipping cost for the trailing N months (default 12),
// keyed by month label "MMM 'YY". Used by Monthly Overview P&L.
export async function fetchTripleWhaleShippingMonthly(monthsBack = 12) {
  const apiKey = process.env.TRIPLE_WHALE_API_KEY;
  if (!apiKey) return null;
  const planned = TW_SHOPS.map(({ market, envKeys }: any) => {
    const shop = (envKeys as string[]).map((k) => process.env[k]).find(Boolean);
    return shop ? { market, shop } : null;
  }).filter(Boolean) as Array<{ market: string; shop: string }>;

  const monthNamesShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const now = new Date();
  const periods: Array<{ label: string; start: string; end: string }> = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const start = `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const endDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const end = `${y}-${String(m + 1).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
    const label = `${monthNamesShort[m]} '${String(y).slice(-2)}`;
    periods.push({ label, start, end });
  }

  const byMonth: Record<string, { total: number; byMarket: Record<string, number> }> = {};
  for (const p of periods) byMonth[p.label] = { total: 0, byMarket: {} };

  // Sequential per period to avoid hammering the SQL endpoint.
  for (const p of periods) {
    await Promise.all(
      planned.map(async ({ market, shop }) => {
        const v = await fetchTripleWhaleShippingForShop(shop, market, p.start, p.end, apiKey);
        if (v != null) {
          byMonth[p.label].byMarket[market] = v;
          byMonth[p.label].total += v;
        }
      }),
    );
  }
  return { ...byMonth, calcVersion: 2 };
}

export async function fetchTripleWhale(fromDate?: string, toDate?: string, progressKey?: string) {
  const apiKey = process.env.TRIPLE_WHALE_API_KEY;
  if (!apiKey) return null;

  const start = fromDate ?? startOfMonth();
  const end = toDate ?? today();

  // Determine which stores will actually be fetched (have an env-mapped shop)
  const planned = TW_SHOPS.map(({ market, flag, envKeys }: any) => {
    const shop = (envKeys as string[]).map((k) => process.env[k]).find(Boolean);
    return shop ? { market, flag, shop } : null;
  }).filter(Boolean) as Array<{ market: string; flag: string; shop: string }>;

  if (progressKey) {
    startProgress(
      progressKey,
      planned.map(({ market, flag }) => ({ market, flag })),
    );
  }

  const results = await Promise.all(
    TW_SHOPS.map(async ({ market, flag, envKeys }: any) => {
      const shop = (envKeys as string[]).map((k) => process.env[k]).find(Boolean);
      if (!shop) return { market, flag, live: false };

      // Triple Whale's summary-page endpoint returns 698 metrics; under load it
      // can routinely take 30–50s. Use a 60s timeout and retry once on abort to
      // avoid blanking the dashboard on a single slow response.
      const TW_TIMEOUT_MS = 60_000;
      const callTW = async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TW_TIMEOUT_MS);
        try {
          return await fetch("https://api.triplewhale.com/api/v2/summary-page/get-data", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              shopDomain: shop,
              period: { start, end },
              todayHour: tripleWhaleTodayHour(),
            }),
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      };

      try {
        let res: Response;
        try {
          res = await callTW();
        } catch (firstErr: any) {
          // Retry once on abort/network errors before giving up
          const msg = firstErr?.message || String(firstErr);
          if (/abort|timeout|network/i.test(msg)) {
            console.warn(`Triple Whale ${market} first attempt failed (${msg}), retrying...`);
            res = await callTW();
          } else {
            throw firstErr;
          }
        }

        if (!res.ok) {
          const body = await res.text();
          console.error(`Triple Whale ${market} ${res.status}:`, body.slice(0, 200));
          if (progressKey) markStore(progressKey, market, "error");
          return { market, flag, live: false };
        }

        const data = await res.json();
        const m = data.metrics ?? [];
        const sourceCurrency = MARKET_CURRENCY[market] ?? "EUR";
        const eurRate = await getEurRate(sourceCurrency, start, end);
        const metric = (...ids: string[]) => {
          for (const id of ids) {
            const value = twMetric(m, id);
            if (value != null) return value;
          }
          return null;
        };
        const moneyMetric = (...ids: string[]) => {
          const value = metric(...ids);
          return value == null ? null : value * eurRate;
        };

        // All IDs confirmed from live API (698 metrics) — April 2026
        const row = {
          market,
          flag,
          currency: "EUR",
          sourceCurrency,
          fxRate: eurRate,
          revenue: moneyMetric("grossSales", "sales"), // Gross Sales
          // Triple Whale API title for `netSales` is "Total Sales".
          // Formula: Gross Sales + Shipping + Taxes − Discounts − Refunded Sales − Refunded Shipping − Refunded Taxes.
          netRevenue: moneyMetric("netSales", "sales"),
          // Returns / refunds — surfaces the same number TW shows on the
          // "Returns" tile in their Summary page. The ShopifyQL-based
          // `refundsTW` below sometimes errors with parse errors on certain
          // Shopify versions and returns null; this metric comes from TW's
          // own pipeline and is more reliable.
          refunds: moneyMetric("refundedSales", "refunds", "totalRefunds", "refundedPayments"),
          newCustomerRev: moneyMetric("newCustomerSales"), // New Customer Revenue
          adSpend: moneyMetric("blendedAds"), // Total blended ad spend
          facebookSpend: moneyMetric("facebookAds"), // Facebook / Meta
          googleSpend: moneyMetric("googleAds"), // Google Ads
          tiktokSpend: moneyMetric("tiktokAds"), // TikTok Ads
          snapchatSpend: moneyMetric("snapchatAds"), // Snapchat Ads
          pinterestSpend: moneyMetric("pinterestAds"), // Pinterest Ads
          bingSpend: moneyMetric("bingAds", "microsoftAds"), // Microsoft / Bing
          klaviyoSpend: moneyMetric("klaviyoCost"), // Klaviyo cost
          appleSpend: moneyMetric("appleSearchAds"), // Apple Search Ads
          amazonSpend: moneyMetric("amazonAds"), // Amazon Ads
          linkedinSpend: moneyMetric("linkedinAds"), // LinkedIn Ads
          twitterSpend: moneyMetric("twitterAds", "xAds"), // Twitter / X Ads
          youtubeSpend: moneyMetric("youtubeAds"), // YouTube Ads
          redditSpend: moneyMetric("redditAds"), // Reddit Ads
          outbrainSpend: moneyMetric("outbrainAds"), // Outbrain
          taboolaSpend: moneyMetric("taboolaAds"), // Taboola
          criteoSpend: moneyMetric("criteoAds"), // Criteo
          influencerSpend: moneyMetric("influencerAds", "influencerCost"), // Influencer
          customSpend: moneyMetric("customAds", "otherAds"), // Custom / other
          roas: twMetric(m, "roas"), // Blended ROAS
          ncRoas: twMetric(m, "newCustomersRoas"), // New Customer ROAS
          fbRoas: twMetric(m, "facebookRoas"), // Facebook ROAS
          googleRoas: twMetric(m, "googleRoas"), // Google ROAS
          mer: twMetric(m, "mer"), // Marketing Efficiency Ratio
          ncpa: moneyMetric("newCustomersCpa"), // New Customer CPA
          ltvCpa: twMetric(m, "ltvCpa"), // LTV:CPA ratio
          aov: moneyMetric("shopifyAov"), // True AOV
          orders: twMetric(m, "shopifyOrders"), // Total orders
          grossProfit: moneyMetric("grossProfit"), // Gross Profit
          netProfit: moneyMetric("totalNetProfit"), // Net Profit (after all costs)
          cogs: moneyMetric("cogs"), // Cost of Goods Sold
          newCustomersPct: twMetric(m, "newCustomersPercent"), // % new customers
          uniqueCustomers: twMetric(m, "uniqueCustomers"), // Unique customers
          // Subscription metrics
          subRevenue: moneyMetric("subscriptionSales", "recurringRevenue", "subscriptionRevenue"),
          subOrders: metric("subscriptionOrders"),
          activeSubscribers: metric("activeSubscribers", "subscriptionActive"),
          newSubscribers: metric("newSubscribers", "subscriptionStarted", "subscriptionNew"),
          cancelledSubs: metric(
            "cancelledSubscribers",
            "subscriptionCancelled",
            "subscriptionChurned",
          ),
          mrr: moneyMetric("mrr", "monthlyRecurringRevenue"),
          churnRate: metric("subscriptionChurnRate", "churnRate"),
        };

        const hasMetrics = Array.isArray(m) && m.length > 0;
        if (progressKey) markStore(progressKey, market, hasMetrics ? "done" : "error");
        if (!hasMetrics) return { market, flag, live: false };

        // Enrich with true shipping cost + refunds from Orcabase SQL endpoint.
        const [shippingCost, refundsTW] = await Promise.all([
          fetchTripleWhaleShippingForShop(shop, market, start, end, apiKey),
          fetchTripleWhaleRefundsForShop(shop, market, start, end, apiKey),
        ]);

        return { ...row, shippingCost, refundsTW, live: true };
      } catch (err: any) {
        console.error(`Triple Whale ${market}:`, err.message);
        if (progressKey) markStore(progressKey, market, "error");
        return { market, flag, live: false };
      }
    }),
  );

  if (progressKey) finishProgress(progressKey);

  const hasAnyLive = results.some((r) => r.live);
  return hasAnyLive ? results : null;
}

export async function fetchTripleWhaleCustomerEconomics() {
  const apiKey = process.env.TRIPLE_WHALE_API_KEY;
  const shop = process.env.SHOPIFY_NL_STORE;
  if (!apiKey || !shop) return null;

  const end = today();
  const fetchWindow = async (days: number) => {
    const start = daysAgo(days);
    const res = await fetch("https://api.triplewhale.com/api/v2/summary-page/get-data", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        shopDomain: shop,
        period: { start, end },
        todayHour: tripleWhaleTodayHour(),
      }),
    });
    if (!res.ok) throw new Error(`Triple Whale customer economics ${days}D: ${res.status}`);
    const data = await res.json();
    return twMetric(data.metrics ?? [], "uniqueCustomerSales");
  };

  try {
    const [ltv90, ltv365] = await Promise.all([fetchWindow(90), fetchWindow(365)]);
    return { market: "NL", currency: "EUR", ltv90, ltv365, live: ltv90 != null || ltv365 != null };
  } catch (err: any) {
    console.error("Triple Whale customer economics:", err?.message);
    return null;
  }
}

// ─── Daily Profit Fetchers (Shopify daily revenue + TW daily ad spend) ────────
//
// Powers the "Today's Profit" card on the Overview dashboard.
// Cached for 12h (sync.server.ts) — the rolling 30-day chart only needs to be
// refreshed once a day.

function amsterdamDateKey(iso: string): string {
  // Returns "YYYY-MM-DD" in Europe/Amsterdam timezone for an ISO string.
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split("T")[0];
}

/**
 * Fetch the last 365 days of Shopify orders for every store, bucketed by
 * Amsterdam-tz day and converted to EUR. Returns:
 *   { daily: { "YYYY-MM-DD": { revenue: EUR, orders: int } }, byMarket: {...} }
 */
export async function fetchShopifyDaily() {
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
  if (!clientId) return null;

  const sinceDate = daysAgoIso(365);
  const since = `${sinceDate}T00:00:00Z`;

  const perStore = await Promise.all(
    SHOPIFY_STORES.map(async ({ code, storeKey }: any) => {
      const store = process.env[storeKey];
      if (!store) return { code, daily: {} as Record<string, { revenue: number; orders: number }> };

      const token = await getShopifyToken(store);
      if (!token) return { code, daily: {} };

      try {
        // Reuse fetchShopifyAllOrders but extract per-day buckets ourselves —
        // the existing helper aggregates monthly. Run a fresh paginated query
        // here so we can bucket by day with Amsterdam-tz keys.
        const dailySums: Record<string, { revenue: number; orders: number; currency: string }> = {};
        let cursor: string | null = null;
        let hasNextPage = true;
        let page = 0;
        const maxPages = 240; // up to 60k orders / store / year

        while (hasNextPage && page < maxPages) {
          const res: Response = await fetch(`https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
            body: JSON.stringify({ query: SHOPIFY_GQL_PAGE(since, cursor) }),
          });
          if (!res.ok) break;
          const json = await res.json();
          if (json.errors) {
            console.error(`Shopify daily ${code} GQL:`, json.errors[0]?.message);
            break;
          }
          const pageData = json.data?.orders ?? {};
          const edges: any[] = pageData.edges ?? [];
          hasNextPage = pageData.pageInfo?.hasNextPage ?? false;
          cursor = pageData.pageInfo?.endCursor ?? null;
          page++;

          for (const { node: o } of edges) {
            const r = parseFloat(o.totalPriceSet.shopMoney.amount);
            const rf = parseFloat(o.totalRefundedSet.shopMoney.amount);
            const net = r - rf;
            const currency = o.totalPriceSet.shopMoney.currencyCode || "EUR";
            const dayKey = amsterdamDateKey(o.createdAt);
            if (!dailySums[dayKey]) dailySums[dayKey] = { revenue: 0, orders: 0, currency };
            dailySums[dayKey].revenue += net;
            dailySums[dayKey].orders += 1;
          }
        }

        // Convert each day to EUR using a single FX rate for the whole period
        // (good enough for a rolling chart; daily FX would be 365 extra calls).
        const sample = Object.values(dailySums)[0];
        const currency = sample?.currency || "EUR";
        const fxRate = await getEurRate(currency, sinceDate, today());
        const daily: Record<string, { revenue: number; orders: number }> = {};
        for (const [k, v] of Object.entries(dailySums)) {
          daily[k] = { revenue: +(v.revenue * fxRate).toFixed(2), orders: v.orders };
        }
        return { code, daily };
      } catch (err: any) {
        console.error(`Shopify daily ${code}:`, err?.message);
        return { code, daily: {} };
      }
    }),
  );

  // Merge per-market into a single daily series
  const merged: Record<string, { revenue: number; orders: number }> = {};
  for (const { daily } of perStore) {
    for (const [k, v] of Object.entries(
      daily as Record<string, { revenue: number; orders: number }>,
    )) {
      if (!merged[k]) merged[k] = { revenue: 0, orders: 0 };
      merged[k].revenue += v.revenue;
      merged[k].orders += v.orders;
    }
  }

  const hasAny = Object.keys(merged).length > 0;
  if (!hasAny) return null;

  return {
    daily: merged,
    byMarket: Object.fromEntries(perStore.map((s) => [s.code, s.daily])),
    calcVersion: 2,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch Triple Whale per-day ad spend & gross profit for the last 30 days
 * across all stores. One TW summary call per (day × store) — heavy but cached
 * for 12h. Returns { daily: { "YYYY-MM-DD": { adSpend, grossProfit } } }
 */
export async function fetchTripleWhaleDaily() {
  const apiKey = process.env.TRIPLE_WHALE_API_KEY;
  if (!apiKey) return null;

  const planned = TW_SHOPS.map(({ market, envKeys }: any) => {
    const shop = (envKeys as string[]).map((k) => process.env[k]).find(Boolean);
    return shop ? { market, shop } : null;
  }).filter(Boolean) as Array<{ market: string; shop: string }>;

  if (planned.length === 0) return null;

  // Build the list of (day, store) pairs we need to fetch — last 30 days incl. today.
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) days.push(daysAgoIso(i));

  type DayBucket = { adSpend: number; grossProfit: number; revenue: number };
  const merged: Record<string, DayBucket> = {};
  for (const d of days) merged[d] = { adSpend: 0, grossProfit: 0, revenue: 0 };

  // Concurrency limit — 8 concurrent TW calls. TW's "first hit on a cold
  // date" routinely takes 20-25s while their backend back-fills from
  // Shopify, so a tight 15s timeout produced bursts of aborts on contiguous
  // date ranges. Bumped to 30s + one retry: timeout retries usually succeed
  // because TW caches the slow-path response on attempt 1.
  const CONCURRENCY = 8;
  const PER_CALL_TIMEOUT_MS = 30_000;
  const tasks: Array<() => Promise<void>> = [];

  const fetchTwDay = async (
    shop: string,
    day: string,
    timeoutMs: number,
  ): Promise<{ ok: true; data: any } | { ok: false; aborted: boolean; status?: number; message?: string }> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch("https://api.triplewhale.com/api/v2/summary-page/get-data", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          shopDomain: shop,
          period: { start: day, end: day },
          todayHour: tripleWhaleTodayHour(),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) return { ok: false, aborted: false, status: res.status };
      const data = await res.json();
      return { ok: true, data };
    } catch (err: any) {
      const aborted = err?.name === "AbortError" || /aborted/i.test(err?.message ?? "");
      return { ok: false, aborted, message: err?.message ?? String(err) };
    } finally {
      clearTimeout(timer);
    }
  };

  for (const { market, shop } of planned) {
    const sourceCurrency = MARKET_CURRENCY[market] ?? "EUR";
    for (const day of days) {
      tasks.push(async () => {
        let result = await fetchTwDay(shop, day, PER_CALL_TIMEOUT_MS);
        // Retry once if we timed out — TW caches the slow-path response on
        // attempt 1, so attempt 2 almost always returns in <2s.
        if (!result.ok && result.aborted) {
          result = await fetchTwDay(shop, day, PER_CALL_TIMEOUT_MS);
        }
        if (!result.ok) {
          if (result.aborted) console.warn(`TW daily ${market} ${day}: aborted after retry`);
          else console.warn(`TW daily ${market} ${day}: HTTP ${result.status ?? "?"} ${result.message ?? ""}`);
          return;
        }
        const m = result.data.metrics ?? [];
        const fxRate = await getEurRate(sourceCurrency, day, day);
        const ad = twMetric(m, "blendedAds");
        const gp = twMetric(m, "grossProfit");
        const rv = twMetric(m, "netSales") ?? twMetric(m, "sales");
        if (ad != null) merged[day].adSpend += ad * fxRate;
        if (gp != null) merged[day].grossProfit += gp * fxRate;
        if (rv != null) merged[day].revenue += rv * fxRate;
      });
    }
  }

  // Run in batches of CONCURRENCY
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    await Promise.all(tasks.slice(i, i + CONCURRENCY).map((t) => t()));
  }

  // Round
  const daily: Record<string, DayBucket> = {};
  for (const [k, v] of Object.entries(merged)) {
    daily[k] = {
      adSpend: +v.adSpend.toFixed(2),
      grossProfit: +v.grossProfit.toFixed(2),
      revenue: +v.revenue.toFixed(2),
    };
  }

  return { daily, fetchedAt: new Date().toISOString() };
}

// ─── Juo Subscriptions (NL store) ────────────────────────────────────────────
//
// Base URL: https://api.juo.io/admin/v1
// Auth: X-Juo-Admin-Api-Key header
// Pagination: Link response header with rel="next" (cursor-based)
// Fields: id, status (active|paused|canceled|failed|expired|merged),
//         currencyCode, createdAt, canceledAt, nextBillingDate,
//         items[].price, billingPolicy.interval, billingPolicy.intervalCount

function normalizeToMonthly(price: number, interval: string, intervalCount: number): number {
  const n = intervalCount || 1;
  switch (interval) {
    case "day":
      return (price / n) * 30;
    case "week":
      return (price / n) * 4.33;
    case "year":
      return price / (n * 12);
    default:
      return price / n; // month
  }
}

async function _fetchJuo() {
  const apiKey = process.env.JUO_NL_API_KEY;
  if (!apiKey) {
    console.warn("Juo: JUO_NL_API_KEY not set in this runtime");
    return null;
  }

  const JUO_BASE = "https://api.juo.io";
  const headers = { "X-Juo-Admin-Api-Key": apiKey, Accept: "application/json" };
  const allSubs: any[] = [];
  const MAX_PAGES = 300;
  // Always build absolute URLs — Juo's Link header returns relative paths
  // Fetch the active book directly. Pulling every historical cancelled/expired
  // subscription first can cap the response before all active subscriptions are
  // seen, which makes MRR and active-subscriber finance metrics inaccurate.
  let nextUrl: string | null = `${JUO_BASE}/admin/v1/subscriptions?limit=100&status=active`;
  let page = 0;

  try {
    while (nextUrl && page < MAX_PAGES) {
      const res: Response = await fetch(nextUrl, { headers, cache: "no-store" });

      if (res.status === 429) {
        const reset = parseInt(res.headers.get("X-RateLimit-Reset") ?? "2", 10);
        await new Promise((r) => setTimeout(r, (reset || 2) * 1000));
        continue;
      }
      if (!res.ok) {
        console.error(`Juo API ${res.status}`);
        break;
      }

      const json = await res.json();
      const batch: any[] = json.data ?? json.subscriptions ?? (Array.isArray(json) ? json : []);
      if (batch.length === 0) break;
      allSubs.push(...batch);

      // Follow Link header — Juo returns relative paths like </admin/v1/subscriptions?...>; rel="next"
      const link: string = res.headers.get("Link") ?? "";
      const m: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
      if (m) {
        // Resolve relative or absolute href against JUO_BASE
        const href = m[1];
        nextUrl = href.startsWith("http") ? href : new URL(href, JUO_BASE).toString();
      } else {
        nextUrl = null;
      }
      page++;
    }

    if (!allSubs.length) return null;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Diagnostic: tally every distinct value of every status-like field on
    // the returned subs. Critical when our active-count doesn't match Juo's
    // UI — we need to know which field name + value combination Juo uses
    // for their "Active" headline (vs. "Paused" / "Cancelled" / "Failed").
    const distinct = (key: string) => {
      const counts: Record<string, number> = {};
      for (const s of allSubs) {
        const v = s?.[key];
        if (v === undefined || v === null) continue;
        const k = String(v);
        counts[k] = (counts[k] ?? 0) + 1;
      }
      return counts;
    };
    const sampleSub = allSubs[0] ?? null;
    const juoDiagnostics = {
      totalFetched: allSubs.length,
      statusCounts: distinct("status"),
      stateCounts: distinct("state"),
      lifecycleStateCounts: distinct("lifecycleState"),
      billingStatusCounts: distinct("billingStatus"),
      // Counts of subs with each "side-status" flag set (paused/failed/cancelled
      // are often tracked as boolean-ish flags alongside the main `status`).
      withPausedAt: allSubs.filter((s) => s?.pausedAt).length,
      withCanceledAt: allSubs.filter((s) => s?.canceledAt).length,
      withFailedAt: allSubs.filter((s) => s?.failedAt).length,
      sampleKeys: sampleSub ? Object.keys(sampleSub).sort() : [],
    };
    console.info(
      `[juo] diagnostic — total=${juoDiagnostics.totalFetched}, ` +
        `statusCounts=${JSON.stringify(juoDiagnostics.statusCounts)}, ` +
        `pausedAt=${juoDiagnostics.withPausedAt}, canceledAt=${juoDiagnostics.withCanceledAt}, failedAt=${juoDiagnostics.withFailedAt}, ` +
        `lifecycleStateCounts=${JSON.stringify(juoDiagnostics.lifecycleStateCounts)}, ` +
        `stateCounts=${JSON.stringify(juoDiagnostics.stateCounts)}`,
    );

    // STRICTER active filter: status === "active" AND not paused, failed, or
    // cancelled (tracked as side-status timestamps in many Juo schemas). If
    // these flags don't exist on the response, the filter degenerates to the
    // existing status === "active" check, so it's safe to leave on.
    const activeSubs = allSubs.filter(
      (s) =>
        s.status === "active" &&
        !s.pausedAt &&
        !s.canceledAt &&
        !s.failedAt &&
        // Defensive secondary checks for alternative field names some Juo
        // tenants use. Tear out whichever ends up not applying once we see
        // the diagnostic above.
        s.lifecycleState !== "paused" &&
        s.lifecycleState !== "canceled" &&
        s.lifecycleState !== "failed" &&
        s.state !== "paused" &&
        s.state !== "canceled" &&
        s.state !== "failed",
    );
    const pausedSubs = allSubs.filter((s) => s.status === "paused" || s.pausedAt || s.lifecycleState === "paused");
    const canceledSubs = allSubs.filter((s) => s.status === "canceled" || s.canceledAt || s.lifecycleState === "canceled");

    // Unique-customer dedup. Juo's UI shows "Active subscribers" as unique
    // customer count, not subscription records — when a single customer has
    // multiple active subscriptions they appear once on the UI but as N rows
    // in the API. Try the common customer-identifier paths Juo's schema
    // uses; fall back to subscription ID so unknown rows still count.
    const juoCustomerKey = (s: any): string => {
      const id =
        s?.customerId ??
        s?.customer_id ??
        s?.customer?.id ??
        s?.customerEmail ??
        s?.customer?.email ??
        null;
      return id != null && id !== "" ? String(id) : `sub:${s?.id ?? Math.random()}`;
    };
    const uniqueActiveCustomers = new Set<string>(activeSubs.map(juoCustomerKey));

    // MRR = sum of each active subscription's items, normalised to monthly
    let mrr = 0;
    for (const sub of activeSubs) {
      const interval = sub.billingPolicy?.interval ?? "month";
      const intervalCount = sub.billingPolicy?.intervalCount ?? 1;
      for (const item of sub.items ?? []) {
        const price = parseFloat(item.price ?? item.unitPrice ?? "0");
        mrr += normalizeToMonthly(price, interval, intervalCount);
      }
      // Add delivery price if billed to customer
      if (sub.deliveryPrice > 0) {
        mrr += normalizeToMonthly(parseFloat(sub.deliveryPrice), interval, intervalCount);
      }
    }

    const newThisMonth = allSubs.filter(
      (s) => s.createdAt && new Date(s.createdAt) >= monthStart,
    ).length;
    const churnedThisMonth = canceledSubs.filter(
      (s) => s.canceledAt && new Date(s.canceledAt) >= monthStart,
    ).length;
    const arpu = activeSubs.length > 0 ? mrr / activeSubs.length : null;
    const churnRate =
      activeSubs.length + churnedThisMonth > 0
        ? +((churnedThisMonth / (activeSubs.length + churnedThisMonth)) * 100).toFixed(1)
        : null;

    const currency = activeSubs[0]?.currencyCode ?? "EUR";

    // ARPU recomputed against unique customer count.
    const arpuByCustomer = uniqueActiveCustomers.size > 0 ? mrr / uniqueActiveCustomers.size : null;

    return [
      {
        market: "NL",
        flag: "🇳🇱",
        platform: "juo",
        live: true,
        // Bumped to 4: headline activeSubs is now unique-customer count to
        // match Juo UI's "Active subscribers" line.
        calcVersion: 4,
        mrr: +mrr.toFixed(2),
        // activeSubs = unique customer count (Juo UI "Active subscribers");
        // subscription-record count preserved in _diagnostics for reference.
        activeSubs: uniqueActiveCustomers.size,
        pausedSubs: pausedSubs.length,
        canceledSubs: canceledSubs.length,
        totalFetched: allSubs.length,
        newThisMonth,
        churnedThisMonth,
        arpu: arpuByCustomer != null ? +arpuByCustomer.toFixed(2) : (arpu != null ? +arpu.toFixed(2) : null),
        churnRate,
        currency,
        _diagnostics: {
          ...juoDiagnostics,
          activeSubscriptionRecords: activeSubs.length,
          uniqueActiveCustomers: uniqueActiveCustomers.size,
        },
      },
    ];
  } catch (err: any) {
    console.error("Juo fetch error:", err.message);
    return null;
  }
}

// ─── Loop Subscriptions (UK · and future US/EU when keys added) ───────────────
//
// CONFIRMED WORKING — GET https://api.loopsubscriptions.com/admin/2023-10/subscription
// Auth: X-Loop-Token header (NOT Bearer token)
// Returns { success, message, data: [...subscriptions] }
// Each subscription: { id, status, totalLineItemPrice, currencyCode, createdAt, cancelledAt, ... }

const LOOP_STORES = [
  { market: "UK", flag: "🇬🇧", envKey: "LOOP_UK_API_KEY" },
  { market: "US", flag: "🇺🇸", envKey: "LOOP_US_API_KEY" },
  
] as const;

async function fetchLoopStore(market: string, flag: string, key: string) {
  const BASE = "https://api.loopsubscriptions.com";
  const headers = { "X-Loop-Token": key, Accept: "application/json" };
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const MAX_PAGES = 500;
  // Loop currently caps this endpoint at 100 rows even when pageSize is higher.
  // Keeping the requested size aligned prevents bad hasNext fallbacks and makes
  // partial-page detection reliable.
  const PAGE_SIZE = 100;

  // Fetch ACTIVE subs (paginated). To compute real churn we make a second pass
  // for CANCELLED subs — without this, churnedThisMonth is structurally always 0.
  async function fetchPages(status: "ACTIVE" | "CANCELLED"): Promise<{
    subs: any[];
    apiReached: boolean;
    rateLimited: boolean;
  }> {
    const subs: any[] = [];
    let apiReached = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1) await new Promise((r) => setTimeout(r, 1300));
      const url = `${BASE}/admin/2023-10/subscription?pageNo=${page}&pageSize=${PAGE_SIZE}&status=${status}`;
      let res: Response = await fetch(url, { headers, cache: "no-store" });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 15000));
        res = await fetch(url, { headers, cache: "no-store" });
      }
      if (res.status === 429) {
        console.warn(`Loop ${market} ${status}: rate-limited at page ${page}`);
        return { subs, apiReached, rateLimited: true };
      }
      if (!res.ok) {
        console.error(`Loop ${market} ${status} page ${page} → ${res.status}`);
        break;
      }
      apiReached = true;
      const json = await res.json();
      const batch: any[] = json.data ?? [];
      subs.push(...batch);
      const hasNext =
        json.pageInfo?.hasNextPage ?? json.pagination?.hasNextPage ?? batch.length === PAGE_SIZE;
      if (!hasNext || batch.length === 0) break;
    }
    return { subs, apiReached, rateLimited: false };
  }

  const activeResult = await fetchPages("ACTIVE");
  if (activeResult.rateLimited && !activeResult.apiReached) return null;

  // For CANCELLED, only paginate while results are still within the current
  // month — Loop returns newest first, so we can stop once cancelledAt < monthStart.
  let cancelledSubs: any[] = [];
  try {
    const cancelledResult = await fetchPages("CANCELLED");
    cancelledSubs = cancelledResult.subs;
  } catch (err: any) {
    console.warn(`Loop ${market} cancelled fetch failed:`, err?.message);
  }

  const allSubsFromActive = activeResult.subs;
  if (!activeResult.apiReached) return null;

  const currency = market === "US" ? "USD" : market === "UK" ? "GBP" : "EUR";
  const activeSubs = allSubsFromActive.filter((s) => (s.status ?? "").toUpperCase() === "ACTIVE");
  const mrr = activeSubs.reduce((sum, s) => sum + parseFloat(s.totalLineItemPrice ?? "0"), 0);
  const newThisMonth = allSubsFromActive.filter(
    (s) => s.createdAt && new Date(s.createdAt) >= monthStart,
  ).length;
  const churnedThisMonth = cancelledSubs.filter(
    (s) => s.cancelledAt && new Date(s.cancelledAt) >= monthStart,
  ).length;
  const arpu = activeSubs.length > 0 ? mrr / activeSubs.length : null;
  const churnRate =
    activeSubs.length + churnedThisMonth > 0
      ? +((churnedThisMonth / (activeSubs.length + churnedThisMonth)) * 100).toFixed(1)
      : null;

  return {
    market,
    flag,
    platform: "loop",
    live: true,
    calcVersion: 4,
    mrr: Math.round(mrr),
    activeSubs: activeSubs.length,
    totalFetched: allSubsFromActive.length + cancelledSubs.length,
    newThisMonth,
    churnedThisMonth,
    arpu: arpu != null ? +arpu.toFixed(2) : null,
    churnRate,
    currency,
  };
}

import { fetchLoopFromDb, fetchLoopFromDbForRange } from "./loop-db.server";

async function _fetchLoop() {
  // Read from Supabase tables (UK_loop / US_loop) instead of hitting the Loop API.
  const rows = await fetchLoopFromDb();
  return rows;
}

// Raw exports — called by /api/sync which writes results to Supabase data_cache
export const fetchJuoRaw = _fetchJuo;
export const fetchLoopRaw = _fetchLoop;
// Aliases for any legacy callers
export const fetchJuo = _fetchJuo;
export const fetchLoop = _fetchLoop;

// ─── Range-aware subscription fetchers ────────────────────────────────────────
// Compute MRR/active as of `toIso` (end of selected window), and new/churned
// inside [fromIso, toIso]. Used by /api/sync when a custom range is requested.

async function _juoPaginate(apiKey: string, status: "active" | "canceled"): Promise<any[]> {
  const JUO_BASE = "https://api.juo.io";
  const headers = { "X-Juo-Admin-Api-Key": apiKey, Accept: "application/json" };
  const out: any[] = [];
  let nextUrl: string | null = `${JUO_BASE}/admin/v1/subscriptions?limit=100&status=${status}`;
  let page = 0;
  const MAX_PAGES = 300;
  while (nextUrl && page < MAX_PAGES) {
    const res: Response = await fetch(nextUrl, { headers, cache: "no-store" });
    if (res.status === 429) {
      const reset = parseInt(res.headers.get("X-RateLimit-Reset") ?? "2", 10);
      await new Promise((r) => setTimeout(r, (reset || 2) * 1000));
      continue;
    }
    if (!res.ok) break;
    const json = await res.json();
    const batch: any[] = json.data ?? json.subscriptions ?? (Array.isArray(json) ? json : []);
    if (!batch.length) break;
    out.push(...batch);
    const link: string = res.headers.get("Link") ?? "";
    const m: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = m ? (m[1].startsWith("http") ? m[1] : new URL(m[1], JUO_BASE).toString()) : null;
    page++;
  }
  return out;
}

export async function fetchJuoForRange(fromIso: string, toIso: string) {
  const apiKey = process.env.JUO_NL_API_KEY;
  if (!apiKey) return null;
  const from = new Date(fromIso + "T00:00:00");
  const to = new Date(toIso + "T23:59:59");
  try {
    const [active, canceled] = await Promise.all([
      _juoPaginate(apiKey, "active"),
      _juoPaginate(apiKey, "canceled"),
    ]);
    const all = [...active, ...canceled];
    if (!all.length) return null;

    // Dedupe — Juo's API ignores the ?status= filter on some tenants and
    // returns the full book on every call, which causes a row to appear in
    // BOTH the "active" and "canceled" responses. Without this dedupe we
    // were double-counting and inflating activeAsOf from ~6k to ~19k.
    const allById = new Map<string, any>();
    for (const s of all) {
      const k = String(s?.id ?? s?.subscriptionId ?? `${s?.customer ?? ""}:${s?.createdAt ?? ""}`);
      const existing = allById.get(k);
      if (!existing) allById.set(k, s);
    }
    const allDeduped = Array.from(allById.values());

    // "Active as of `to`": current status === "active", not paused/failed,
    // created on/before `to`, AND not canceled before/at `to`. The previous
    // filter only checked the lifecycle (created/canceled timestamps), which
    // included PAUSED + FAILED + EXPIRED rows in the headline. Juo's own UI
    // gates on `status === "active"` so we mirror that for the headline.
    const activeAsOf = allDeduped.filter((s) => {
      if (s?.status !== "active") return false;
      if (s?.pausedAt) return false;
      if (s?.failedAt) return false;
      if (s?.lifecycleState === "paused" || s?.lifecycleState === "failed" || s?.lifecycleState === "expired") return false;
      if (s?.state === "paused" || s?.state === "failed" || s?.state === "expired") return false;
      const created = s.createdAt ? new Date(s.createdAt) : null;
      if (!created || created > to) return false;
      const canceledAt = s.canceledAt ? new Date(s.canceledAt) : null;
      if (canceledAt && canceledAt <= to) return false;
      return true;
    });

    let mrr = 0;
    for (const sub of activeAsOf) {
      const interval = sub.billingPolicy?.interval ?? "month";
      const intervalCount = sub.billingPolicy?.intervalCount ?? 1;
      for (const item of sub.items ?? []) {
        const price = parseFloat(item.price ?? item.unitPrice ?? "0");
        mrr += normalizeToMonthly(price, interval, intervalCount);
      }
      if (sub.deliveryPrice > 0) {
        mrr += normalizeToMonthly(parseFloat(sub.deliveryPrice), interval, intervalCount);
      }
    }

    const newInRange = allDeduped.filter((s) => {
      const c = s.createdAt ? new Date(s.createdAt) : null;
      return c && c >= from && c <= to;
    }).length;
    const churnedInRange = allDeduped.filter((s) => {
      const c = s.canceledAt ? new Date(s.canceledAt) : null;
      return c && c >= from && c <= to;
    }).length;

    const arpu = activeAsOf.length > 0 ? mrr / activeAsOf.length : null;
    const churnRate =
      activeAsOf.length + churnedInRange > 0
        ? +((churnedInRange / (activeAsOf.length + churnedInRange)) * 100).toFixed(1)
        : null;
    const currency = activeAsOf[0]?.currencyCode ?? allDeduped[0]?.currencyCode ?? "EUR";

    return [
      {
        market: "NL",
        flag: "🇳🇱",
        platform: "juo",
        live: true,
        // Bumped to 3: filter now requires status === "active" and not
        // paused/failed/expired, plus dedupe across the active/canceled
        // pagination calls. UI's overview-dashboard filter (calcVersion >= 2)
        // still accepts older shapes during the rollover.
        calcVersion: 3,
        rangeMode: true,
        mrr: +mrr.toFixed(2),
        activeSubs: activeAsOf.length,
        totalFetched: allDeduped.length,
        newThisMonth: newInRange,
        churnedThisMonth: churnedInRange,
        arpu: arpu != null ? +arpu.toFixed(2) : null,
        churnRate,
        currency,
      },
    ];
  } catch (err: any) {
    console.error("Juo range fetch error:", err?.message);
    return null;
  }
}

async function _loopPaginate(BASE: string, headers: Record<string, string>, status: "ACTIVE" | "CANCELLED"): Promise<{ subs: any[]; ok: boolean }> {
  const subs: any[] = [];
  const MAX_PAGES = 500;
  const PAGE_SIZE = 100;
  let ok = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await new Promise((r) => setTimeout(r, 1300));
    const url = `${BASE}/admin/2023-10/subscription?pageNo=${page}&pageSize=${PAGE_SIZE}&status=${status}`;
    let res: Response = await fetch(url, { headers, cache: "no-store" });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 15000));
      res = await fetch(url, { headers, cache: "no-store" });
    }
    if (!res.ok) break;
    ok = true;
    const json = await res.json();
    const batch: any[] = json.data ?? [];
    subs.push(...batch);
    const hasNext =
      json.pageInfo?.hasNextPage ?? json.pagination?.hasNextPage ?? batch.length === PAGE_SIZE;
    if (!hasNext || !batch.length) break;
  }
  return { subs, ok };
}

async function fetchLoopStoreForRange(market: string, flag: string, key: string, fromIso: string, toIso: string) {
  const BASE = "https://api.loopsubscriptions.com";
  const headers = { "X-Loop-Token": key, Accept: "application/json" };
  const from = new Date(fromIso + "T00:00:00");
  const to = new Date(toIso + "T23:59:59");

  const [activeRes, cancelledRes] = await Promise.all([
    _loopPaginate(BASE, headers, "ACTIVE"),
    _loopPaginate(BASE, headers, "CANCELLED").catch(() => ({ subs: [], ok: false })),
  ]);
  if (!activeRes.ok) return null;
  const all = [...activeRes.subs, ...cancelledRes.subs];

  const activeAsOf = all.filter((s) => {
    const created = s.createdAt ? new Date(s.createdAt) : null;
    if (!created || created > to) return false;
    const cancelled = s.cancelledAt ? new Date(s.cancelledAt) : null;
    if (cancelled && cancelled <= to) return false;
    return true;
  });
  const mrr = activeAsOf.reduce((sum, s) => sum + parseFloat(s.totalLineItemPrice ?? "0"), 0);

  const newInRange = all.filter((s) => {
    const c = s.createdAt ? new Date(s.createdAt) : null;
    return c && c >= from && c <= to;
  }).length;
  const churnedInRange = all.filter((s) => {
    const c = s.cancelledAt ? new Date(s.cancelledAt) : null;
    return c && c >= from && c <= to;
  }).length;

  const currency = market === "US" ? "USD" : market === "UK" ? "GBP" : "EUR";
  const arpu = activeAsOf.length > 0 ? mrr / activeAsOf.length : null;
  const churnRate =
    activeAsOf.length + churnedInRange > 0
      ? +((churnedInRange / (activeAsOf.length + churnedInRange)) * 100).toFixed(1)
      : null;

  return {
    market,
    flag,
    platform: "loop",
    live: true,
    calcVersion: 4,
    rangeMode: true,
    mrr: Math.round(mrr),
    activeSubs: activeAsOf.length,
    totalFetched: all.length,
    newThisMonth: newInRange,
    churnedThisMonth: churnedInRange,
    arpu: arpu != null ? +arpu.toFixed(2) : null,
    churnRate,
    currency,
  };
}

export async function fetchLoopForRange(fromIso: string, toIso: string) {
  return await fetchLoopFromDbForRange(fromIso, toIso);
}

// ─── Xero ────────────────────────────────────────────────────────────────────
//
// OAuth 2.0 Authorization Code flow — one-time browser auth, then refresh tokens
// Connect once:  GET /api/auth/xero  (redirects to Xero, stores tokens in Supabase)
// Token refresh: automatic via stored refresh_token (60-day TTL, rotated on each refresh)
//
// CONFIRMED WORKING: requires accounting.reports.read + accounting.transactions scopes

let __xeroLastTokenError: string | null = null;
export function getXeroLastTokenError() {
  return __xeroLastTokenError;
}

let __xeroTokenRefreshInFlight: Promise<string | null> | null = null;

function xeroTokenValidUntil(row: any, bufferMs = 2 * 60 * 1000) {
  const exp = row?.expires_at ? new Date(row.expires_at).getTime() : 0;
  return Number.isFinite(exp) && exp > Date.now() + bufferMs;
}

async function readXeroTokenRow() {
  const { data, error } = await serviceClient()
    .from("integrations")
    .select("access_token, refresh_token, expires_at, metadata, updated_at")
    .eq("provider", "xero")
    .maybeSingle();
  if (error) throw error;
  return data;
}

function getStoredXeroRefreshToken(row: any) {
  return row?.refresh_token ?? row?.metadata?.refresh_token ?? null;
}

async function useNewerXeroTokenIfAvailable(attemptedRefreshToken: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const latest = await readXeroTokenRow();
    const latestRefreshToken = getStoredXeroRefreshToken(latest);
    if (
      latest?.access_token &&
      latestRefreshToken &&
      latestRefreshToken !== attemptedRefreshToken &&
      xeroTokenValidUntil(latest)
    ) {
      console.warn("Xero refresh token was already rotated by another request; using the latest stored access token.");
      return latest.access_token as string;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

async function getXeroToken(): Promise<string | null> {
  __xeroLastTokenError = null;
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId) {
    __xeroLastTokenError = "XERO_CLIENT_ID not set in environment";
    return null;
  }
  if (!clientSecret) {
    __xeroLastTokenError = "XERO_CLIENT_SECRET not set in environment";
    return null;
  }

  // Load stored row from Supabase
  let row: any = null;
  try {
    row = await readXeroTokenRow();
  } catch (err: any) {
    __xeroLastTokenError = `Could not read Xero token from integrations: ${err?.message ?? String(err)}`;
    return null;
  }

  if (!row) {
    __xeroLastTokenError = "No Xero token row in integrations table — never connected";
    console.warn("Xero: no token stored — visit /api/auth/xero to connect");
    return null;
  }

  // Return cached access_token if still valid (2-min buffer)
  if (row.access_token && xeroTokenValidUntil(row)) {
    return row.access_token;
  }

  // Refresh using stored refresh_token
  const refreshToken = getStoredXeroRefreshToken(row);
  if (!refreshToken) {
    __xeroLastTokenError = `Access token expired at ${row.expires_at} and no refresh_token stored — must reconnect`;
    console.warn("Xero: access token expired and no refresh_token — reconnect via /api/auth/xero");
    return null;
  }

  if (__xeroTokenRefreshInFlight) {
    return await __xeroTokenRefreshInFlight;
  }

  const refreshPromise = (async () => {
    try {
      const creds =
        typeof Buffer !== "undefined"
          ? Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
          : btoa(`${clientId}:${clientSecret}`);
      const res = await fetch("https://identity.xero.com/connect/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${creds}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
        cache: "no-store",
      });

      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        if (res.status === 400 && body.includes("invalid_grant")) {
          const latestAccessToken = await useNewerXeroTokenIfAvailable(refreshToken);
          if (latestAccessToken) return latestAccessToken;
        }
        __xeroLastTokenError = `Token refresh failed (HTTP ${res.status}): ${body}`;
        console.error("Xero token refresh failed:", res.status, body);
        return null;
      }

      const { access_token, new_refresh, expires_in, refresh_token: rotated, scope } = await res.json();
      const finalRefresh = rotated ?? new_refresh ?? refreshToken;
      if (!access_token) {
        __xeroLastTokenError = "Token refresh returned no access_token";
        return null;
      }
      if (!rotated && !new_refresh) {
        console.warn("Xero token refresh response did not include a rotated refresh token; keeping the previous stored token.");
      }

      const expiresAt = new Date(Date.now() + ((expires_in ?? 1800) - 60) * 1000).toISOString();
      const { error: updateError } = await serviceClient()
        .from("integrations")
        .upsert(
          {
            provider: "xero",
            access_token,
            refresh_token: finalRefresh,
            expires_at: expiresAt,
            updated_at: new Date().toISOString(),
            metadata: { ...row.metadata, refresh_token: finalRefresh, refreshed_at: new Date().toISOString(), scope },
          },
          { onConflict: "provider" },
        );
      if (updateError) {
        __xeroLastTokenError = `Token refreshed, but saving the rotated token failed: ${updateError.message}`;
        console.error("Xero token save failed:", updateError.message);
        return null;
      }
      return access_token;
    } catch (err: any) {
      __xeroLastTokenError = `Token refresh exception: ${err?.message ?? String(err)}`;
      console.error("Xero token refresh error:", err.message);
      return null;
    }
  })();

  __xeroTokenRefreshInFlight = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (__xeroTokenRefreshInFlight === refreshPromise) __xeroTokenRefreshInFlight = null;
  }
}

async function getXeroTenantId(): Promise<string | null> {
  // tenantId is stored in metadata during the OAuth callback
  try {
    const { data, error } = await serviceClient()
      .from("integrations")
      .select("metadata")
      .eq("provider", "xero")
      .single();
    if (error) {
      console.error("Xero tenant lookup failed:", error.message);
      return null;
    }
    return (data?.metadata?.tenant_id as string) ?? null;
  } catch (err: any) {
    console.error("Xero tenant lookup exception:", err?.message ?? String(err));
    return null;
  }
}

function extractXeroError(body: string) {
  try {
    const json = JSON.parse(body);
    const message =
      json?.Detail ??
      json?.Message ??
      json?.ErrorNumber ??
      json?.error_description ??
      json?.error ??
      body;
    return typeof message === "string" ? message : JSON.stringify(message);
  } catch {
    return body;
  }
}

// Parse a numeric cell value from a Xero report
function xNum(cell: any): number {
  const raw = String(cell?.Value ?? "").trim();
  if (!raw || raw === "-") return 0;
  const negative = raw.startsWith("-") || /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[(), ]/g, "").replace(/^-/, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? (negative ? -Math.abs(n) : n) : 0;
}

// Walk report rows recursively. Returns the LAST SummaryRow under any section
// whose title contains the given fragment (case-insensitive). Xero balance
// sheets nest subsections (Bank → Current Assets → Fixed Assets) inside a
// parent "Assets" section whose grand total is the LAST SummaryRow — picking
// the first one would return a sub-total instead.
function xSectionTotal(rows: any[], titleFragment: string, colIdx = 1): number | null {
  const frag = titleFragment.toLowerCase();
  for (const row of rows) {
    const title = (row.Title ?? "").toLowerCase();
    if (row.RowType === "Section" && title.includes(frag)) {
      const findLastSummary = (rs: any[]): number | null => {
        let last: number | null = null;
        for (const r of rs) {
          if (r.RowType === "SummaryRow" && r.Cells?.[colIdx] != null) {
            last = xNum(r.Cells[colIdx]);
          }
          if (r.Rows) {
            const nested = findLastSummary(r.Rows);
            if (nested !== null) last = nested;
          }
        }
        return last;
      };
      const v = findLastSummary(row.Rows ?? []);
      if (v !== null) return v;
    }
    if (row.Rows) {
      const v = xSectionTotal(row.Rows, titleFragment, colIdx);
      if (v !== null) return v;
    }
  }
  return null;
}

// Find a Row (not SummaryRow) whose first cell title matches fragment.
// Used for Xero rows like "Total Assets", "Total Liabilities" that appear
// at top level outside any section.
function xRowByLabel(rows: any[], labelFragment: string, colIdx = 1): number | null {
  const frag = labelFragment.toLowerCase();
  for (const row of rows) {
    if (row.RowType === "Section" && row.Rows) {
      const v = xRowByLabel(row.Rows, labelFragment, colIdx);
      if (v !== null) return v;
    }
    if ((row.RowType === "Row" || row.RowType === "SummaryRow") && row.Cells?.length) {
      const label = String(row.Cells[0]?.Value ?? "").toLowerCase();
      if (label.includes(frag) && row.Cells[colIdx] != null) {
        return xNum(row.Cells[colIdx]);
      }
    }
  }
  return null;
}

function xRowsByLabels(rows: any[], fragments: string[], colIdx = 1) {
  const lowerFrags = fragments.map((f) => f.toLowerCase());
  const matches: { label: string; value: number }[] = [];
  const walk = (rs: any[]) => {
    for (const row of rs ?? []) {
      if ((row.RowType === "Row" || row.RowType === "SummaryRow") && row.Cells?.length) {
        const label = String(row.Cells[0]?.Value ?? "").trim();
        const lower = label.toLowerCase();
        if (label && lowerFrags.some((frag) => lower.includes(frag)) && row.Cells[colIdx] != null) {
          matches.push({ label, value: xNum(row.Cells[colIdx]) });
        }
      }
      if (row.Rows) walk(row.Rows);
    }
  };
  walk(rows);
  return matches;
}

export async function fetchXero() {
  const [token, tenantId] = await Promise.all([getXeroToken(), getXeroTenantId()]);
  if (!token) {
    const detail = getXeroLastTokenError();
    throw new Error(
      `Xero auth failed: ${detail ?? "no access token available"}. Reconnect at /api/auth/xero.`,
    );
  }
  if (!tenantId) {
    throw new Error(
      "Xero connected but no tenantId stored — reconnect via /api/auth/xero so the organization is recorded.",
    );
  }

  const h = {
    Authorization: `Bearer ${token}`,
    "Xero-tenant-id": tenantId,
    Accept: "application/json",
  };
  const BASE = "https://api.xero.com/api.xro/2.0";

  // 12 months back, monthly breakdown
  const fromDate = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 11);
    d.setDate(1);
    return d.toISOString().split("T")[0];
  })();
  const toDateStr = today();
  const monthStartStr = startOfMonth();
  const endpointErrors: string[] = [];

  // Xero rate limits: 60/min sustained AND 5/sec burst per tenant. Hitting
  // either returns 429 with a Retry-After header (seconds). The old code
  // fired 12 endpoints concurrently with no throttling and no retry — so
  // anything past the 5th request 429'd, invoice pagination died on page 1,
  // and the cache filled with partial data.
  //
  // This block adds three layers of protection:
  //   1. xeroFetch detects 429, sleeps Retry-After, retries up to 4 times.
  //   2. A semaphore caps concurrent in-flight Xero calls at 3 so we stay
  //      comfortably under the 5/sec burst even when callers fire many
  //      requests at once via Promise.allSettled.
  //   3. xeroFetchAllInvoicePages inserts a 250 ms gap between pages so a
  //      single big tenant doesn't burn the burst budget on its own.
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

  // Simple concurrency limiter — 3 in-flight max. Picked empirically: 5/sec
  // burst with ~250 ms average latency means 3 in-flight ≈ 12 req/sec peak,
  // but the per-call inter-page throttle and the per-second sliding window
  // keep us under 5/sec in practice.
  const MAX_INFLIGHT = 3;
  let inflight = 0;
  const queue: Array<() => void> = [];
  const acquire = async () => {
    if (inflight < MAX_INFLIGHT) {
      inflight++;
      return;
    }
    await new Promise<void>((res) => queue.push(res));
    inflight++;
  };
  const release = () => {
    inflight--;
    const next = queue.shift();
    if (next) next();
  };

  const xeroFetch = async (label: string, url: string): Promise<any> => {
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await acquire();
      let r: Response;
      try {
        r = await fetch(url, { headers: h, cache: "no-store" });
      } catch (err: any) {
        release();
        const detail = err?.message ?? String(err);
        endpointErrors.push(`${label} request failed: ${detail}`);
        console.error(`Xero ${label} fetch error:`, detail);
        return null;
      }
      release();

      if (r.status === 429) {
        // Xero sends Retry-After as integer seconds. Fall back to exponential
        // backoff (3s, 6s, 12s) if the header's missing or unparseable.
        const ra = parseInt(r.headers.get("retry-after") ?? "", 10);
        const waitSec = Number.isFinite(ra) && ra > 0 ? ra : 3 * 2 ** (attempt - 1);
        if (attempt < MAX_ATTEMPTS) {
          console.warn(`Xero ${label} 429 (attempt ${attempt}/${MAX_ATTEMPTS}) — sleeping ${waitSec}s before retry`);
          await sleep(waitSec * 1000);
          continue;
        }
        const detail = `rate-limited after ${MAX_ATTEMPTS} attempts (Retry-After=${r.headers.get("retry-after") ?? "absent"})`;
        endpointErrors.push(`${label} ${detail}`);
        console.error(`Xero ${label} 429: ${detail}`);
        return null;
      }
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        const detail = extractXeroError(body).slice(0, 300);
        endpointErrors.push(`${label} failed with HTTP ${r.status}: ${detail}`);
        console.error(`Xero ${label} ${r.status}: ${detail}`);
        return null;
      }
      return await r.json();
    }
    return null;
  };

  const xeroFetchAllInvoicePages = async (url: string) => {
    const invoices: any[] = [];
    let lastJson: any = null;
    for (let page = 1; page <= 50; page++) {
      // Small inter-page delay keeps us off the 5/sec burst threshold when a
      // tenant has lots of invoices. The retry inside xeroFetch absorbs the
      // odd 429 that still slips through.
      if (page > 1) await sleep(250);
      const pageUrl = `${url}${url.includes("?") ? "&" : "?"}page=${page}`;
      const json = await xeroFetch(`Invoices page ${page}`, pageUrl);
      if (!json) {
        // Hard failure (post-retry). Don't lose the pages we already
        // fetched — return what we have so far instead of bailing out
        // with null. Callers can still see partial data.
        if (invoices.length > 0 && lastJson) {
          console.warn(`Xero Invoices pagination stopped at page ${page} after retries exhausted; returning ${invoices.length} rows so far.`);
          return { ...lastJson, Invoices: invoices };
        }
        return null;
      }
      const pageInvoices: any[] = json.Invoices ?? [];
      invoices.push(...pageInvoices);
      lastJson = json;
      if (pageInvoices.length < 100) break;
    }
    return { ...lastJson, Invoices: invoices };
  };

  try {
    // Bank Transactions: last 90 days
    const bankTxSince = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 90);
      return d.toISOString().split("T")[0];
    })();
    const bankTxUrl = `${BASE}/BankTransactions?where=${encodeURIComponent(`Date>=DateTime(${bankTxSince.replaceAll("-", ",")})`)}`;

    const [
      plS,
      balS,
      cashS,
      invS,
      accS,
      billS,
      draftS,
      contactsS,
      itemsS,
      bankTxS,
      journalsS,
      trackingS,
    ] = await Promise.allSettled([
      // P&L: Xero docs require EITHER (fromDate + toDate) for a single column
      // OR (toDate + periods + timeframe) for multiple comparison columns.
      // Passing all four returns ambiguous columns — when the previous code
      // sent fromDate + toDate + periods + timeframe, Xero collapsed every
      // month's values into the toDate column, producing ~18× inflated
      // totals on the dashboard's latest-month tile. The correct multi-period
      // form omits fromDate and lets Xero derive it from periods + timeframe.
      // See https://developer.xero.com/documentation/api/accounting/reports
      xeroFetch(
        "P&L",
        `${BASE}/Reports/ProfitAndLoss?toDate=${toDateStr}&periods=11&timeframe=MONTH`,
      ),
      xeroFetch("BalanceSheet", `${BASE}/Reports/BalanceSheet?date=${toDateStr}`),
      xeroFetch(
        "BankSummary",
        `${BASE}/Reports/BankSummary?fromDate=${monthStartStr}&toDate=${toDateStr}`,
      ),
      xeroFetchAllInvoicePages(
        `${BASE}/Invoices?Statuses=AUTHORISED,SUBMITTED&where=${encodeURIComponent('Type=="ACCREC"')}`,
      ),
      // Full Chart of Accounts filtered to BANK type — gives every bank account
      // with its native CurrencyCode, even when balance is zero.
      xeroFetch("Accounts", `${BASE}/Accounts?where=${encodeURIComponent('Type=="BANK"')}`),
      // Bills to pay (ACCPAY)
      xeroFetchAllInvoicePages(
        `${BASE}/Invoices?Statuses=AUTHORISED,SUBMITTED&where=${encodeURIComponent('Type=="ACCPAY"')}`,
      ),
      // Draft invoices owed to you
      xeroFetchAllInvoicePages(
        `${BASE}/Invoices?Statuses=DRAFT&where=${encodeURIComponent('Type=="ACCREC"')}`,
      ),
      // Contacts (customers + suppliers)
      xeroFetch("Contacts", `${BASE}/Contacts?summaryOnly=true&page=1`),
      // Items / Products
      xeroFetch("Items", `${BASE}/Items`),
      // Bank Transactions (recent 90 days)
      xeroFetch("BankTransactions", bankTxUrl),
      // Manual Journals
      xeroFetch("ManualJournals", `${BASE}/ManualJournals`),
      // Tracking Categories
      xeroFetch("TrackingCategories", `${BASE}/TrackingCategories`),
    ]);

    const plData = plS.status === "fulfilled" ? plS.value : null;
    const balData = balS.status === "fulfilled" ? balS.value : null;
    const cashData = cashS.status === "fulfilled" ? cashS.value : null;
    const invData = invS.status === "fulfilled" ? invS.value : null;
    const accData = accS.status === "fulfilled" ? accS.value : null;
    const billData = billS.status === "fulfilled" ? billS.value : null;
    const draftData = draftS.status === "fulfilled" ? draftS.value : null;
    const contactsData = contactsS.status === "fulfilled" ? contactsS.value : null;
    const itemsData = itemsS.status === "fulfilled" ? itemsS.value : null;
    const bankTxData = bankTxS.status === "fulfilled" ? bankTxS.value : null;
    const journalsData = journalsS.status === "fulfilled" ? journalsS.value : null;
    const trackingData = trackingS.status === "fulfilled" ? trackingS.value : null;

    // ── Parse P&L report ─────────────────────────────────────────────────────
    const revenueByMonth: Record<string, number> = {};
    const expensesByMonth: Record<string, number> = {};
    const grossProfitByMonth: Record<string, number> = {};
    const netProfitByMonth: Record<string, number> = {};
    let ytdRevenue: number | null = null;
    let ytdExpenses: number | null = null;
    let ytdNetProfit: number | null = null;

    // OpEx breakdown buckets — populated below from P&L expense rows
    const opexBucketsX: Record<
      string,
      { ym: string; team: number; agencies: number; content: number; software: number; rent: number; other: number }
    > = {};
    // Per-month detail: opexDetailByMonthMapX[monthKey][category][accountName] = amount.
    // Per-month so the line-items table on the OpEx breakdown card reflects
    // only the currently-selected month, not the sum across every month
    // Xero returned. The "all-months" aggregate is rebuilt from this at the
    // end for callers that want the full-period view.
    const opexDetailByMonthMapX: Record<
      string,
      Record<string, Record<string, number>>
    > = {};
    const emptyCatMap = (): Record<string, Record<string, number>> => ({
      team: {}, agencies: {}, content: {}, software: {}, rent: {}, other: {},
    });
    // Separate tracker for Interest + Tax accounts so the P&L table's
    // Interest/Tax line populates on its own row instead of being silently
    // rolled into "Other OpEx". Keyed by month label ("May '26"); value is
    // the absolute sum of all matched accounts for that month.
    const interestTaxByMonthX: Record<string, number> = {};
    const interestTaxDetailByMonthX: Record<string, Record<string, number>> = {};
    // Accounts that belong on the "Interest / Tax" line below EBITDA in a
    // standard P&L. Three buckets of names are matched:
    //
    //   1. Interest expense / loan finance charges
    //   2. Corporate / income / VAT / withholding tax
    //   3. Non-operating financial items — FX gains/losses, bank revaluations,
    //      hedging gains/losses. These are technically "below the line" in
    //      most accounting frameworks (IFRS/GAAP), not operating expenses,
    //      so they belong on Interest/Tax rather than polluting "Other OpEx".
    //
    // Matched BEFORE the OpEx bucket classifier so these rows reach the
    // Interest/Tax tracker, not Team/Agencies/etc.
    const isInterestOrTax = (name: string): boolean => {
      const t = String(name ?? "").toLowerCase();
      if (!t) return false;
      return (
        // Interest
        /\b(interest|loan interest|bank interest|finance charges?|interest expense|rentelasten)\b/i.test(t) ||
        // Tax
        /\b(corporation tax|income tax|tax expense|withholding tax|deferred tax|provision for tax|belasting|winstbelasting|vennootschapsbelasting)\b/i.test(t) ||
        // Non-operating financial items (FX, bank revaluations)
        /\b(foreign currency|foreign exchange|forex|fx (gain|loss)|currency gain|currency loss|exchange gain|exchange loss|bank revaluation|hedging gain|hedging loss)\b/i.test(t) ||
        // Dutch
        /\b(financiele lasten|financiële lasten|valutaverschillen|koersverschillen)\b/i.test(t)
      );
    };

    const plReport = plData?.Reports?.[0];
    if (plReport) {
      const rows: any[] = plReport.Rows ?? [];
      const headerRow = rows.find((r: any) => r.RowType === "Header");
      // colLabels: ["", "Apr 25", "May 25", ..., "YTD"] OR just one period column
      const colLabels: string[] = (headerRow?.Cells ?? []).map((c: any) => String(c.Value ?? ""));
      const ytdCol = colLabels.findIndex((l) => /ytd/i.test(l));

      // Log column labels — first thing to inspect when monthly totals look
      // wrong. If two labels map to the same month-key we'd double-count;
      // the collision check below catches that case explicitly.
      console.info(`[xero] P&L returned ${colLabels.length} columns: ${JSON.stringify(colLabels)}`);

      // Convert Xero column header label like "Apr 25" → { mk:"Apr '25", ym:"2025-04" }
      const MONTHS_MAP: Record<string, string> = {
        jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
        jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
      };
      // Parse a Xero P&L column header label into our internal month key.
      // Xero returns different formats depending on the report query:
      //   timeframe=MONTH&periods=N → "May 26" / "May 2026"
      //   single-period fromDate→toDate → "31 May 26" / "31 May 2026"
      // The old regex required the label to start with a letter, so the
      // period-end-date form silently produced `null` for every column,
      // skipped every row, and left the OpEx breakdown empty no matter
      // how well the bucket classifier worked.
      const colLabelToMonth = (label: string): { mk: string; ym: string } | null => {
        const trimmed = String(label).trim();
        // Match "MMM YY/YYYY" anchored to end — handles both forms because
        // the optional leading "DD " can be anything in front of the letters.
        const m = /([A-Za-z]{3,9})\s+(\d{2}|\d{4})$/.exec(trimmed);
        if (!m) return null;
        const monAbbr = m[1].slice(0, 3);
        const mm = MONTHS_MAP[monAbbr.toLowerCase()];
        if (!mm) return null;
        const yr = m[2].length === 2 ? m[2] : m[2].slice(2);
        return {
          mk: `${monAbbr.charAt(0).toUpperCase() + monAbbr.slice(1).toLowerCase()} '${yr}`,
          ym: `20${yr}-${mm}`,
        };
      };

      // Collision guard: verify each column label maps to a UNIQUE month-key.
      // If two column labels resolve to the same month, every row's values
      // get summed into that bucket twice, producing the ~18× inflation we
      // saw before fixing the URL. Warning here makes future regressions
      // loud instead of silent.
      const monthKeyByCol: Record<string, number> = {};
      colLabels.forEach((label, idx) => {
        if (idx === 0 || idx === ytdCol || !label) return;
        const parsed = colLabelToMonth(label);
        if (!parsed) return;
        if (monthKeyByCol[parsed.mk] !== undefined) {
          console.warn(
            `[xero] P&L column collision — both "${colLabels[monthKeyByCol[parsed.mk]]}" (col ${monthKeyByCol[parsed.mk]}) and "${label}" (col ${idx}) map to ${parsed.mk}. ` +
              `Values will double-count into that month. Check the URL params (don't combine fromDate with periods+timeframe).`,
          );
        } else {
          monthKeyByCol[parsed.mk] = idx;
        }
      });

      const extractCols = (cells: any[]): { byMonth: Record<string, number>; ytd: number } => {
        const byMonth: Record<string, number> = {};
        let ytd = 0;
        cells.forEach((cell: any, i: number) => {
          if (i === 0) return;
          if (i === ytdCol) {
            ytd = xNum(cell);
            return;
          }
          const label = colLabels[i];
          if (label) byMonth[label] = xNum(cell);
        });
        // If no YTD column, sum the monthly values as YTD
        if (ytdCol === -1) ytd = Object.values(byMonth).reduce((s, v) => s + v, 0);
        return { byMonth, ytd };
      };

      // Recursively walk every Section, classifying by title & accumulating values.
      // Xero P&L structure varies: some orgs use "Income"+"Less Operating Expenses",
      // others "Trading Income"+"Less Cost of Sales"+"Gross Profit"+"Less Operating Expenses".
      // We accept any of those and use the LAST SummaryRow as the section total.
      const walk = (sections: any[]) => {
        for (const section of sections) {
          if (section.RowType !== "Section") continue;
          const title = (section.Title ?? "").toLowerCase();
          const subRows: any[] = section.Rows ?? [];
          // Find LAST summary row of this section (Xero puts subsection totals first)
          let summaryRow: any = null;
          for (const r of subRows) {
            if (r.RowType === "SummaryRow") summaryRow = r;
          }

          if (summaryRow) {
            const { byMonth, ytd } = extractCols(summaryRow.Cells ?? []);

            const isRevenue =
              title.includes("income") ||
              title.includes("revenue") ||
              title.includes("turnover") ||
              title.includes("sales");
            const isCogs =
              title.includes("cost of sales") ||
              title.includes("cost of goods") ||
              title.includes("cogs");
            const isGross = title.includes("gross profit") || title.includes("gross margin");
            // Matches English + Dutch expense section titles. Same logic the
            // OpEx breakdown scanner uses below — keeping them in lockstep
            // means YTD expense totals and per-bucket totals come from the
            // same set of sections.
            const isExpense =
              /\b(operating expense|less operating|overhead|administrative|expense|expenses)\b/.test(title) &&
              !/(non[ -]operating|other income|finance income)/.test(title) ||
              /\b(bedrijfslasten|bedrijfskosten|operationele kosten|exploitatiekosten)\b/.test(title);
            const isNet =
              title.includes("net profit") ||
              title.includes("net loss") ||
              title.includes("profit for") ||
              title.includes("net income");

            if (isRevenue && !isGross && !isNet) {
              Object.entries(byMonth).forEach(([m, v]) => {
                revenueByMonth[m] = (revenueByMonth[m] ?? 0) + v;
              });
              ytdRevenue = (ytdRevenue ?? 0) + ytd;
            } else if (isGross) {
              Object.entries(byMonth).forEach(([m, v]) => {
                grossProfitByMonth[m] = v;
              });
            } else if (isCogs || isExpense) {
              Object.entries(byMonth).forEach(([m, v]) => {
                expensesByMonth[m] = (expensesByMonth[m] ?? 0) + v;
              });
              ytdExpenses = (ytdExpenses ?? 0) + ytd;
            } else if (isNet) {
              Object.entries(byMonth).forEach(([m, v]) => {
                netProfitByMonth[m] = v;
              });
              ytdNetProfit = ytd;
            }
          }

          // Some Xero orgs put "Net Profit" as a top-level Row (not Section)
          // — so also scan child rows recursively.
          walk(subRows);
        }

        // Also scan top-level Rows for "Net Profit" / "Total Income" labels
        for (const r of sections) {
          if (r.RowType === "Row" && r.Cells?.length) {
            const label = String(r.Cells[0]?.Value ?? "").toLowerCase();
            if (label.includes("net profit") || label.includes("net income")) {
              const { byMonth, ytd } = extractCols(r.Cells);
              Object.entries(byMonth).forEach(([m, v]) => {
                netProfitByMonth[m] = v;
              });
              if (ytdNetProfit === null) ytdNetProfit = ytd;
            }
          }
        }
      };
      walk(rows);

      // ── OpEx breakdown: scan expense Section detail rows per month ──────
      //
      // Title patterns that mark a section as containing operating expenses.
      // Covers English (Xero default), Dutch (NL orgs / Jortt-mirrored CoA),
      // and common deviations. Kept permissive — false positives just send
      // expenses into the right bucket via the row-level keyword classifier,
      // false negatives leave the whole breakdown empty.
      const isExpenseSectionTitle = (title: string): boolean => {
        const t = String(title ?? "").toLowerCase().trim();
        if (!t) return false;
        if (/(non[ -]operating|other income|finance income)/.test(t)) return false;
        return (
          /\b(operating expense|less operating|overhead|administrative|expense|expenses)\b/.test(t) ||
          /\b(cost of sales|cost of goods|cogs)\b/.test(t) ||
          // Dutch
          /\b(bedrijfslasten|bedrijfskosten|operationele kosten|exploitatiekosten|lasten|kosten)\b/.test(t)
        );
      };

      // Tracks every (lower-cased) account name we've already counted, so the
      // unconditional second-pass walker can re-scan the whole P&L without
      // double-billing rows the section-aware first pass already caught.
      const seenExpenseAccounts = new Set<string>();

      // Add a single account-row's monthly amounts into the OpEx buckets,
      // classifying by row label via the (English/Dutch) keyword dictionary.
      // Interest/Tax accounts are split out into a separate tracker so they
      // surface on the P&L table's Interest/Tax line instead of silently
      // inflating "Other OpEx".
      // Returns true when the row contributed (so the caller can track stats).
      const addExpenseRow = (row: any): boolean => {
        if (row.RowType !== "Row" || !Array.isArray(row.Cells) || row.Cells.length < 2) return false;
        const accountName = String(row.Cells[0]?.Value ?? "").trim();
        if (!accountName) return false;
        const seenKey = accountName.toLowerCase();
        if (seenExpenseAccounts.has(seenKey)) return false;
        const isIntTax = isInterestOrTax(accountName);
        const cat = isIntTax ? null : bucketFromKeywords(accountName);
        let added = false;
        for (let i = 1; i < row.Cells.length; i++) {
          if (i === ytdCol) continue;
          const label = colLabels[i];
          if (!label) continue;
          const parsed = colLabelToMonth(label);
          if (!parsed) continue;
          const v = xNum(row.Cells[i]);
          if (!Number.isFinite(v) || v === 0) continue;
          // Use the SIGNED value so credit-balance OpEx rows (FX gains,
          // bank revaluations, refunds posted into the expense section)
          // net against the rest of the expenses — matching Xero's own
          // "Total Operating Expenses" math. Previously this was
          // Math.abs(v), which flipped a -€3,545 Bank Revaluation entry
          // to +€3,545 and over-counted total OpEx by 2× the absolute
          // value of every credit-balance row in the expense section.
          const amt = v;
          // Interest/Tax: book into its own per-month bucket and skip the
          // OpEx buckets entirely so it doesn't pollute Team/Agencies/etc.
          if (isIntTax) {
            interestTaxByMonthX[parsed.mk] = (interestTaxByMonthX[parsed.mk] ?? 0) + amt;
            if (!interestTaxDetailByMonthX[parsed.mk]) interestTaxDetailByMonthX[parsed.mk] = {};
            const itemKey = accountName.slice(0, 80);
            interestTaxDetailByMonthX[parsed.mk][itemKey] =
              (interestTaxDetailByMonthX[parsed.mk][itemKey] ?? 0) + amt;
            added = true;
            continue;
          }
          if (!opexBucketsX[parsed.mk]) {
            opexBucketsX[parsed.mk] = { ym: parsed.ym, team: 0, agencies: 0, content: 0, software: 0, rent: 0, other: 0 };
          }
          (opexBucketsX[parsed.mk] as any)[cat] += amt;
          if (!opexDetailByMonthMapX[parsed.mk]) opexDetailByMonthMapX[parsed.mk] = emptyCatMap();
          const itemKey = accountName.slice(0, 80);
          opexDetailByMonthMapX[parsed.mk][cat][itemKey] =
            (opexDetailByMonthMapX[parsed.mk][cat][itemKey] ?? 0) + amt;
          added = true;
        }
        if (added) seenExpenseAccounts.add(seenKey);
        return added;
      };

      // Walk every descendant Row inside a node. Critical: once we're "inside"
      // an expense section, we DO NOT re-check titles on sub-sections like
      // "Personnel" / "Marketing" — those wouldn't match the expense pattern
      // themselves, but their leaf rows are still expense accounts.
      const walkAllRows = (node: any) => {
        if (!node) return;
        if (node.RowType === "Row") {
          addExpenseRow(node);
          return;
        }
        if (Array.isArray(node.Rows)) {
          for (const child of node.Rows) walkAllRows(child);
        }
      };

      const scanExpenseSections = (sections: any[]) => {
        for (const section of sections ?? []) {
          if (section.RowType !== "Section") continue;
          if (isExpenseSectionTitle(section.Title)) {
            // Found an expense subtree — drain every leaf account row, no
            // matter how many sub-sections deep they live.
            for (const child of section.Rows ?? []) walkAllRows(child);
            continue;
          }
          // Keep searching deeper in case the expense section is nested.
          if (Array.isArray(section.Rows)) scanExpenseSections(section.Rows);
        }
      };
      scanExpenseSections(rows);

      // ── Second-pass: keyword-walk every remaining P&L row.
      //
      // Runs UNCONDITIONALLY (not just when the section scan was empty),
      // because the most common failure mode is "section scan caught some
      // rows but missed others nested under un-flagged sub-sections." The
      // seenExpenseAccounts set we populated in addExpenseRow guarantees we
      // never double-count anything the first pass already captured.
      //
      // Skips obvious non-expense labels (Income / Revenue / Gross / Net /
      // totals / opening-and-closing-balance) so we don't pull revenue rows
      // into OpEx by mistake.
      const isNonExpenseLabel = (label: string): boolean => {
        const t = label.toLowerCase().trim();
        if (!t) return true;
        return /(\btotal\b|\brevenue\b|\bincome\b|\bturnover\b|\bsales\b|\bgross|\bnet (profit|loss|income)|\bopbrengsten\b|\bomzet\b|\bopening balance|\bclosing balance)/.test(t);
      };

      const beforeAllRowWalk = Object.keys(opexBucketsX).length;
      const accountsBeforeAllRow = seenExpenseAccounts.size;

      const fallbackWalk = (node: any) => {
        if (!node) return;
        if (node.RowType === "Row" && Array.isArray(node.Cells) && node.Cells.length >= 2) {
          const accountName = String(node.Cells[0]?.Value ?? "").trim();
          if (accountName && !isNonExpenseLabel(accountName)) addExpenseRow(node);
          return;
        }
        if (Array.isArray(node.Rows)) {
          for (const child of node.Rows) fallbackWalk(child);
        }
      };
      for (const top of rows) fallbackWalk(top);

      const addedByAllRowWalk = seenExpenseAccounts.size - accountsBeforeAllRow;
      if (beforeAllRowWalk === 0 && Object.keys(opexBucketsX).length > 0) {
        console.warn(
          "[xero] OpEx section detector matched nothing; all rows came from the keyword fallback. Consider adding your CoA's expense section title to isExpenseSectionTitle().",
        );
      } else if (addedByAllRowWalk > 0) {
        console.info(
          `[xero] OpEx section scan covered the bulk; keyword fallback added ${addedByAllRowWalk} extra account(s) that lived outside recognized expense sections.`,
        );
      }

      // Fallback for Xero P&L variants where the Section title is blank or
      // generic, but the row label carries the useful name (e.g. "Total Income",
      // "Sales", "Turnover"). Prefer total/summary rows to avoid double-counting.
      if (Object.keys(revenueByMonth).length === 0) {
        const revenueTotals: any[][] = [];
        const revenueDetails: any[][] = [];
        const scanRevenueRows = (rs: any[]) => {
          for (const r of rs) {
            if ((r.RowType === "Row" || r.RowType === "SummaryRow") && r.Cells?.length) {
              const label = String(r.Cells[0]?.Value ?? "").toLowerCase();
              const looksRevenue =
                /(income|revenue|turnover|sales|fees)/i.test(label) &&
                !/(cost of sales|cost of goods|cogs|expense|gross|net|liabilit|asset|equity)/i.test(
                  label,
                );
              if (looksRevenue) {
                const isTotal = r.RowType === "SummaryRow" || /^total\b/i.test(label);
                (isTotal ? revenueTotals : revenueDetails).push(r.Cells);
              }
            }
            if (r.Rows) scanRevenueRows(r.Rows);
          }
        };
        scanRevenueRows(rows);

        const candidates =
          revenueTotals.length > 0 ? [revenueTotals[revenueTotals.length - 1]] : revenueDetails;
        for (const cells of candidates) {
          const { byMonth, ytd } = extractCols(cells);
          Object.entries(byMonth).forEach(([m, v]) => {
            revenueByMonth[m] = (revenueByMonth[m] ?? 0) + v;
          });
          ytdRevenue = (ytdRevenue ?? 0) + ytd;
        }
      }

      // If Xero returns a valid P&L with only costs/net profit for the period,
      // keep the month rows visible and treat missing revenue as zero rather
      // than failing the whole sync.
      if (Object.keys(revenueByMonth).length === 0) {
        const plMonths = new Set([
          ...Object.keys(expensesByMonth),
          ...Object.keys(grossProfitByMonth),
          ...Object.keys(netProfitByMonth),
        ]);
        if (plMonths.size > 0) {
          plMonths.forEach((m) => {
            revenueByMonth[m] = 0;
          });
          if (ytdRevenue === null) ytdRevenue = 0;
        }
      }

      // Fallback YTD calc if not picked up from a YTD column or section
      if (ytdRevenue === null && Object.keys(revenueByMonth).length > 0) {
        ytdRevenue = Object.values(revenueByMonth).reduce((s, v) => s + v, 0);
      }
      if (ytdExpenses === null && Object.keys(expensesByMonth).length > 0) {
        ytdExpenses = Object.values(expensesByMonth).reduce((s, v) => s + v, 0);
      }
      if (ytdNetProfit === null && Object.keys(netProfitByMonth).length > 0) {
        ytdNetProfit = Object.values(netProfitByMonth).reduce((s, v) => s + v, 0);
      }
    }

    // ── Diagnostics: collect labels actually present in the Xero reports ─────
    const collectLabels = (rs: any[], out: { sections: string[]; rows: string[] }) => {
      for (const r of rs ?? []) {
        if (r.RowType === "Section") {
          if (r.Title) out.sections.push(String(r.Title));
          if (r.Rows) collectLabels(r.Rows, out);
        } else if ((r.RowType === "Row" || r.RowType === "SummaryRow") && r.Cells?.length) {
          const lbl = String(r.Cells[0]?.Value ?? "").trim();
          if (lbl) out.rows.push(lbl);
        }
      }
    };
    const plLabels = { sections: [] as string[], rows: [] as string[] };
    const bsLabels = { sections: [] as string[], rows: [] as string[] };
    if (plReport) collectLabels(plReport.Rows ?? [], plLabels);

    // ── Parse Balance Sheet ───────────────────────────────────────────────────
    // Xero BS structure: top-level Sections "Assets", "Liabilities", "Equity"
    // each with nested subsections + a final SummaryRow that's the section total.
    // Some orgs also expose explicit "Total Assets" Row at top level.
    const balRows: any[] = balData?.Reports?.[0]?.Rows ?? [];
    collectLabels(balRows, bsLabels);
    // Track every lookup attempt for diagnostics: which label/section we tried,
    // and whether Xero returned a match. The UI can show this verbatim.
    const bsLookups: {
      field: string;
      query: string;
      type: "row" | "section";
      matched: boolean;
      value: number | null;
    }[] = [];
    const tryRow = (field: string, q: string) => {
      const v = xRowByLabel(balRows, q);
      bsLookups.push({ field, query: q, type: "row", matched: v !== null, value: v });
      return v;
    };
    const trySection = (field: string, q: string) => {
      const v = xSectionTotal(balRows, q);
      bsLookups.push({ field, query: q, type: "section", matched: v !== null, value: v });
      return v;
    };
    const totalAssets =
      tryRow("Total Assets", "total assets") ?? trySection("Total Assets", "assets");
    const currentAssets =
      trySection("Current Assets", "current assets") ??
      tryRow("Current Assets", "total current assets") ??
      // Some Xero orgs (especially small ones) expose only a top-level "Bank"
      // section instead of a "Current Assets" wrapper. Treat Total Bank as
      // current assets in that case.
      trySection("Current Assets", "bank") ??
      tryRow("Current Assets", "total bank");
    const fixedAssets =
      trySection("Fixed Assets", "fixed assets") ??
      trySection("Fixed Assets", "non-current assets") ??
      tryRow("Fixed Assets", "total fixed assets") ??
      tryRow("Fixed Assets", "total non-current assets");
    const parsedTotalLiabilities =
      tryRow("Total Liabilities", "total liabilities") ??
      tryRow("Total Liabilities", "total liability") ??
      trySection("Total Liabilities", "liabilities") ??
      trySection("Total Liabilities", "liability");
    const currentLiabilities =
      trySection("Current Liabilities", "current liabilities") ??
      trySection("Current Liabilities", "current liability") ??
      tryRow("Current Liabilities", "total current liabilities") ??
      tryRow("Current Liabilities", "total current liability");
    const parsedEquity =
      tryRow("Equity", "total equity") ??
      tryRow("Equity", "total capital") ??
      tryRow("Equity", "net assets") ??
      trySection("Equity", "equity") ??
      trySection("Equity", "capital") ??
      trySection("Equity", "net assets");
    const arBalanceRows = xRowsByLabels(balRows, [
      "accounts receivable",
      "trade debtors",
      "debtors",
    ]);
    const arBalance =
      arBalanceRows.length > 0 ? arBalanceRows[arBalanceRows.length - 1].value : null;

    // Detect whether Xero returned ANY liabilities section/row at all.
    // If Assets and Equity are present but liabilities are entirely absent,
    // this org legitimately has no liabilities — treat as 0 instead of failing.
    const hasLiabilitiesSection =
      bsLabels.sections.some((s) => /liabilit/i.test(s)) ||
      bsLabels.rows.some((r) => /liabilit/i.test(r));

    const derivedCurrentAssets =
      currentAssets ??
      (totalAssets !== null && fixedAssets !== null ? totalAssets - fixedAssets : null);
    const derivedFixedAssets =
      fixedAssets ??
      (totalAssets !== null && currentAssets !== null ? totalAssets - currentAssets : null);
    const totalLiabilities =
      parsedTotalLiabilities ??
      (totalAssets !== null && parsedEquity !== null ? totalAssets - parsedEquity : null) ??
      (!hasLiabilitiesSection && (totalAssets !== null || parsedEquity !== null) ? 0 : null);
    const equity =
      parsedEquity ??
      (totalAssets !== null && totalLiabilities !== null ? totalAssets - totalLiabilities : null);
    const derivedCurrentLiabilities =
      currentLiabilities ?? (totalLiabilities !== null ? totalLiabilities : null);

    // ── Parse Bank Summary + full Accounts list ──────────────────────────────
    // 1) Build a base list from /Accounts (every BANK account, with currency,
    //    even if balance is zero). 2) Overlay balances parsed from BankSummary
    //    when available. This mirrors what the Xero dashboard shows.
    type BankAcct = {
      name: string;
      balance: number;
      currency: string;
      accountId?: string;
      code?: string;
      bankAccountNumber?: string;
      status?: string;
    };
    const acctsList: any[] = accData?.Accounts ?? [];
    const bankAccountsMap = new Map<string, BankAcct>();
    for (const a of acctsList) {
      const name = String(a.Name ?? "").trim();
      if (!name) continue;
      bankAccountsMap.set(name.toLowerCase(), {
        name,
        balance: 0,
        currency: a.CurrencyCode ?? "EUR",
        accountId: a.AccountID,
        code: a.Code,
        bankAccountNumber: a.BankAccountNumber,
        status: a.Status,
      });
    }

    let cashBalance: number | null = null;
    const cashReport = cashData?.Reports?.[0];
    if (cashReport) {
      for (const section of cashReport.Rows ?? []) {
        if (section.RowType !== "Section") continue;
        for (const row of section.Rows ?? []) {
          if (row.RowType !== "Row" || !row.Cells?.length) continue;
          const name = String(row.Cells[0]?.Value ?? "").trim();
          const bal = xNum(row.Cells[row.Cells.length - 1]);
          if (!name || name === "Account") continue;
          const key = name.toLowerCase();
          const existing = bankAccountsMap.get(key);
          if (existing) {
            existing.balance = bal;
          } else {
            bankAccountsMap.set(key, { name, balance: bal, currency: "EUR" });
          }
          cashBalance = (cashBalance ?? 0) + bal;
        }
      }
    }
    const bankAccounts: BankAcct[] = Array.from(bankAccountsMap.values()).sort(
      (a, b) => Math.abs(b.balance) - Math.abs(a.balance),
    );

    // ── Parse Invoices (Accounts Receivable) ─────────────────────────────────
    const invoices: any[] = invData?.Invoices ?? [];
    const invoiceAccountsReceivable = invoices.reduce((s, inv) => s + (inv.AmountDue ?? 0), 0);
    const overdueInvoices = invoices.filter((inv) => inv.IsOverdue);
    const overdueAmount = overdueInvoices.reduce((s, inv) => s + (inv.AmountDue ?? 0), 0);
    const accountsReceivable = invoiceAccountsReceivable || arBalance || 0;

    // ── Parse Bills (Accounts Payable / ACCPAY) ──────────────────────────────
    const bills: any[] = billData?.Invoices ?? [];
    const billsAwaitingAmount = bills.reduce((s, b) => s + (b.AmountDue ?? 0), 0);
    const overdueBills = bills.filter((b) => b.IsOverdue);
    const overdueBillsAmount = overdueBills.reduce((s, b) => s + (b.AmountDue ?? 0), 0);

    // ── Parse Drafts (ACCREC) ────────────────────────────────────────────────
    const drafts: any[] = draftData?.Invoices ?? [];
    const draftsAmount = drafts.reduce((s, d) => s + (d.Total ?? d.AmountDue ?? 0), 0);

    // ── Parse Contacts ──────────────────────────────────────────────────────
    const contactsList: any[] = contactsData?.Contacts ?? [];
    const customers = contactsList
      .filter((c) => c.IsCustomer)
      .map((c) => ({
        id: c.ContactID,
        name: String(c.Name ?? ""),
        email: c.EmailAddress ?? null,
        outstanding: c.Balances?.AccountsReceivable?.Outstanding ?? 0,
        overdue: c.Balances?.AccountsReceivable?.Overdue ?? 0,
      }))
      .sort((a, b) => Math.abs(b.outstanding) - Math.abs(a.outstanding));
    const suppliers = contactsList
      .filter((c) => c.IsSupplier)
      .map((c) => ({
        id: c.ContactID,
        name: String(c.Name ?? ""),
        email: c.EmailAddress ?? null,
        outstanding: c.Balances?.AccountsPayable?.Outstanding ?? 0,
        overdue: c.Balances?.AccountsPayable?.Overdue ?? 0,
      }))
      .sort((a, b) => Math.abs(b.outstanding) - Math.abs(a.outstanding));

    // ── Parse Items ─────────────────────────────────────────────────────────
    const itemsList: any[] = itemsData?.Items ?? [];
    const items = itemsList.map((i) => ({
      id: i.ItemID,
      code: i.Code ?? "",
      name: String(i.Name ?? i.Description ?? ""),
      salesPrice: i.SalesDetails?.UnitPrice ?? null,
      purchasePrice: i.PurchaseDetails?.UnitPrice ?? null,
      isTracked: !!i.IsTrackedAsInventory,
      qtyOnHand: i.QuantityOnHand ?? null,
    }));

    // ── Parse Bank Transactions ─────────────────────────────────────────────
    const bankTxList: any[] = bankTxData?.BankTransactions ?? [];
    const bankTransactions = bankTxList
      .map((t) => ({
        id: t.BankTransactionID,
        date: t.DateString ?? t.Date ?? null,
        type: t.Type ?? "",
        contact: t.Contact?.Name ?? "",
        account: t.BankAccount?.Name ?? "",
        reference: t.Reference ?? "",
        total: t.Total ?? 0,
        currency: t.CurrencyCode ?? "EUR",
        status: t.Status ?? "",
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 100);

    // ── Parse Manual Journals ───────────────────────────────────────────────
    const journalsList: any[] = journalsData?.ManualJournals ?? [];
    const manualJournals = journalsList
      .map((j) => ({
        id: j.ManualJournalID,
        date: j.Date ?? null,
        narration: String(j.Narration ?? ""),
        status: j.Status ?? "",
        lineCount: (j.JournalLines ?? []).length,
        total:
          (j.JournalLines ?? []).reduce((s: number, l: any) => s + Math.abs(l.LineAmount ?? 0), 0) /
          2,
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 50);

    // ── Parse Tracking Categories ───────────────────────────────────────────
    const trackingList: any[] = trackingData?.TrackingCategories ?? [];
    const trackingCategories = trackingList.map((t) => ({
      id: t.TrackingCategoryID,
      name: String(t.Name ?? ""),
      status: t.Status ?? "",
      options: (t.Options ?? []).map((o: any) => ({
        id: o.TrackingOptionID,
        name: String(o.Name ?? ""),
        status: o.Status ?? "",
      })),
    }));

    // ── Finalize OpEx breakdown built from P&L expense rows ────────────────
    const sortedOpexMonths = Object.keys(opexBucketsX).sort(
      (a, b) => new Date(opexBucketsX[a].ym + "-01").getTime() - new Date(opexBucketsX[b].ym + "-01").getTime(),
    );
    const opexByMonth = sortedOpexMonths.map((m) => {
      const b = opexBucketsX[m];
      const total = b.team + b.agencies + b.content + b.software + b.rent + b.other;
      return { month: m, ...b, total };
    });

    // Interest/Tax per month — keyed by the same month label as opexByMonth
    // ("May '26"). Empty object when the org doesn't book interest/tax
    // accounts; the consumer falls back to dashes in that case.
    const interestTaxByMonth: Record<string, number> = {};
    for (const [mk, amt] of Object.entries(interestTaxByMonthX)) {
      interestTaxByMonth[mk] = Math.round(amt);
    }
    // Top items per month for diagnostic / UI tooltip
    const interestTaxItemsByMonth: Record<string, Array<{ name: string; amount: number }>> = {};
    for (const [mk, items] of Object.entries(interestTaxDetailByMonthX)) {
      interestTaxItemsByMonth[mk] = Object.entries(items)
        .map(([name, amount]) => ({ name, amount: Math.round(amount) }))
        .sort((a, b) => b.amount - a.amount);
    }
    const opexCatLabels: Record<string, string> = {
      team: "Team",
      agencies: "Agencies",
      content: "Content samenwerkingen",
      software: "Software",
      rent: "Rent & utilities",
      other: "Other costs",
    };
    // Top-25 items per (month, category) — drives the per-month line items
    // section on the OpEx breakdown card.
    type DetailItem = { name: string; amount: number; source?: string };
    type DetailCat = { label: string; items: DetailItem[] };
    const opexDetailByMonth: Record<string, Record<string, DetailCat>> = {};
    // Also fold into an all-months aggregate so callers that want a full-period
    // view (e.g. a future "all time" toggle) still have it without re-summing.
    const opexDetailAggregateMap: Record<string, Record<string, number>> = {
      team: {}, agencies: {}, content: {}, software: {}, rent: {}, other: {},
    };
    for (const mk of Object.keys(opexDetailByMonthMapX)) {
      const perCat: Record<string, DetailCat> = {};
      const byCat = opexDetailByMonthMapX[mk];
      for (const cat of Object.keys(byCat)) {
        const items = Object.entries(byCat[cat])
          .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100, source: "Xero" }))
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 25);
        perCat[cat] = { label: opexCatLabels[cat] ?? cat, items };
        // Fold into the all-months aggregate.
        for (const [name, amount] of Object.entries(byCat[cat])) {
          opexDetailAggregateMap[cat][name] = (opexDetailAggregateMap[cat][name] ?? 0) + amount;
        }
      }
      opexDetailByMonth[mk] = perCat;
    }
    const opexDetail: Record<string, DetailCat> = {};
    for (const cat of Object.keys(opexDetailAggregateMap)) {
      const items = Object.entries(opexDetailAggregateMap[cat])
        .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100, source: "Xero" }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 25);
      opexDetail[cat] = { label: opexCatLabels[cat] ?? cat, items };
    }

    const live =
      Object.keys(revenueByMonth).length > 0 || totalAssets !== null || cashBalance !== null;

    if (!live) {
      const reason = endpointErrors.length
        ? endpointErrors.slice(0, 4).join(" | ")
        : "Xero responded, but Profit & Loss, Balance Sheet, and Bank Summary contained no usable values.";
      throw new Error(
        `Xero sync returned no dashboard data. ${reason} Check that the connected organisation (${tenantId}) has data for the selected period and that these scopes are approved in the Xero app: accounting.invoices.read, accounting.banktransactions.read, accounting.manualjournals.read, accounting.contacts.read, accounting.settings.read, accounting.reports.profitandloss.read, accounting.reports.balancesheet.read, accounting.reports.banksummary.read.`,
      );
    }

    return {
      live,
      tenantId,
      revenueByMonth,
      expensesByMonth,
      grossProfitByMonth,
      netProfitByMonth,
      // OpEx breakdown sourced from Xero P&L expense rows
      opexByMonth,
      opexDetail,            // all-months aggregate (top-25 items per category)
      opexDetailByMonth,     // per-month detail — UI reads this for line items
      // Per-month Interest + Tax totals — separately tracked so the P&L
      // table's Interest/Tax line doesn't end up as silent zero when the
      // org has interest expense or tax accruals. Empty {} when not booked.
      interestTaxByMonth,
      interestTaxItemsByMonth,
      ytdRevenue: ytdRevenue !== null ? Math.round(ytdRevenue) : null,
      ytdExpenses: ytdExpenses !== null ? Math.round(ytdExpenses) : null,
      ytdNetProfit: ytdNetProfit !== null ? Math.round(ytdNetProfit) : null,
      totalAssets: totalAssets !== null ? Math.round(totalAssets) : null,
      currentAssets: derivedCurrentAssets !== null ? Math.round(derivedCurrentAssets) : null,
      fixedAssets: derivedFixedAssets !== null ? Math.round(derivedFixedAssets) : null,
      totalLiabilities: totalLiabilities !== null ? Math.round(totalLiabilities) : null,
      currentLiabilities:
        derivedCurrentLiabilities !== null ? Math.round(derivedCurrentLiabilities) : null,
      equity: equity !== null ? Math.round(equity) : null,
      cashBalance: cashBalance !== null ? Math.round(cashBalance) : null,
      bankAccounts,
      accountsReceivable: accountsReceivable > 0 ? Math.round(accountsReceivable) : null,
      unpaidInvoiceCount: invoices.length,
      overdueAmount: overdueAmount > 0 ? Math.round(overdueAmount) : null,
      overdueInvoiceCount: overdueInvoices.length,
      // Bills (ACCPAY)
      billsAwaitingAmount: billsAwaitingAmount > 0 ? Math.round(billsAwaitingAmount) : null,
      billsAwaitingCount: bills.length,
      overdueBillsAmount: overdueBillsAmount > 0 ? Math.round(overdueBillsAmount) : null,
      overdueBillsCount: overdueBills.length,
      // Drafts (ACCREC)
      draftsAmount: draftsAmount > 0 ? Math.round(draftsAmount) : null,
      draftsCount: drafts.length,
      // Extended Xero data
      customers,
      suppliers,
      items,
      bankTransactions,
      manualJournals,
      trackingCategories,
      currency: "EUR",
      _diagnostics: {
        profitAndLoss: {
          reportPresent: !!plReport,
          sectionTitles: plLabels.sections,
          rowLabels: plLabels.rows.slice(0, 80),
          parsedRevenueMonths: Object.keys(revenueByMonth),
          parsedExpenseMonths: Object.keys(expensesByMonth),
          parsedNetProfitMonths: Object.keys(netProfitByMonth),
          // Per-bucket OpEx totals so the empty-state UI can show where each
          // expense ended up (e.g. "rent: €0, software: €4,200, other: €15k"
          // → tells you "other" is too greedy or your CoA names look Dutch).
          opexBucketTotals: (() => {
            const totals: Record<string, number> = { team: 0, agencies: 0, content: 0, software: 0, rent: 0, other: 0 };
            for (const m of Object.values(opexBucketsX)) {
              totals.team += m.team;
              totals.agencies += m.agencies;
              totals.content += m.content;
              totals.software += m.software;
              totals.rent += m.rent;
              totals.other += m.other;
            }
            for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k]);
            return totals;
          })(),
          // Distinct account count per bucket — computed from the all-months
          // aggregate (a single account that appears in multiple months still
          // counts once).
          opexDetailItemCounts: Object.fromEntries(
            Object.entries(opexDetailAggregateMap).map(([cat, items]) => [cat, Object.keys(items).length]),
          ),
          // The top labels classified into each bucket (all-months aggregate).
          // Most useful one is `other` — when the card looks empty/skewed,
          // these are the row labels the keyword classifier didn't recognize.
          // Paste them back and I'll add them to XERO_KEYWORD_FALLBACK.
          opexTopItemsPerBucket: Object.fromEntries(
            Object.entries(opexDetailAggregateMap).map(([cat, items]) => [
              cat,
              Object.entries(items)
                .map(([name, amount]) => ({ name, amount: Math.round(amount) }))
                .sort((a, b) => b.amount - a.amount)
                .slice(0, 30),
            ]),
          ),
        },
        balanceSheet: {
          reportPresent: balRows.length > 0,
          sectionTitles: bsLabels.sections,
          rowLabels: bsLabels.rows.slice(0, 80),
          lookups: bsLookups,
          accountsReceivableRows: arBalanceRows,
        },
        bankSummary: {
          reportPresent: !!cashReport,
          accountsFromAccountsApi: acctsList.length,
          accountsFound: bankAccounts.map((b) => `${b.name} (${b.currency})`),
        },
        invoices: {
          endpointResponded: invData !== null,
          totalReturned: invoices.length,
          amountDueTotal: invoiceAccountsReceivable,
          billsReturned: bills.length,
          draftsReturned: drafts.length,
        },
      },
    };
  } catch (err: any) {
    console.error("Xero fetch error:", err.message);
    throw err;
  }
}

// ─── Jortt ───────────────────────────────────────────────────────────────────
//
// Full-scope Jortt integration — uses ALL scopes the OAuth client has access to.
// Per the Jortt docs (https://developer.jortt.nl/#scopes) the client_credentials
// flow supports these scopes (one token per scope, since multi-scope requests
// fail with invalid_scope):
//
//   invoices:read       customers:read      estimates:read
//   expenses:read       financing:read      organizations:read
//   payroll:read        reports:read
//
// Each scope is requested independently; scopes that fail are logged but don't
// abort the overall fetch. With expenses:read granted the OpEx breakdown is
// built from real purchase invoices instead of being empty.

const JORTT_BASE = "https://api.jortt.nl";
const JORTT_TOKEN_URL = "https://app.jortt.nl/oauth-provider/oauth/token";

const JORTT_ALL_SCOPES = [
  "invoices:read",
  "expenses:read",
  "reports:read",
  "customers:read",
  "financing:read",
  "organizations:read",
  "payroll:read",
  "estimates:read",
] as const;

// OpEx categorisation.
//
// Primary signal: Jortt's native ledger-account category (`category` /
// `ledger_account_category` on the account, e.g. `personeelskosten`,
// `huisvestingskosten`, `verkoopkosten`, `algemene_kosten`,
// `afschrijvingen`, `financiele_baten_lasten`). This is what Jortt itself
// uses to build its P&L, so matching it produces numbers that line up with
// Jortt's own reports.
//
// Fallback: Dutch account-number ranges (4xxx series for OpEx) when the
// category field is absent.
//
// Last resort: keyword match on description for items without a ledger
// account (rare — usually free-text expenses).
type OpExCat = "team" | "agencies" | "content" | "software" | "rent" | "other";

// Jortt category slug → bucket
const JORTT_LEDGER_CATEGORY_TO_BUCKET: Record<string, OpExCat> = {
  // personnel / payroll
  personeelskosten: "team",
  loonkosten: "team",
  salariskosten: "team",
  // housing / rent / utilities
  huisvestingskosten: "rent",
  // sales / marketing / agencies / content
  verkoopkosten: "agencies",
  marketingkosten: "agencies",
  reclamekosten: "agencies",
  // general / office / software typically lands here in Jortt
  algemene_kosten: "software",
  kantoorkosten: "software",
  autokosten: "other",
  afschrijvingen: "other",
  financiele_baten_lasten: "other",
  rentelasten: "other",
};

// Keyword fallback (only used when no ledger account info is available)
const JORTT_KEYWORD_FALLBACK: Record<string, OpExCat> = {
  personeel: "team",
  salaris: "team",
  loon: "team",
  freelance: "team",
  "management fee": "team",
  managementfee: "team",
  agency: "agencies",
  bureau: "agencies",
  marketing: "agencies",
  reclame: "agencies",
  ads: "agencies",
  content: "content",
  creator: "content",
  influencer: "content",
  samenwerking: "content",
  software: "software",
  saas: "software",
  klaviyo: "software",
  shopify: "software",
  "triple whale": "software",
  monday: "software",
  notion: "software",
  figma: "software",
  adobe: "software",
  google: "software",
  microsoft: "software",
  huur: "rent",
  rent: "rent",
  energie: "rent",
  internet: "rent",
  kantoor: "rent",
};

function bucketFromLedger(
  ledgerAcct: any | null | undefined,
): OpExCat | null {
  if (!ledgerAcct) return null;
  const catRaw =
    ledgerAcct.category ??
    ledgerAcct.ledger_account_category ??
    ledgerAcct.account_category ??
    "";
  const cat = String(catRaw).toLowerCase().replace(/[\s-]+/g, "_");
  if (cat && JORTT_LEDGER_CATEGORY_TO_BUCKET[cat]) {
    return JORTT_LEDGER_CATEGORY_TO_BUCKET[cat];
  }
  // Fall back to the Dutch 4xxx OpEx code ranges
  const code = String(ledgerAcct.code ?? ledgerAcct.number ?? "").trim();
  const num = parseInt(code, 10);
  if (Number.isFinite(num)) {
    if (num >= 4000 && num <= 4099) return "team";        // personnel
    if (num >= 4100 && num <= 4199) return "rent";        // housing
    if (num >= 4200 && num <= 4299) return "other";       // exploitation
    if (num >= 4300 && num <= 4399) return "other";       // depreciation
    if (num >= 4400 && num <= 4499) return "software";    // general / office
    if (num >= 4500 && num <= 4599) return "other";       // car / transport
    if (num >= 4600 && num <= 4699) return "agencies";    // selling / marketing
    if (num >= 4700 && num <= 4799) return "other";       // financial
  }
  return null;
}

// Xero P&L row-label classifier. Account names in Xero are free-form per
// org's Chart of Accounts, so we match a generous set of keywords for both
// English (Xero default) and Dutch (NL orgs).
//
// Order matters — entries higher in the list win when a label matches multiple
// patterns. Compound phrases first ("office rent" → rent, not software due to
// a stray "office software" entry); strong-signal single words last.
const XERO_KEYWORD_FALLBACK: Array<[RegExp, OpExCat]> = [
  // ── CONTENT (creators, influencers, partnerships) ───────────────────────
  // IMPORTANT: these must come BEFORE the TEAM rules below, because labels
  // like "Freelancers - Content & Creatives" contain both "freelance" (team)
  // and "content" (content). First-match-wins — content should win.
  [/\bfreelance(r|rs)?[\s-]*(?:[-–•:]|\bfor\b)?[\s]*(content|creative|creator|video|photo|copywrit|partnership|influencer|podcast|ugc)/i, "content"],
  [/\bcontent\b/i, "content"],
  [/\bcreators?\b/i, "content"],
  [/\bcreatives?\b/i, "content"],
  [/\binfluencers?\b/i, "content"],
  [/\bphotograph(y|er)\b/i, "content"],
  [/\bvideograph(y|er)\b/i, "content"],
  [/\bcopywrit(er|ing)\b/i, "content"],
  [/\bugc\b/i, "content"],
  [/\bpodcast\b/i, "content"],
  [/\bpartnerships?\b/i, "content"],
  [/\b(athlete|fighter|sponsor(ship)?)\b/i, "content"],
  [/\bsamenwerking\b/i, "content"],
  // ── AGENCIES (paid marketing) ───────────────────────────────────────────
  // Compound patterns first so "Marketing Agency Costs" wins over the broader
  // "marketing" rule lower down (both still → agencies, but it documents intent).
  [/\bmarketing agenc(y|ies)\b/i, "agencies"],
  [/\bmedia buying\b/i, "agencies"],
  [/\bpaid (social|search|media)\b/i, "agencies"],
  [/\b(meta|facebook|google|tiktok|pinterest|youtube|reddit|snap(chat)?|twitter|awin|bing|yahoo)\s*ads?\b/i, "agencies"],
  [/\bmarketing\b/i, "agencies"],
  [/\badvertising\b/i, "agencies"],
  [/\bads?\b/i, "agencies"],
  [/\bagenc(y|ies)\b/i, "agencies"],
  [/\bbureau\b/i, "agencies"],
  [/\breclame\b/i, "agencies"],
  // ── TEAM (payroll, contractors, customer support) ───────────────────────
  [/\bsalar(y|ies|is)\b/i, "team"],
  [/\bwages?\b/i, "team"],
  [/\bpayroll\b/i, "team"],
  [/\bremuneration\b/i, "team"],
  [/\bcompensation\b/i, "team"],
  [/\bpensions?\b/i, "team"],
  [/\bbonus(es)?\b/i, "team"],
  [/\bcontractor(s)?\b/i, "team"],
  [/\bfreelance(r|rs)?\b/i, "team"],
  [/\boutsourc(ed|ing) work\b/i, "team"],
  [/\bcustomer (service|services|support)\b/i, "team"],
  [/\bcs (team|support)\b/i, "team"],
  [/\b(staff|employee|employees|personnel|personeel)\b/i, "team"],
  [/\brecruitment\b/i, "team"],
  [/\btraining\b/i, "team"],
  [/\bmanagement fees?\b/i, "team"],
  [/\bdirector(s)? fees?\b/i, "team"],
  [/\bloon(kosten)?\b/i, "team"],
  [/\bsalariskosten\b/i, "team"],
  // ── SOFTWARE (SaaS subscriptions, hosting, licenses, platform costs) ────
  // "Shopify Costs", "Software & Tools" — the user's actual CoA labels.
  [/\bshopify\s*(costs?|fees?|charges?|expense|expenses)?\b/i, "software"],
  [/\bsoftware\b/i, "software"],
  [/\btools?\b/i, "software"],
  [/\bsubscriptions?\b/i, "software"],
  [/\bsaas\b/i, "software"],
  [/\blicens(e|es|ing|ies)\b/i, "software"],
  [/\bhosting\b/i, "software"],
  [/\bcloud\b/i, "software"],
  [/\b(klaviyo|triple whale|monday|notion|figma|adobe|slack|github|vercel|netlify|supabase|cloudflare|aws|gcp|azure|microsoft|openai|anthropic|sentry|datadog|segment|mailchimp|intercom|postmark|sendgrid|recharge|loop|juo|picqer)\b/i, "software"],
  [/\bgoogle (workspace|cloud)\b/i, "software"],
  // ── RENT & UTILITIES (office / housing / utilities) ─────────────────────
  [/\boffice rent\b/i, "rent"],
  [/\brent\b/i, "rent"],
  [/\butilities\b/i, "rent"],
  [/\belectricity\b/i, "rent"],
  [/\b(gas|water) (bill|charge|service|supply)\b/i, "rent"],
  [/\bwifi\b/i, "rent"],
  [/\boffice (expenses?|costs?|supplies)\b/i, "rent"],
  [/\b(office|premises|building|facilit(y|ies))\b/i, "rent"],
  [/\bcleaning\b/i, "rent"],
  [/\b(huur|huisvesting|kantoor|energie)\b/i, "rent"],
];

function bucketFromKeywords(text: string): OpExCat {
  const t = String(text ?? "").trim();
  if (!t) return "other";
  for (const [re, cat] of XERO_KEYWORD_FALLBACK) {
    if (re.test(t)) return cat;
  }
  // Fall through to the older Dutch-leaning Jortt list as a last resort,
  // in case the Xero org uses a Jortt-mirrored Chart of Accounts.
  const lower = t.toLowerCase();
  for (const [kw, cat] of Object.entries(JORTT_KEYWORD_FALLBACK)) {
    if (lower.includes(kw)) return cat;
  }
  return "other";
}

function monthKey(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '");
}

function monthIsoKey(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Get an access_token for ONE scope (Jortt requires one scope per token).
async function getJorttTokenForScope(scope: string): Promise<string | null> {
  const clientId = process.env.JORTT_CLIENT_ID;
  const clientSecret = process.env.JORTT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch(JORTT_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope }).toString(),
      cache: "no-store",
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`[Jortt] token (scope=${scope}) ${res.status}: ${err.slice(0, 160)}`);
      return null;
    }
    const json: any = await res.json();
    return json.access_token ?? null;
  } catch (err: any) {
    console.error(`[Jortt] token (scope=${scope}) failed:`, err.message);
    return null;
  }
}

// Page through a Jortt list endpoint with the given token. Stops on first
// non-OK response, error body, or empty page. Caps at maxPages to keep the
// per-request total inside the Worker time budget.
// Some Jortt endpoints are gated by paid plan tier or by OAuth scopes that
// our client wasn't granted (financing:read, organizations:read, etc.).
// Those return 404 on every sync and used to spam the logs even though the
// data was never being consumed. 404 here means "you don't have access" —
// structured "not available" rather than an actual error. We track which
// paths have already 404'd so the first occurrence logs at debug level
// (silent in normal runs) and subsequent ones don't log at all.
const jorttSilenced404s = new Set<string>();
function jorttHandle404(path: string): void {
  if (!jorttSilenced404s.has(path)) {
    jorttSilenced404s.add(path);
    // First time we hit a 404 on this endpoint — note it once at debug so
    // it's discoverable if someone enables verbose logging.
    console.debug(`[Jortt] ${path}: 404 (scope/plan gated — silenced for the rest of this process)`);
  }
}

async function jorttPaginate(token: string, path: string, maxPages = 20): Promise<any[]> {
  const out: any[] = [];
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  for (let p = 1; p <= maxPages; p++) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${JORTT_BASE}${path}${sep}per_page=100&page=${p}`;
    try {
      const r = await fetch(url, { headers, cache: "no-store" });
      if (!r.ok) {
        if (r.status === 404) jorttHandle404(path);
        else console.warn(`[Jortt] ${path} p${p}: ${r.status}`);
        break;
      }
      const j: any = await r.json();
      if (j?.error) {
        console.warn(`[Jortt] ${path} p${p} error:`, j.error?.key ?? j.error?.message);
        break;
      }
      const batch: any[] = j?.data ?? [];
      out.push(...batch);
      if (batch.length < 100) break;
    } catch (err: any) {
      console.warn(`[Jortt] ${path} p${p} fetch failed:`, err.message);
      break;
    }
  }
  return out;
}

async function jorttGet(token: string, path: string): Promise<any | null> {
  try {
    const r = await fetch(`${JORTT_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) {
      if (r.status === 404) jorttHandle404(path);
      else console.warn(`[Jortt] GET ${path}: ${r.status}`);
      return null;
    }
    const j: any = await r.json();
    if (j?.error) return null;
    return j;
  } catch (err: any) {
    console.warn(`[Jortt] GET ${path} failed:`, err.message);
    return null;
  }
}

export async function fetchJortt() {
  // 1. Validate every scope up-front and remember which ones we got.
  // We grab tokens in parallel — Jortt's token endpoint is independent per scope
  // (and we serialise all reads under each token before requesting the next).
  const scopeResults = await Promise.all(
    JORTT_ALL_SCOPES.map(async (scope) => ({
      scope,
      token: await getJorttTokenForScope(scope),
    })),
  );
  const tokens: Record<string, string | null> = Object.fromEntries(
    scopeResults.map(({ scope, token }) => [scope, token]),
  );
  const grantedScopes = scopeResults.filter((s) => s.token).map((s) => s.scope);

  console.log(
    `[Jortt] granted scopes (${grantedScopes.length}/${JORTT_ALL_SCOPES.length}):`,
    grantedScopes.join(", ") || "(none)",
  );

  if (grantedScopes.length === 0) return null;

  // 2. Invoices (revenue, AR, invoice list) — invoices:read
  let invoices: any[] = [];
  let unpaidInvoices: any[] = [];
  if (tokens["invoices:read"]) {
    const t = tokens["invoices:read"]!;
    invoices = await jorttPaginate(t, "/v1/invoices?invoice_status=sent", 10);
    unpaidInvoices = await jorttPaginate(t, "/v1/invoices?invoice_status=unpaid", 5);
  }

  // 3. Expenses (real OpEx) — expenses:read (v3 endpoint)
  let expenses: any[] = [];
  if (tokens["expenses:read"]) {
    expenses = await jorttPaginate(tokens["expenses:read"]!, "/v3/expenses", 20);
  }

  // 4. Reports — reports:read
  let plRes: any = null,
    cashRes: any = null,
    balanceRes: any = null,
    btwRes: any = null,
    dashInvRes: any = null;
  if (tokens["reports:read"]) {
    const t = tokens["reports:read"]!;
    plRes = await jorttGet(t, "/v1/reports/summaries/profit_and_loss");
    cashRes = await jorttGet(t, "/v1/reports/summaries/cash_and_bank");
    balanceRes = await jorttGet(t, "/v1/reports/summaries/balance");
    btwRes = await jorttGet(t, "/v1/reports/summaries/btw");
    dashInvRes = await jorttGet(t, "/v1/reports/summaries/invoices");
  }

  // 5. Customers — customers:read
  let customers: any[] = [];
  if (tokens["customers:read"]) {
    customers = await jorttPaginate(tokens["customers:read"]!, "/v1/customers", 10);
  }

  // 6. Bank accounts + transactions — financing:read (v3)
  let bankAccounts: any[] = [];
  const bankTransactions: any[] = [];
  if (tokens["financing:read"]) {
    const t = tokens["financing:read"]!;
    bankAccounts = await jorttPaginate(t, "/v3/bank_accounts", 5);
    // Pull recent transactions per bank account (cap totals for speed)
    for (const acct of bankAccounts.slice(0, 5)) {
      const id = acct?.id;
      if (!id) continue;
      const tx = await jorttPaginate(t, `/v3/bank_accounts/${id}/transactions`, 5);
      bankTransactions.push(...tx.map((x: any) => ({ ...x, _bank_account_id: id })));
    }
  }

  // 7. Organization + tradenames + ledger accounts + labels — organizations:read
  let organization: any = null;
  let tradenames: any[] = [];
  let ledgerAccounts: any[] = [];
  let labels: any[] = [];
  if (tokens["organizations:read"]) {
    const t = tokens["organizations:read"]!;
    organization = await jorttGet(t, "/v1/organizations");
    tradenames = await jorttPaginate(t, "/v1/tradenames", 3);
    // Pull ledger accounts from BOTH the invoices and expenses endpoints so
    // we get a full id→category map (Jortt splits them by intent).
    const [invLedgers, expLedgers] = await Promise.all([
      jorttPaginate(t, "/v1/ledger_accounts/invoices", 5),
      jorttPaginate(t, "/v1/ledger_accounts/expenses", 10),
    ]);
    const seen = new Set<string>();
    ledgerAccounts = [...invLedgers, ...expLedgers].filter((l: any) => {
      const id = String(l?.id ?? "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    labels = await jorttPaginate(t, "/v1/labels", 3);
  }

  // 8. Payroll — payroll:read
  let payroll: any[] = [];
  if (tokens["payroll:read"]) {
    payroll = await jorttPaginate(tokens["payroll:read"]!, "/v1/loonjournaalposten", 10);
  }

  // 9. Estimates — estimates:read
  let estimates: any[] = [];
  if (tokens["estimates:read"]) {
    estimates = await jorttPaginate(tokens["estimates:read"]!, "/v2/estimates", 5);
  }

  // ── Aggregations ────────────────────────────────────────────────────────────

  // Revenue by month from invoices
  const revenueByMonth: Record<string, number> = {};
  for (const inv of invoices) {
    const mk = monthKey(inv.invoice_date ?? inv.created_at ?? "");
    if (!mk) continue;
    const total = parseFloat(inv.invoice_total_incl_vat?.value ?? inv.invoice_total?.value ?? "0");
    if (!Number.isFinite(total) || total <= 0) continue;
    revenueByMonth[mk] = (revenueByMonth[mk] ?? 0) + total;
  }

  // Expenses by month + OpEx breakdown from real expenses
  const expensesByMonth: Record<string, number> = {};
  // Interest / Tax — separate buckets keyed by ISO month "YYYY-MM"
  const interestByMonth: Record<string, number> = {};
  const taxByMonth: Record<string, number> = {};
  // monthKey -> { team, agencies, content, software, other }
  const opexBuckets: Record<
    string,
    {
      ym: string;
      team: number;
      agencies: number;
      content: number;
      software: number;
      rent: number;
      other: number;
    }
  > = {};
  // category -> name -> amount  (rolled-up detail items)
  const opexDetailMap: Record<string, Record<string, number>> = {
    team: {},
    agencies: {},
    content: {},
    software: {},
    rent: {},
    other: {},
  };

  // Build a fast id → ledger account map for category lookup.
  const ledgerById = new Map<string, any>();
  for (const la of ledgerAccounts) {
    if (la?.id) ledgerById.set(String(la.id), la);
  }

  for (const ex of expenses) {
    if (String(ex.expense_type ?? "").toLowerCase() !== "cost") continue;
    const dateStr = ex.vat_date ?? ex.delivery_period ?? ex.created_at ?? "";
    const mk = monthKey(dateStr);
    const ym = monthIsoKey(dateStr);
    if (!mk || !ym) continue;
    const amountStr =
      ex.raw_total_amount?.value ??
      ex.raw_total_amount?.amount ??
      ex.total_amount_incl_vat?.value ??
      ex.total_amount_incl_vat?.amount ??
      ex.total_amount?.value ??
      ex.total_amount?.amount ??
      ex.amount?.value ??
      ex.amount?.amount ??
      "0";
    const amount = Math.abs(parseFloat(String(amountStr)));
    if (!Number.isFinite(amount) || amount <= 0) continue;

    expensesByMonth[mk] = (expensesByMonth[mk] ?? 0) + amount;

    // Categorise: prefer Jortt's native ledger-account category, then
    // account-number ranges, then keyword fallback on description.
    const ledger =
      (ex.ledger_account_id && ledgerById.get(String(ex.ledger_account_id))) ||
      null;
    const ledgerName =
      ex.ledger_account_name ?? ledger?.name ?? "";
    const desc = ex.description ?? ex.supplier_name ?? ledgerName ?? "other";
    const haystack = `${desc} ${ledgerName}`.toLowerCase();
    const ledgerCode = String(ledger?.code ?? ledger?.number ?? "").trim();
    const ledgerNum = parseInt(ledgerCode, 10);

    // Interest detection (rente / interest / 47xx financial range)
    const isInterest =
      /\brente\b|interest|rentekosten|rentelasten/i.test(haystack) ||
      (Number.isFinite(ledgerNum) && ledgerNum >= 4700 && ledgerNum <= 4799);
    // Tax detection (vennootschapsbelasting / corporate income tax)
    const isTax =
      /vennootschapsbelasting|corporate tax|income tax|inkomstenbelasting/i.test(haystack);

    if (isInterest) {
      interestByMonth[ym] = (interestByMonth[ym] ?? 0) + amount;
      continue;
    }
    if (isTax) {
      taxByMonth[ym] = (taxByMonth[ym] ?? 0) + amount;
      continue;
    }

    const cat: OpExCat =
      bucketFromLedger(ledger) ?? bucketFromKeywords(haystack);

    if (!opexBuckets[mk])
      opexBuckets[mk] = { ym, team: 0, agencies: 0, content: 0, software: 0, rent: 0, other: 0 };
    opexBuckets[mk][cat] += amount;

    const itemName = (desc || "Unknown").trim().slice(0, 80);
    opexDetailMap[cat][itemName] = (opexDetailMap[cat][itemName] ?? 0) + amount;
  }

  // Payroll (loonjournaalposten) — Jortt's payroll posts are NOT included in
  // /v3/expenses, so add them to the team bucket explicitly. Each post has a
  // total gross/employer cost we can extract from common field shapes.
  for (const post of payroll) {
    const dateStr =
      post?.payment_date ??
      post?.period_end ??
      post?.period ??
      post?.date ??
      post?.created_at ??
      "";
    const mk = monthKey(dateStr);
    const ym = monthIsoKey(dateStr);
    if (!mk || !ym) continue;
    const amountStr =
      post?.total_employer_cost?.value ??
      post?.employer_cost?.value ??
      post?.total_amount?.value ??
      post?.gross_amount?.value ??
      post?.amount?.value ??
      post?.total ??
      post?.amount ??
      "0";
    const amount = Math.abs(parseFloat(String(amountStr)));
    if (!Number.isFinite(amount) || amount <= 0) continue;

    expensesByMonth[mk] = (expensesByMonth[mk] ?? 0) + amount;
    if (!opexBuckets[mk])
      opexBuckets[mk] = { ym, team: 0, agencies: 0, content: 0, software: 0, rent: 0, other: 0 };
    opexBuckets[mk].team += amount;

    const employee =
      post?.employee_name ??
      post?.employee?.name ??
      post?.description ??
      "Payroll";
    const itemName = `Payroll · ${String(employee).trim().slice(0, 70)}`;
    opexDetailMap.team[itemName] = (opexDetailMap.team[itemName] ?? 0) + amount;
  }

  // Sort months chronologically for opexByMonth
  const sortedMonths = Object.keys(opexBuckets).sort((a, b) => {
    const pa = new Date(a.replace(" '", " 20"));
    const pb = new Date(b.replace(" '", " 20"));
    return pa.getTime() - pb.getTime();
  });
  const opexByMonth = sortedMonths.map((m) => {
    const b = opexBuckets[m];
    const total = b.team + b.agencies + b.content + b.software + b.rent + b.other;
    return { month: m, ...b, total };
  });

  // opexDetail in shape consumed by OpExBreakdownSection
  const opexDetail: Record<
    string,
    { label: string; items: Array<{ name: string; amount: number }> }
  > = {};
  const catLabels: Record<string, string> = {
    team: "Team",
    agencies: "Agencies",
    content: "Content samenwerkingen",
    software: "Software",
    rent: "Rent & utilities",
    other: "Other costs",
  };
  for (const cat of Object.keys(opexDetailMap)) {
    const items = Object.entries(opexDetailMap[cat])
      .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 25);
    opexDetail[cat] = { label: catLabels[cat] ?? cat, items };
  }

  // AR + cash + P&L summary
  const accountsReceivable = unpaidInvoices.reduce((sum: number, inv: any) => {
    const v = parseFloat(inv.invoice_due_amount?.value ?? inv.invoice_total?.value ?? "0");
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);

  const cashBalance: number | null = (() => {
    if (cashRes) {
      const v = cashRes?.total_balance?.value ?? cashRes?.balance?.value ?? cashRes?.cash ?? null;
      if (v != null) {
        const n = parseFloat(String(v));
        if (Number.isFinite(n)) return n;
      }
    }
    // Fall back to summing live bank account balances
    if (bankAccounts.length > 0) {
      const sum = bankAccounts.reduce((s: number, a: any) => {
        const v = parseFloat(
          String(a?.current_balance?.value ?? a?.balance?.value ?? a?.balance ?? "0"),
        );
        return s + (Number.isFinite(v) ? v : 0);
      }, 0);
      return sum > 0 ? sum : null;
    }
    return null;
  })();

  const plSummary = plRes
    ? {
        revenue: parseFloat(plRes?.revenue?.value ?? plRes?.turnover?.value ?? "0"),
        costs: parseFloat(plRes?.costs?.value ?? plRes?.expenses?.value ?? "0"),
        grossProfit: parseFloat(plRes?.gross_profit?.value ?? plRes?.net_result?.value ?? "0"),
      }
    : null;

  const expenseCount = expenses.filter((e: any) => {
    const v = Math.abs(
      parseFloat(
        String(
          e.raw_total_amount?.value ??
            e.raw_total_amount?.amount ??
            e.total_amount_incl_vat?.value ??
            e.total_amount_incl_vat?.amount ??
            e.total_amount?.value ??
            e.total_amount?.amount ??
            "0",
        ),
      ),
    );
    return String(e.expense_type ?? "").toLowerCase() === "cost" && Number.isFinite(v) && v > 0;
  }).length;
  const invoiceCount = invoices.filter(
    (i: any) => parseFloat(i.invoice_total_incl_vat?.value ?? i.invoice_total?.value ?? "0") > 0,
  ).length;

  const live =
    Object.keys(revenueByMonth).length > 0 ||
    cashBalance !== null ||
    plSummary !== null ||
    invoices.length > 0 ||
    expenses.length > 0;

  return {
    // Core financials (consumed by FinanceDashboard)
    revenueByMonth,
    expensesByMonth,
    opexByMonth,
    interestByMonth,
    taxByMonth,
    opexDetail,
    cashBalance,
    accountsReceivable: accountsReceivable > 0 ? accountsReceivable : null,
    plSummary,
    balanceReport: balanceRes,
    unpaidInvoiceCount: unpaidInvoices.length,
    invoiceCount,
    expenseCount,
    live,

    // Extended data — available to any UI that wants to surface it
    bankAccounts,
    bankTransactionsCount: bankTransactions.length,
    customersCount: customers.length,
    customers: customers.slice(0, 50),
    organization,
    tradenames,
    ledgerAccountsCount: ledgerAccounts.length,
    labels,
    payrollCount: payroll.length,
    estimatesCount: estimates.length,
    btwSummary: btwRes,
    dashboardInvoices: dashInvRes,

    // Diagnostics — useful for the sync/debug screens
    grantedScopes,
    deniedScopes: JORTT_ALL_SCOPES.filter((s) => !tokens[s]),
  };
}

// ─── Shopify Repeat Purchase Funnel ──────────────────────────────────────────
// Pulls the last 5 years of orders for every Shopify store, builds per-customer
// order timelines, then computes cohort-based repeat rates (1st → 2nd → 3rd → 4th
// + 5th/6th/7th orders) and monthly cohort tables.
//
// Cohort definition: customers whose FIRST order falls in the cohort month.
// Repeat rate = % of cohort that placed an Nth order within the observation window.
// Slow first sync (multi-minute on big stores) — cached for 720 minutes.
export async function fetchShopifyRepeatFunnel() {
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
  if (!clientId) return null;

  // This is intentionally independent from the Overview page date filter.
  // Five years gives enough customer history to avoid marking old repeat buyers
  // as new first-time buyers in recent cohorts.
  const lookbackYears = 5;
  const lookbackDays = 365 * lookbackYears + 2;
  const sinceDate = daysAgoIso(lookbackDays);
  const since = `${sinceDate}T00:00:00Z`;

  // customerId → sorted list of observed order timestamps + Shopify's lifetime
  // order count. Lifetime count prevents a truncated lookback window from
  // pretending older customers are new first-time buyers.
  const customerOrders = new Map<string, { dates: string[]; lifetimeOrders: number }>();
  const storeCoverage: Array<{ code: string; pages: number; truncated: boolean; firstOrder: string | null; lastOrder: string | null }> = [];

  for (const { code, storeKey } of SHOPIFY_STORES) {
    const store = process.env[storeKey];
    if (!store) continue;
    const token = await getShopifyToken(store);
    if (!token) continue;

    let cursor: string | null = null;
    let hasNextPage = true;
    let page = 0;
    const maxPages = 1200; // up to ~300k orders per store over 5y (oldest-first so partial fetches still cover early cohorts)
    let firstOrder: string | null = null;
    let lastOrder: string | null = null;

    try {
      while (hasNextPage && page < maxPages) {
        const res: Response = await fetch(`https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
          body: JSON.stringify({ query: SHOPIFY_GQL_PAGE(since, cursor) }),
        });
        if (!res.ok) break;
        const json = await res.json();
        if (json.errors) {
          console.error(`Shopify repeat ${code} GQL:`, json.errors[0]?.message);
          break;
        }
        const pageData = json.data?.orders ?? {};
        const edges: any[] = pageData.edges ?? [];
        hasNextPage = pageData.pageInfo?.hasNextPage ?? false;
        cursor = pageData.pageInfo?.endCursor ?? null;
        page++;

        for (const { node: o } of edges) {
          const cid = o.customer?.id;
          if (!cid) continue;
          firstOrder = firstOrder ?? o.createdAt;
          lastOrder = o.createdAt;
          const lifetimeOrders = Number(o.customer?.numberOfOrders ?? 0) || 0;
          const entry = customerOrders.get(cid) ?? { dates: [], lifetimeOrders: 0 };
          entry.dates.push(o.createdAt);
          entry.lifetimeOrders = Math.max(entry.lifetimeOrders, lifetimeOrders, entry.dates.length);
          customerOrders.set(cid, entry);
        }
      }
    } catch (err: any) {
      console.error(`Shopify repeat ${code}:`, err?.message);
    }
    storeCoverage.push({ code, pages: page, truncated: hasNextPage, firstOrder, lastOrder });
  }

  if (customerOrders.size === 0) return null;

  // Sort each customer's observed order timeline ascending
  for (const entry of customerOrders.values()) entry.dates.sort();

  const now = Date.now();
  const DAY = 86_400_000;
  // Customers whose first recorded order is right at the dataset boundary
  // are almost certainly older customers with prior orders we can't see.
  const datasetEdgeTs = now - (lookbackDays - 10) * DAY;

  // Bucket by TRUE first-order month. The fixed 120–90 day cohort can be empty
  // when Shopify only has recent first-time buyers; picking the latest non-empty
  // cohort with at least 30 days of observation keeps the dashboard populated
  // with real, auditable Shopify customer history.
  const monthLabel = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '");
  const monthKeyFromDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const monthStartFromKey = (key: string) => {
    const [y, m] = key.split("-").map(Number);
    return new Date(y, (m ?? 1) - 1, 1);
  };

  const cohortBuckets = new Map<string, string[][]>(); // monthKey → array of customer order arrays
  for (const entry of customerOrders.values()) {
    const orders = entry.dates;
    if (orders.length === 0) continue;
    // If Shopify says the customer has more lifetime orders than we fetched in
    // the lookback, their first order is outside this dataset, so exclude them
    // from first-time-buyer cohorts instead of inflating recent cohort sizes.
    if (entry.lifetimeOrders > orders.length) continue;
    const first = new Date(orders[0]);
    if (first.getTime() <= datasetEdgeTs) continue;
    const key = monthKeyFromDate(first);
    if (!cohortBuckets.has(key)) cohortBuckets.set(key, []);
    cohortBuckets.get(key)!.push(orders);
  }

  // ── Repeat funnel from ALL first-time buyers (lifetime) ───────────────────
  // Computed across every customer in the Shopify dataset whose first order
  // falls inside our lookback window. This mirrors the order-frequency
  // distribution Shopify itself exposes — no maturity gating, no fallback to
  // Juo/Loop.
  const allCohortCandidates = Array.from(cohortBuckets.entries())
    .map(([key, orders]) => {
      const start = monthStartFromKey(key);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
      return { key, orders, start, end, daysSinceEnd: Math.floor((now - end.getTime()) / DAY) };
    })
    .filter((c) => c.orders.length > 0)
    .sort((a, b) => b.start.getTime() - a.start.getTime());

  // Lifetime headline = every Shopify customer across all 3 stores, bucketed
  // by their TRUE lifetime order count (customer.numberOfOrders from Shopify).
  // This mirrors what Shopify analytics shows as the order-frequency
  // distribution — independent of our 5-year fetch window.
  const reachedN = [0, 0, 0, 0, 0, 0, 0];
  let cohortSize = 0;
  for (const entry of customerOrders.values()) {
    const lifetime = Math.max(entry.lifetimeOrders, entry.dates.length);
    if (lifetime <= 0) continue;
    cohortSize++;
    const reached = Math.min(lifetime, 7);
    for (let i = 0; i < reached; i++) reachedN[i]++;
  }

  const funnel = reachedN.map((c, i) => ({
    order: i + 1,
    customers: c,
    rate: cohortSize > 0 ? +((c / cohortSize) * 100).toFixed(1) : null,
    maturing: false,
  }));

  // Newest cohort kept only for the "as of" label on the card.
  const selectedCohort = allCohortCandidates[0] ?? null;

  // ── Monthly cohort table — last 6 calendar months ───────────────────
  const monthlyCohorts: Array<{
    month: string;
    size: number;
    second: number | null;
    third: number | null;
    fourth: number | null;
    avgOrders: number | null;
    maturing: boolean;
  }> = [];

  // last 6 calendar months including current — ensures the oldest mature
  // cohort (>= 90 days observed) is visible alongside still-maturing months.
  const now2 = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now2.getFullYear(), now2.getMonth() - i, 1);
    const key = monthKeyFromDate(d);
    const cohort = cohortBuckets.get(key) ?? [];
    const size = cohort.length;
    const monthAge = i; // months ago (0 = current)
    // Need at least 30 days for 2nd-order and 90 days for 3rd/4th-order data.
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime();
    const daysSinceCohortEnd = (now - monthEnd) / DAY;
    const secondMatured = daysSinceCohortEnd >= 30;
    const deepMatured = daysSinceCohortEnd >= 90;
    const maturing = !deepMatured;

    if (size === 0) {
      monthlyCohorts.push({
        month: monthLabel(d) + (monthAge === 0 ? " (MTD)" : ""),
        size: 0,
        second: null,
        third: null,
        fourth: null,
        avgOrders: null,
        maturing,
      });
      continue;
    }

    let s2 = 0,
      s3 = 0,
      s4 = 0,
      totalOrders = 0;
    for (const orders of cohort) {
      if (orders.length >= 2) s2++;
      if (orders.length >= 3) s3++;
      if (orders.length >= 4) s4++;
      totalOrders += orders.length;
    }
    monthlyCohorts.push({
      month: monthLabel(d) + (monthAge === 0 ? " (MTD)" : ""),
      size,
      second: secondMatured ? +((s2 / size) * 100).toFixed(1) : null,
      third: deepMatured ? +((s3 / size) * 100).toFixed(1) : null,
      fourth: deepMatured ? +((s4 / size) * 100).toFixed(1) : null,
      avgOrders: secondMatured ? +(totalOrders / size).toFixed(2) : null,
      maturing,
    });
  }

  return {
    calcVersion: 6,
    sourceWindowDays: lookbackDays,
    sourceWindowYears: lookbackYears,
    sourceStart: sinceDate,
    sourceEnd: today(),
    storeCoverage,
    cohortSize,
    cohortMonth: selectedCohort ? monthLabel(selectedCohort.start) : null,
    cohortWindowDays: selectedCohort ? Math.max(0, selectedCohort.daysSinceEnd) : 0,
    cohortMatureForSecond: true,
    cohortMatureForThird: true,
    cohortStartedDaysAgo: selectedCohort
      ? Math.floor((now - selectedCohort.start.getTime()) / DAY)
      : 0,
    cohortEndedDaysAgo: selectedCohort ? selectedCohort.daysSinceEnd : 0,
    funnel,
    monthlyCohorts,
    totalCustomersAnalyzed: customerOrders.size,
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Shopify Payments — pending payouts per market ─────────────────────────
// Returns one row per store with the live pending balance + scheduled/in-transit
// payouts. Stores without Shopify Payments simply return live:false.
export async function fetchShopifyPayouts() {
  const results = await Promise.all(
    SHOPIFY_STORES.map(async (s) => {
      const store = process.env[s.storeKey];
      if (!store) return { market: s.code, name: s.name, live: false, reason: "store env not set" };
      const token = await getShopifyToken(store);
      if (!token) return { market: s.code, name: s.name, live: false, reason: "no token" };

      const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
      const base = `https://${store}/admin/api/${SHOPIFY_API_VERSION}/shopify_payments`;

      try {
        const [balRes, payRes] = await Promise.all([
          fetch(`${base}/balance.json`, { headers }),
          fetch(`${base}/payouts.json?status=scheduled&limit=50`, { headers }),
        ]);

        // 404 => store not on Shopify Payments
        if (balRes.status === 404) {
          return { market: s.code, name: s.name, live: false, reason: "Shopify Payments not enabled" };
        }
        if (!balRes.ok) {
          return { market: s.code, name: s.name, live: false, reason: `balance HTTP ${balRes.status}` };
        }

        const balJson: any = await balRes.json();
        const balances: Array<{ amount: string; currency: string }> = balJson?.balance ?? [];
        const pending = balances.reduce((s, b) => s + Number(b.amount || 0), 0);
        const currency = balances[0]?.currency ?? (s.code === "US" ? "USD" : s.code === "UK" ? "GBP" : "EUR");

        let scheduledTotal = 0;
        let nextPayoutDate: string | null = null;
        if (payRes.ok) {
          const pj: any = await payRes.json();
          const payouts: any[] = pj?.payouts ?? [];
          scheduledTotal = payouts.reduce((s, p) => s + Number(p.amount || 0), 0);
          const upcoming = payouts
            .map((p) => p.date)
            .filter(Boolean)
            .sort();
          nextPayoutDate = upcoming[0] ?? null;
        }

        return {
          market: s.code,
          name: `Shopify Payments ${s.code}`,
          live: true,
          currency,
          pendingBalance: pending,
          scheduledPayouts: scheduledTotal,
          nextPayoutDate,
        };
      } catch (err: any) {
        return { market: s.code, name: s.name, live: false, reason: err?.message ?? "fetch failed" };
      }
    }),
  );

  return { calcVersion: 1, fetchedAt: new Date().toISOString(), markets: results };
}

// ─── PayPal — pending balances (live) ─────────────────────────────────────
// Uses OAuth client_credentials to call /v1/reporting/balances. Requires the
// Reports scope on the PayPal REST app.
export async function fetchPaypalBalances() {
  const clientId = (process.env.PAYPAL_CLIENT_ID ?? "").trim();
  const secret = (process.env.PAYPAL_CLIENT_SECRET ?? "").trim();
  if (!clientId || !secret) {
    return { live: false, reason: "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set", accounts: [] };
  }
  const envPref = (process.env.PAYPAL_ENV ?? "live").toLowerCase();
  const bases = envPref === "sandbox"
    ? ["https://api-m.sandbox.paypal.com", "https://api-m.paypal.com"]
    : ["https://api-m.paypal.com", "https://api-m.sandbox.paypal.com"];
  let lastErr = "PayPal auth failed";
  for (const base of bases) {
    try {
      const tokRes = await fetch(`${base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      });
      if (!tokRes.ok) {
        const txt = await tokRes.text().catch(() => "");
        lastErr = `PayPal token HTTP ${tokRes.status} on ${base.includes("sandbox") ? "sandbox" : "live"}${txt ? `: ${txt.slice(0, 160)}` : ""}`;
        continue;
      }
      const tokJson: any = await tokRes.json();
      const accessToken = tokJson?.access_token;
      if (!accessToken) {
        lastErr = `PayPal token missing on ${base.includes("sandbox") ? "sandbox" : "live"}`;
        continue;
      }

      const balRes = await fetch(`${base}/v1/reporting/balances?currency_code=ALL`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (!balRes.ok) {
        const txt = await balRes.text().catch(() => "");
        lastErr = `PayPal balances HTTP ${balRes.status} on ${base.includes("sandbox") ? "sandbox" : "live"}${txt ? `: ${txt.slice(0, 160)}` : ""}`;
        continue;
      }
      const balJson: any = await balRes.json();
      const balances: any[] = balJson?.balances ?? [];
      const accounts = balances
        .map((b: any) => {
          const total = Number(b?.total_balance?.value ?? 0);
          const available = Number(b?.available_balance?.value ?? 0);
          return {
            name: `PayPal ${b?.currency ?? ""}`.trim(),
            currency: String(b?.currency ?? "EUR"),
            balance: total,
            available,
          };
        })
        .filter((a) => a.balance !== 0 || a.available !== 0);
      return {
        live: true,
        env: base.includes("sandbox") ? "sandbox" : "live",
        calcVersion: 2,
        fetchedAt: new Date().toISOString(),
        accountId: balJson?.account_id ?? null,
        asOf: balJson?.as_of_time ?? null,
        accounts,
      };
    } catch (err: any) {
      lastErr = err?.message ?? "PayPal fetch failed";
    }
  }
  return { live: false, reason: lastErr, accounts: [] };
}

// ─── Mollie — balances (live) ─────────────────────────────────────────────
// Uses GET /v2/balances. Returns one row per balance/currency.
export async function fetchMollieBalances() {
  const key = (process.env.MOLLIE_API_KEY ?? "").trim();
  if (!key) return { live: false, reason: "MOLLIE_API_KEY not set", accounts: [] };
  if (!/^(live|test)_[A-Za-z0-9]+$/.test(key)) {
    return {
      live: false,
      reason: `MOLLIE_API_KEY has wrong shape (expected live_… or test_…, got ${key.length} chars)`,
      accounts: [],
    };
  }
  try {
    const res = await fetch("https://api.mollie.com/v2/balances?limit=250", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        live: false,
        reason: `Mollie HTTP ${res.status}${txt ? `: ${txt.slice(0, 120)}` : ""}`,
        accounts: [],
      };
    }
    const json: any = await res.json();
    const items: any[] = json?._embedded?.balances ?? [];
    const accounts = items.map((b: any) => {
      const available = Number(b?.availableAmount?.value ?? 0);
      const pending = Number(b?.pendingAmount?.value ?? 0);
      const currency = String(b?.availableAmount?.currency ?? b?.currency ?? "EUR");
      return {
        id: b?.id,
        name: `Mollie ${currency}`,
        currency,
        balance: available + pending,
        available,
        pending,
      };
    });
    return {
      live: true,
      calcVersion: 1,
      fetchedAt: new Date().toISOString(),
      accounts,
    };
  } catch (err: any) {
    return { live: false, reason: err?.message ?? "Mollie fetch failed", accounts: [] };
  }
}

// ─── Subscription Repeat Funnel (Juo + Loop) ──────────────────────────────
// Builds a cohort retention funnel from subscription platforms instead of
// Shopify orders. Cohort month = subscription createdAt month. Repeat to Nth
// order = % of cohort whose subscription has completed ≥ N billing cycles.

// Bumped to 6: Loop's Supabase paginator now orders by id. Without it,
// concurrent writes from the Railway loop-sync service shifted physical
// row order mid-read, so adjacent pages overlapped (same Loop sub seen
// twice → collapsed by the by-id Map) AND skipped rows. UK alone lost
// ~15k of its ~45k rows that way, capping the cohort headline at ~49k
// when the true book is ~64k.
const SUB_FUNNEL_CALC_VERSION = 6;

function pickCycleCount(s: any): number {
  // Try common field names across Juo + Loop. Fall back to 1 (the signup order itself counts).
  const candidates = [
    s?.completedOrdersCount,
    s?.currentCycle,
    s?.cyclesCompleted,
    s?.completedCycles,
    s?.totalCycles,
    s?.currentCycleNumber,
    s?.cycleNumber,
    s?.orderCycles,
    s?.totalSuccessOrders,
    s?.totalOrderCount,
    s?.totalOrders,
    s?.successfulOrders,
    s?.orderCount,
    s?.numberOfBillingAttempts,
  ];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 1;
}

async function fetchAllJuoSubsForFunnel(): Promise<Array<{ id: string; createdAt: string; cycles: number }>> {
  const apiKey = process.env.JUO_NL_API_KEY;
  if (!apiKey) return [];
  const headers = { "X-Juo-Admin-Api-Key": apiKey, Accept: "application/json" };
  const JUO_BASE = "https://api.juo.io";

  // Walk every status separately. Juo's API ignores the ?status= filter on
  // some tenants and returns the full book on each call, but paginating
  // without a status query was capping us at ~2,200 rows (some quirk of
  // Juo's Link-header walker). Walking each status separately + deduping
  // gets us the full ~19k book.
  const STATUSES = ["active", "canceled", "paused", "failed", "expired"] as const;
  const byKey = new Map<string, { id: string; createdAt: string; cycles: number }>();

  async function paginateStatus(status: string) {
    let nextUrl: string | null = `${JUO_BASE}/admin/v1/subscriptions?limit=100&status=${status}`;
    let pages = 0;
    while (nextUrl && pages < 600) {
      const res: Response = await fetch(nextUrl, { headers, cache: "no-store" });
      if (res.status === 429) {
        const reset = parseInt(res.headers.get("X-RateLimit-Reset") ?? "2", 10);
        await new Promise((r) => setTimeout(r, (reset || 2) * 1000));
        continue;
      }
      if (!res.ok) break;
      const json: any = await res.json();
      const batch: any[] = json.data ?? json.subscriptions ?? (Array.isArray(json) ? json : []);
      if (batch.length === 0) break;
      for (const s of batch) {
        if (!s?.createdAt) continue;
        // Key on a SUBSCRIPTION-level identifier so multiple subs from the
        // same customer don't collapse into one. Falling back to customer
        // here was silently deduping ~17k Juo subs into ~2k unique
        // customers, which is why the cohort headline was so far off.
        const subId =
          s.id ??
          s.subscriptionId ??
          s._id ??
          `${s.customer ?? "anon"}:${s.createdAt}:${pickCycleCount(s)}`;
        const key = `juo:${subId}`;
        const existing = byKey.get(key);
        const cycles = pickCycleCount(s);
        // Keep the highest-cycle copy if the same sub appears under two
        // status queries (rare, but Juo's status filter is loose).
        if (!existing || cycles > existing.cycles) {
          byKey.set(key, { id: key, createdAt: String(s.createdAt), cycles });
        }
      }
      const link: string = res.headers.get("Link") ?? "";
      const m: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = m ? (m[1].startsWith("http") ? m[1] : new URL(m[1], JUO_BASE).toString()) : null;
      pages++;
    }
  }

  for (const status of STATUSES) {
    try {
      await paginateStatus(status);
    } catch (err: any) {
      console.warn(`[juo funnel] status=${status} fetch failed: ${err?.message ?? err}`);
    }
  }
  const out = Array.from(byKey.values());
  console.info(`[juo funnel] fetched ${out.length} unique subscriptions across ${STATUSES.length} status queries`);
  return out;
}

// Loop subs for the funnel are now read from Supabase (UK_loop / US_loop)
// instead of paginating the Loop API live. The previous live-API path
// timed out mid-fetch on the Worker because UK alone is ~450 pages × 1.2s
// gap (≈9 minutes), which silently capped the cohort at ~20k rows and
// produced the wrong headline numbers in the UI. The Supabase tables are
// kept current by the standalone loop-sync-service (Railway).
async function fetchAllLoopSubsForFunnel(): Promise<Array<{ id: string; createdAt: string; cycles: number }>> {
  const { fetchLoopSubsForFunnelFromDb } = await import("./loop-db.server");
  return fetchLoopSubsForFunnelFromDb();
}

export async function fetchSubscriptionRepeatFunnel() {
  const [juo, loop] = await Promise.all([
    fetchAllJuoSubsForFunnel().catch((e) => {
      console.error("subscription funnel — Juo fetch failed:", e?.message);
      return [] as Array<{ id: string; createdAt: string; cycles: number }>;
    }),
    fetchAllLoopSubsForFunnel().catch((e) => {
      console.error("subscription funnel — Loop fetch failed:", e?.message);
      return [] as Array<{ id: string; createdAt: string; cycles: number }>;
    }),
  ]);
  const byId = new Map<string, { id: string; createdAt: string; cycles: number }>();
  for (const sub of [...juo, ...loop]) {
    const existing = byId.get(sub.id);
    if (!existing || sub.cycles > existing.cycles) byId.set(sub.id, sub);
  }
  const all = Array.from(byId.values());
  if (all.length === 0) return null;

  // Bucket by cohort month
  const buckets = new Map<string, number[]>(); // monthKey YYYY-MM → cycles[]
  for (const s of all) {
    const d = new Date(s.createdAt);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(s.cycles);
  }
  if (buckets.size === 0) return null;

  const sortedMonths = Array.from(buckets.keys()).sort();
  const now = new Date();
  const monthsSince = (key: string): number => {
    const [y, m] = key.split("-").map(Number);
    return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
  };

  // Lifetime aggregate funnel.
  //
  // Two rates per order — both useful, but they answer different questions:
  //
  //   - `rate` = reached ÷ TOTAL cohort × 100. The "headline" funnel rate.
  //              Mathematically ties to the customers count
  //              (rate × cohortSize ≈ customers), so the UI math holds up.
  //              Slightly diluted by newer cohorts that haven't had time
  //              to reach later orders yet — that's honest.
  //
  //   - `rateMature` = reached ÷ MATURE cohort × 100. Dilution-adjusted.
  //                    Only counts cohorts old enough (≥ n-1 months) to
  //                    have realistically reached this order. Higher than
  //                    `rate` for later orders; useful for "best case
  //                    lifetime potential" but DOESN'T tie to a single
  //                    cohort-wide denominator.
  //
  //   - `maturityPct` = what fraction of the cohort is mature enough
  //                     for this order. 100% for 1st order; decreases for
  //                     later orders as the maturity window grows. Tells
  //                     users *why* the headline rate is diluted.
  const totalCohortSize = all.length;
  const funnel: Array<{
    order: number;
    customers: number | null;
    rate: number | null;          // reached / totalCohortSize × 100
    rateMature: number | null;    // reached / matureCohortSize × 100
    matureSize: number;           // count of subs in cohorts old enough for Nth order
    maturityPct: number;          // matureCohortSize / totalCohortSize × 100
    maturing: boolean;
  }> = [];
  for (let n = 1; n <= 7; n++) {
    // Mature cohorts have had ≥ N months to potentially reach Nth order.
    // (Was N-1 — too lenient for monthly subscriptions where billing the
    // Nth cycle takes a full N months, not N-1. The looser threshold let
    // 14k brand-new Apr 2026 Loop subs count toward "2nd order maturity"
    // even though they'd had under 30 days to actually pay cycle 2.)
    let matureSize = 0;
    let reached = 0;
    for (const [key, cycles] of buckets.entries()) {
      const matureMonths = n === 1 ? 0 : n;
      const cohortIsMature = monthsSince(key) >= matureMonths;
      if (!cohortIsMature) continue;
      matureSize += cycles.length;
      for (const c of cycles) if (c >= n) reached++;
    }
    const maturityPct = totalCohortSize > 0 ? +((matureSize / totalCohortSize) * 100).toFixed(1) : 0;
    if (matureSize === 0) {
      funnel.push({ order: n, customers: null, rate: null, rateMature: null, matureSize: 0, maturityPct, maturing: true });
    } else {
      const rateMature = +((reached / matureSize) * 100).toFixed(1);
      // `rate` is preserved for back-compat and for components that want
      // the absolute lifetime ratio (reached / full cohort). The UI's
      // headline switched to rateMature in this version.
      const rate = +((reached / totalCohortSize) * 100).toFixed(1);
      const maturing = maturityPct < 100;
      funnel.push({ order: n, customers: reached, rate, rateMature, matureSize, maturityPct, maturing });
    }
  }

  // Monthly cohort table — last 12 calendar months
  const recentMonths = sortedMonths.slice(-12);
  const monthlyCohorts = recentMonths.map((key) => {
    const cycles = buckets.get(key)!;
    const size = cycles.length;
    const pct = (n: number, matureMonths: number) => {
      if (monthsSince(key) < matureMonths) return null;
      if (size === 0) return null;
      return +(((cycles.filter((c) => c >= n).length / size) * 100).toFixed(1));
    };
    const avgOrders = size > 0 ? +((cycles.reduce((s, c) => s + c, 0) / size).toFixed(2)) : null;
    return {
      month: key,
      size,
      second: pct(2, 1),
      third: pct(3, 2),
      fourth: pct(4, 3),
      avgOrders,
      maturing: monthsSince(key) < 3,
    };
  });

  return {
    calcVersion: SUB_FUNNEL_CALC_VERSION,
    source: "subscriptions",
    sources: ["Juo NL", "Loop UK", "Loop US"],
    cohortSize: totalCohortSize,
    sourceStart: sortedMonths[0] ?? null,
    sourceEnd: sortedMonths[sortedMonths.length - 1] ?? null,
    funnel,
    monthlyCohorts,
    totalCustomersAnalyzed: totalCohortSize,
    rawSubscriptionsFetched: juo.length + loop.length,
    dedupedSubscriptions: totalCohortSize,
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Payment processing fees — monthly per provider ─────────────────────────
// Aggregates true payment processing fees paid to each PSP for the trailing N
// months. All amounts converted to EUR.
//
//   Shopify Payments: /shopify_payments/balance/transactions.json with date
//                     filter — sum of `fee` per processed_at month, per shop.
//   PayPal:           /v1/reporting/transactions in 31-day windows, sum of
//                     transaction_info.fee_amount.value per month.
//   Mollie:           /v2/settlements with periods[year][month].costs[] — sum
//                     amountGross across all cost categories per period.
//   Loop:             Loop's platform fee is billed via Shopify partner billing
//                     (not exposed via the Loop API). Returned as live:false
//                     with a clear reason so the UI shows "—".

function buildMonthlyPeriods(monthsBack: number) {
  const monthNamesShort = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const now = new Date();
  const periods: Array<{ label: string; ym: string; year: number; month: number; start: string; end: string }> = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const start = `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const endDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const end = `${y}-${String(m + 1).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
    const label = `${monthNamesShort[m]} '${String(y).slice(-2)}`;
    const ym = `${y}-${String(m + 1).padStart(2, "0")}`;
    periods.push({ label, ym, year: y, month: m + 1, start, end });
  }
  return periods;
}

async function fetchShopifyPaymentFeesPerStore(
  store: string,
  market: string,
  startISO: string,
  endISO: string,
): Promise<{ feeNative: number; feeEur: number; currency: string } | null> {
  const token = await getShopifyToken(store);
  if (!token) return null;
  const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
  const base = `https://${store}/admin/api/${SHOPIFY_API_VERSION}/shopify_payments`;

  let next: string | null =
    `${base}/balance/transactions.json?processed_at_min=${startISO}T00:00:00Z&processed_at_max=${endISO}T23:59:59Z&limit=250`;
  let totalFee = 0;
  let currency = MARKET_CURRENCY[market] ?? "EUR";
  let pages = 0;

  while (next && pages < 80) {
    pages++;
    const res: Response = await fetch(next, { headers });
    if (res.status === 404) return null; // not on Shopify Payments
    if (!res.ok) return null;
    const json: any = await res.json();
    const txs: any[] = json?.transactions ?? [];
    for (const t of txs) {
      const f = Number(t?.fee ?? 0);
      if (Number.isFinite(f) && f !== 0) totalFee += f;
      if (t?.currency) currency = String(t.currency);
    }
    // Pagination via Link header
    const link: string = res.headers.get("link") ?? res.headers.get("Link") ?? "";
    const m: RegExpMatchArray | null = link.match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }

  const fxRate = await getEurRate(currency, startISO, endISO);
  return { feeNative: +totalFee.toFixed(2), feeEur: +(totalFee * fxRate).toFixed(2), currency };
}

async function fetchShopifyPaymentFeesMonthly(monthsBack: number) {
  const periods = buildMonthlyPeriods(monthsBack);
  const byMonth: Record<string, { total: number; byMarket: Record<string, number> }> = {};
  for (const p of periods) byMonth[p.label] = { total: 0, byMarket: {} };

  for (const p of periods) {
    await Promise.all(
      SHOPIFY_STORES.map(async (s) => {
        const store = process.env[s.storeKey];
        if (!store) return;
        try {
          const r = await fetchShopifyPaymentFeesPerStore(store, s.code, p.start, p.end);
          if (r && r.feeEur > 0) {
            byMonth[p.label].byMarket[s.code] = +r.feeEur.toFixed(0);
            byMonth[p.label].total += r.feeEur;
          }
        } catch (err: any) {
          console.warn(`[fees] shopify ${s.code} ${p.label} failed:`, err?.message);
        }
      }),
    );
    byMonth[p.label].total = +byMonth[p.label].total.toFixed(0);
  }
  return byMonth;
}

async function fetchPaypalPaymentFeesMonthly(monthsBack: number) {
  const clientId = (process.env.PAYPAL_CLIENT_ID ?? "").trim();
  const secret = (process.env.PAYPAL_CLIENT_SECRET ?? "").trim();
  const periods = buildMonthlyPeriods(monthsBack);
  const result: Record<string, number> = {};
  for (const p of periods) result[p.label] = 0;
  if (!clientId || !secret) return { byMonth: result, live: false, reason: "PAYPAL credentials not set" };

  const envPref = (process.env.PAYPAL_ENV ?? "live").toLowerCase();
  const base = envPref === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";

  // Get token
  let accessToken = "";
  try {
    const tr = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    if (!tr.ok) return { byMonth: result, live: false, reason: `PayPal token HTTP ${tr.status}` };
    const tj: any = await tr.json();
    accessToken = tj?.access_token ?? "";
  } catch (err: any) {
    return { byMonth: result, live: false, reason: err?.message ?? "PayPal token failed" };
  }
  if (!accessToken) return { byMonth: result, live: false, reason: "PayPal no access token" };

  for (const p of periods) {
    let pageNum = 1;
    let totalFeesByCurrency: Record<string, number> = {};
    while (pageNum <= 20) {
      const url =
        `${base}/v1/reporting/transactions?fields=transaction_info` +
        `&start_date=${p.start}T00:00:00Z&end_date=${p.end}T23:59:59Z` +
        `&page_size=500&page=${pageNum}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (!res.ok) {
        if (pageNum === 1) {
          const txt = await res.text().catch(() => "");
          console.warn(`[fees] paypal ${p.label} HTTP ${res.status}: ${txt.slice(0, 120)}`);
        }
        break;
      }
      const j: any = await res.json();
      const details: any[] = j?.transaction_details ?? [];
      for (const d of details) {
        const ti = d?.transaction_info ?? {};
        const fee = Number(ti?.fee_amount?.value ?? 0);
        const curr = String(ti?.fee_amount?.currency_code ?? "EUR");
        if (Number.isFinite(fee) && fee !== 0) {
          totalFeesByCurrency[curr] = (totalFeesByCurrency[curr] ?? 0) + Math.abs(fee);
        }
      }
      const totalPages = Number(j?.total_pages ?? 1);
      if (pageNum >= totalPages) break;
      pageNum++;
    }
    let eur = 0;
    for (const [curr, amt] of Object.entries(totalFeesByCurrency)) {
      const fx = await getEurRate(curr, p.start, p.end);
      eur += amt * fx;
    }
    result[p.label] = +eur.toFixed(0);
  }
  return { byMonth: result, live: true };
}

async function fetchMolliePaymentFeesMonthly(monthsBack: number) {
  const key = (process.env.MOLLIE_API_KEY ?? "").trim();
  const periods = buildMonthlyPeriods(monthsBack);
  const result: Record<string, number> = {};
  for (const p of periods) result[p.label] = 0;
  if (!key) return { byMonth: result, live: false, reason: "MOLLIE_API_KEY not set" };

  // List all settlements (paginated). For trailing N months we'd need the
  // settlements that overlap that window; we just fetch the first ~5 pages
  // (250 per page) which covers many months for normal volumes.
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  let from: string | null = null;
  let pages = 0;
  const settlements: any[] = [];
  while (pages < 6) {
    pages++;
    const url: string = `https://api.mollie.com/v2/settlements?limit=250${from ? `&from=${from}` : ""}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { byMonth: result, live: false, reason: `Mollie HTTP ${res.status}: ${txt.slice(0, 120)}` };
    }
    const j: any = await res.json();
    const items: any[] = j?._embedded?.settlements ?? [];
    settlements.push(...items);
    const next: string | undefined = j?._links?.next?.href;
    if (!next) break;
    const u = new URL(next);
    from = u.searchParams.get("from");
    if (!from) break;
  }

  // Aggregate costs per (year, month) from periods{} on each settlement.
  const totalsByYm: Record<string, number> = {}; // key "YYYY-MM" -> EUR
  for (const s of settlements) {
    const settlementCurrency = String(s?.amount?.currency ?? "EUR");
    const periodsObj: any = s?.periods ?? {};
    for (const yearKey of Object.keys(periodsObj)) {
      const months = periodsObj[yearKey];
      for (const monthKey2 of Object.keys(months ?? {})) {
        const period = months[monthKey2];
        const costs: any[] = period?.costs ?? [];
        let monthCost = 0;
        for (const c of costs) {
          const v = Number(c?.amountGross?.value ?? 0);
          if (Number.isFinite(v)) monthCost += v;
        }
        if (monthCost === 0) continue;
        const ym = `${yearKey}-${String(monthKey2).padStart(2, "0")}`;
        // FX to EUR if needed
        const fakeStart = `${ym}-01`;
        const fakeEnd = `${ym}-28`;
        const fx = await getEurRate(settlementCurrency, fakeStart, fakeEnd);
        totalsByYm[ym] = (totalsByYm[ym] ?? 0) + monthCost * fx;
      }
    }
  }
  for (const p of periods) {
    const v = totalsByYm[p.ym] ?? 0;
    result[p.label] = +v.toFixed(0);
  }
  return { byMonth: result, live: true };
}

export async function fetchPaymentFeesMonthly(monthsBack = 12) {
  const periods = buildMonthlyPeriods(monthsBack);
  const [shopify, paypal, mollie] = await Promise.all([
    fetchShopifyPaymentFeesMonthly(monthsBack).catch((err) => {
      console.error("[fees] shopify failed:", err?.message);
      return {} as Record<string, { total: number; byMarket: Record<string, number> }>;
    }),
    fetchPaypalPaymentFeesMonthly(monthsBack).catch((err) => {
      console.error("[fees] paypal failed:", err?.message);
      return { byMonth: {}, live: false, reason: err?.message };
    }),
    fetchMolliePaymentFeesMonthly(monthsBack).catch((err) => {
      console.error("[fees] mollie failed:", err?.message);
      return { byMonth: {}, live: false, reason: err?.message };
    }),
  ]);

  const byMonth: Record<string, {
    shopify: number;
    shopifyByMarket: Record<string, number>;
    paypal: number;
    mollie: number;
    loop: number;
    total: number;
  }> = {};
  for (const p of periods) {
    const sh = (shopify as any)[p.label] ?? { total: 0, byMarket: {} };
    const pp = (paypal as any).byMonth?.[p.label] ?? 0;
    const mo = (mollie as any).byMonth?.[p.label] ?? 0;
    const lo = 0; // Loop billed via Shopify partner billing — not in Loop API
    byMonth[p.label] = {
      shopify: sh.total ?? 0,
      shopifyByMarket: sh.byMarket ?? {},
      paypal: pp,
      mollie: mo,
      loop: lo,
      total: (sh.total ?? 0) + pp + mo + lo,
    };
  }

  return {
    calcVersion: 1,
    fetchedAt: new Date().toISOString(),
    byMonth,
    providers: {
      shopify: { live: Object.values(shopify ?? {}).some((v: any) => (v?.total ?? 0) > 0) },
      paypal: { live: (paypal as any).live, reason: (paypal as any).reason ?? null },
      mollie: { live: (mollie as any).live, reason: (mollie as any).reason ?? null },
      loop: {
        live: false,
        reason: "Loop platform fee is billed via Shopify partner billing — not exposed in Loop API",
      },
    },
  };
}
