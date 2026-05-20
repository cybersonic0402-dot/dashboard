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
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1), 1));
  const fromIso = start.toISOString();
  const toIso = new Date().toISOString();

  const rows = await selectOrderRange(null, fromIso, toIso);
  if (rows.length === 0) return null;

  // Aggregate in source currency first, convert to EUR last using the
  // month's exchange rate (matches the legacy fetcher's behaviour where
  // a single rate applies for an entire month).
  type Agg = { revenue: number; orders: number; refunds: number };
  const byMonth: Record<
    string,
    { totals: Agg; perMarket: Record<string, Agg & { currency: string }> }
  > = {};

  for (const o of rows) {
    const d = new Date(o.shopify_created_at);
    if (isNaN(d.getTime())) continue;
    const month = monthKeyFromDate(d);
    const code = String(o.store_code) as StoreCode;
    const currency = o.currency || MARKET_CURRENCY[code] || "EUR";
    const total = Number(o.total_price ?? 0);
    const refund = Number(o.total_refunded ?? 0);
    const net = total - refund;

    if (!byMonth[month]) {
      byMonth[month] = {
        totals: { revenue: 0, orders: 0, refunds: 0 },
        perMarket: {},
      };
    }
    const m = byMonth[month];
    if (!m.perMarket[code]) m.perMarket[code] = { revenue: 0, orders: 0, refunds: 0, currency };
    m.perMarket[code].revenue += net;
    m.perMarket[code].refunds += refund;
    m.perMarket[code].orders += 1;
  }

  // Convert each (month, market) sub-total to EUR.
  const sortedMonthKeys = Object.keys(byMonth).sort(
    (a, b) =>
      new Date("1 " + a.replace("'", "20")).getTime() -
      new Date("1 " + b.replace("'", "20")).getTime(),
  );

  const out: any[] = [];
  for (const month of sortedMonthKeys) {
    const m = byMonth[month];
    // First day of the month → last day
    const monthDate = new Date("1 " + month.replace("'", "20"));
    const monthStart = `${monthDate.getUTCFullYear()}-${String(monthDate.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const monthEnd = new Date(
      Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0),
    )
      .toISOString()
      .split("T")[0];

    const byMarket: Record<string, { revenue: number; orders: number; refunds: number }> = {};
    let totalRev = 0;
    let totalRefunds = 0;
    let totalOrders = 0;
    for (const [code, agg] of Object.entries(m.perMarket)) {
      const rate = await eurRate(agg.currency, monthStart, monthEnd);
      const rev = +(agg.revenue * rate).toFixed(2);
      const rfn = +(agg.refunds * rate).toFixed(2);
      byMarket[code] = { revenue: rev, orders: agg.orders, refunds: rfn };
      totalRev += rev;
      totalRefunds += rfn;
      totalOrders += agg.orders;
    }
    out.push({
      month,
      revenue: +totalRev.toFixed(2),
      orders: totalOrders,
      refunds: +totalRefunds.toFixed(2),
      byMarket,
      calcVersion: 4, // bump so cache check refreshes consumers
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
  const now = new Date();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - daysBack);
  const fromIso = start.toISOString();
  const toIso = now.toISOString();

  const rows = await selectOrderRange(null, fromIso, toIso);
  if (rows.length === 0) return null;

  // Aggregate per (day, currency) so the FX conversion uses an
  // appropriate per-day rate (cached upstream).
  type Bucket = Record<string, number>; // currency → amount
  const perDay: Record<string, Bucket> = {};
  for (const o of rows) {
    const d = new Date(o.shopify_created_at);
    if (isNaN(d.getTime())) continue;
    const day = dayKeyFromDate(d);
    const currency =
      o.currency || MARKET_CURRENCY[o.store_code as StoreCode] || "EUR";
    const total = Number(o.total_price ?? 0);
    const refund = Number(o.total_refunded ?? 0);
    const net = total - refund;
    if (!perDay[day]) perDay[day] = {};
    perDay[day][currency] = (perDay[day][currency] ?? 0) + net;
  }

  const daily: Record<string, { revenue: number }> = {};
  for (const [day, currMap] of Object.entries(perDay)) {
    let revenue = 0;
    for (const [currency, amount] of Object.entries(currMap)) {
      const rate = await eurRate(currency, day, day);
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
