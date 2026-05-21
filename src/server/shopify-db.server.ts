/**
 * Shopify read-side: aggregate `shopify_orders` straight from Supabase
 * instead of paginating Shopify's live API.
 *
 * Once `shopify-sync.server.ts` has mirrored the orders into Postgres
 * (one-time backfill + incremental refresh), every dashboard consumer
 * (monthly P&L, daily strip chart, per-market breakdown) reads from the
 * DB. That has three concrete payoffs:
 *
 *   1. **Speed** — a single SELECT with a date-range filter returns in
 *      ~50ms vs. 30-90s of paginated Shopify GraphQL calls.
 *   2. **No 60-day truncation** — the `read_all_orders` scope cap that
 *      hides anything older than 60 days from the live API doesn't
 *      affect data already mirrored to Postgres.
 *   3. **No partial-fetch failures mid-render** — the dashboard is
 *      decoupled from Shopify's availability / rate-limiting; if a
 *      sync chunk fails partway, the next chunk resumes and the
 *      dashboard keeps reading the last fully-mirrored state.
 *
 * Currency handling: balances are stored in the order's source currency
 * (EUR for NL, GBP for UK, USD for US). The aggregators below convert
 * each row's amount to EUR using the EUR rate at the order's creation
 * date — same logic as the previous fetchers.server.ts path so monthly
 * totals match what the dashboard already shows.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type StoreCode = "NL" | "UK" | "US";
const MARKET_CURRENCY: Record<StoreCode, string> = {
  NL: "EUR",
  UK: "GBP",
  US: "USD",
};

// Lazy import of getEurRate to avoid pulling the fetcher bundle into
// every page that reads from this module.
async function eurRate(currency: string, fromDay: string, toDay: string): Promise<number> {
  if (currency === "EUR") return 1;
  const mod = await import("./fetchers.server");
  return (mod as any).getEurRate(currency, fromDay, toDay);
}

function monthKeyFromDate(d: Date): string {
  // Matches the legacy fetchShopifyMonthly format: "Mar '26".
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(-2)}`;
}

function dayKeyFromDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Range query helper. Pages through `shopify_orders` 1000 rows at a time
 * so we never load the whole table into memory. Returns rows ordered by
 * `shopify_created_at` ascending.
 */
async function selectOrderRange(
  storeCode: StoreCode | null,
  fromIso: string,
  toIso: string,
): Promise<any[]> {
  const out: any[] = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    let q = supabaseAdmin
      .from("shopify_orders" as any)
      .select(
        "store_code,total_price,total_refunded,total_discounts,subtotal_price,currency,customer_id,financial_status,shopify_created_at",
      )
      .gte("shopify_created_at", fromIso)
      .lte("shopify_created_at", toIso)
      .order("shopify_created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (storeCode) q = q.eq("store_code", storeCode);
    const { data, error } = await q;
    if (error) throw new Error(`shopify_orders read: ${error.message}`);
    const batch = (data ?? []) as any[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * Trailing-N-month aggregate per (month, market). Backwards-compatible
 * shape with the legacy `fetchShopifyMonthly` so consumers don't need
 * to change.
 */
export async function fetchShopifyMonthlyFromDb(monthsBack = 12) {
  // Aggregate in Postgres (shopify_monthly_agg) so we transfer ~30 rows
  // instead of pulling 250k+ order rows into memory and paginating. The
  // old row-scan approach blew the sync's time budget and silently wrote
  // nothing → the dashboard showed €0. Currency conversion to EUR happens
  // here on the small grouped result.
  const { data, error } = await (supabaseAdmin as any).rpc("shopify_monthly_agg", {
    months_back: monthsBack,
  });
  if (error) throw new Error(`shopify_monthly_agg: ${error.message}`);
  const rows = (data ?? []) as Array<{
    month_start: string;
    store_code: string;
    currency: string;
    revenue: number;
    refunds: number;
    orders: number;
  }>;
  if (rows.length === 0) return null;

  // Group by month label
  const byMonth = new Map<string, typeof rows>();
  for (const r of rows) {
    const d = new Date(r.month_start + "T00:00:00Z");
    const month = monthKeyFromDate(d);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)!.push(r);
  }

  const sortedMonths = Array.from(byMonth.keys()).sort(
    (a, b) =>
      new Date("1 " + a.replace("'", "20")).getTime() -
      new Date("1 " + b.replace("'", "20")).getTime(),
  );

  const out: any[] = [];
  for (const month of sortedMonths) {
    const monthDate = new Date("1 " + month.replace("'", "20"));
    const monthStart = `${monthDate.getUTCFullYear()}-${String(monthDate.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const monthEnd = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0))
      .toISOString()
      .split("T")[0];

    const byMarket: Record<string, { revenue: number; orders: number; refunds: number }> = {};
    let totalRev = 0;
    let totalRefunds = 0;
    let totalOrders = 0;
    for (const r of byMonth.get(month)!) {
      const code = String(r.store_code);
      const currency = r.currency || MARKET_CURRENCY[code as StoreCode] || "EUR";
      const rate = await eurRate(currency, monthStart, monthEnd);
      const rev = +(Number(r.revenue) * rate).toFixed(2);
      const rfn = +(Number(r.refunds) * rate).toFixed(2);
      byMarket[code] = { revenue: rev, orders: Number(r.orders), refunds: rfn };
      totalRev += rev;
      totalRefunds += rfn;
      totalOrders += Number(r.orders);
    }
    out.push({
      month,
      revenue: +totalRev.toFixed(2),
      orders: totalOrders,
      refunds: +totalRefunds.toFixed(2),
      byMarket,
      calcVersion: 4,
    });
  }
  return out;
}

/**
 * Per-day revenue across all stores, converted to EUR. Format matches
 * what fetchShopifyDaily returns: { daily: { 'YYYY-MM-DD': { revenue } }, calcVersion }.
 * Defaults to the last 90 days because that's what the daily strip chart
 * on the Daily P&L pillar consumes.
 */
export async function fetchShopifyDailyFromDb(daysBack = 90) {
  // SQL-aggregated per (day, currency) — see shopify_daily_agg. Avoids the
  // 250k-row in-memory scan that the monthly path also suffered from.
  const { data, error } = await (supabaseAdmin as any).rpc("shopify_daily_agg", {
    days_back: daysBack,
  });
  if (error) throw new Error(`shopify_daily_agg: ${error.message}`);
  const rows = (data ?? []) as Array<{ day: string; currency: string; revenue: number }>;
  if (rows.length === 0) return null;

  // Group per day, FX-convert each currency bucket to EUR (one rate per
  // currency reused across days to keep getEurRate calls bounded).
  const perDay: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    if (!perDay[day]) perDay[day] = {};
    perDay[day][r.currency] = (perDay[day][r.currency] ?? 0) + Number(r.revenue);
  }

  const daily: Record<string, { revenue: number }> = {};
  // Cache FX rates per (currency, month) so we don't call getEurRate for
  // every single day — daily rates within a month are close enough and
  // this keeps a 400-day pull to a dozen rate lookups.
  const rateCache = new Map<string, number>();
  for (const [day, currMap] of Object.entries(perDay)) {
    let revenue = 0;
    for (const [currency, amount] of Object.entries(currMap)) {
      const monthKey = `${currency}:${day.slice(0, 7)}`;
      let rate = rateCache.get(monthKey);
      if (rate == null) {
        rate = await eurRate(currency, day, day);
        rateCache.set(monthKey, rate);
      }
      revenue += amount * rate;
    }
    daily[day] = { revenue: +revenue.toFixed(2) };
  }
  return { daily, calcVersion: 3 };
}

/**
 * Quick health/stats for the sync-status page.
 */
export async function getShopifyOrdersStats() {
  const codes: StoreCode[] = ["NL", "UK", "US"];
  const out: Array<{
    store: StoreCode;
    rowCount: number;
    earliest: string | null;
    latest: string | null;
  }> = [];
  for (const code of codes) {
    const { count } = await supabaseAdmin
      .from("shopify_orders" as any)
      .select("*", { count: "exact", head: true })
      .eq("store_code", code);
    const { data: first } = await supabaseAdmin
      .from("shopify_orders" as any)
      .select("shopify_created_at")
      .eq("store_code", code)
      .order("shopify_created_at", { ascending: true })
      .limit(1);
    const { data: last } = await supabaseAdmin
      .from("shopify_orders" as any)
      .select("shopify_created_at")
      .eq("store_code", code)
      .order("shopify_created_at", { ascending: false })
      .limit(1);
    out.push({
      store: code,
      rowCount: count ?? 0,
      earliest: (first?.[0] as any)?.shopify_created_at ?? null,
      latest: (last?.[0] as any)?.shopify_created_at ?? null,
    });
  }
  return out;
}
