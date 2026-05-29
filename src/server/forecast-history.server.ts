/**
 * Historical trajectory loader for the revenue forecast.
 *
 * Pulls deep history from three Postgres RPCs:
 *   - shopify_history_by_market(36)        : monthly orders + revenue per market
 *   - shopify_new_customers_monthly(36)    : monthly new-customer counts per market
 *   - loop_history_by_market(24)           : monthly active/new/churned/MRR per market
 *
 * Combines them into a per-market time series that the forecast engine
 * uses to:
 *   1. Compute per-market month-over-month growth (linear regression on log)
 *   2. Detect seasonality (avg of same-calendar-month over the history window)
 *   3. Project subscriber MRR forward using the observed ramp instead of a
 *      flat ARPU × new-subs assumption
 *
 * Cached in-memory for 10 min — these RPCs scan 300k+ rows and don't
 * change second-to-second.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getEurRate } from "./fetchers.server";

const HISTORY_TTL_MS = 10 * 60 * 1000;

const MARKET_CURRENCY: Record<string, string> = {
  NL: "EUR",
  UK: "GBP",
  US: "USD",
  EU: "EUR",
};

export type ShopifyMonth = {
  monthIso: string; // YYYY-MM-01
  storeCode: string;
  currency: string;
  orders: number;
  revenue: number; // source currency
  refunds: number;
  netRevenue: number;
};

export type NewCustomerMonth = {
  monthIso: string;
  storeCode: string;
  newCustomers: number;
  acquisitionRevenue: number; // source currency
};

export type LoopMonth = {
  monthIso: string;
  market: string;
  activeSubs: number;
  newSubs: number;
  churnedSubs: number;
  mrr: number; // source currency
};

export type MarketHistorySeries = {
  market: string;
  currency: string;
  // Per month, oldest first
  months: Array<{
    monthIso: string;
    monthOfYear: number; // 1..12
    orders: number;
    netRevenueEur: number;
    newCustomers: number;
    acquisitionRevenueEur: number;
    aov: number | null; // = orders > 0 ? netRevenueEur / orders : null
    // Loop is UK/US only — null elsewhere
    activeSubs: number | null;
    newSubs: number | null;
    churnedSubs: number | null;
    mrrEur: number | null;
    arpuEur: number | null; // = activeSubs > 0 ? mrrEur / activeSubs : null
    churnRate: number | null; // decimal/month
  }>;
  // Derived metrics for the forecast
  trend: {
    // Best-fit monthly growth on log(newCustomers), trimmed to finite values.
    // Decimal: 0.05 = +5%/mo. null if too few data points.
    newCustomerGrowthRate: number | null;
    // Average new customers / month over the trailing window used as a
    // fallback baseline when seasonality alone isn't enough.
    avgNewCustomersPerMonth: number;
    // Per-calendar-month seasonal index (multiplier vs trend baseline).
    // Keys 1..12; missing months default to 1.0.
    seasonalIndex: Record<number, number>;
    // How many calendar months of history were used.
    monthsUsed: number;
  };
};

// ─── In-memory caches (10 min) ────────────────────────────────────────────
type CacheBucket<T> = { value: T | null; error: string | null; fetchedAt: number };
const shopifyCache: CacheBucket<ShopifyMonth[]> = { value: null, error: null, fetchedAt: 0 };
let shopifyInflight: Promise<ShopifyMonth[]> | null = null;
const newCustCache: CacheBucket<NewCustomerMonth[]> = { value: null, error: null, fetchedAt: 0 };
let newCustInflight: Promise<NewCustomerMonth[]> | null = null;
const loopCache: CacheBucket<LoopMonth[]> = { value: null, error: null, fetchedAt: 0 };
let loopInflight: Promise<LoopMonth[]> | null = null;

const TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function isoMonth(d: string | Date): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// ─── Raw loaders ──────────────────────────────────────────────────────────

async function loadShopifyHistoryRaw(monthsBack: number): Promise<ShopifyMonth[]> {
  const { data, error } = await (supabaseAdmin as any).rpc("shopify_history_by_market", {
    months_back: monthsBack,
  });
  if (error) throw new Error(`shopify_history_by_market: ${error.message}`);
  return ((data ?? []) as any[]).map((r) => ({
    monthIso: isoMonth(r.month_start),
    storeCode: String(r.store_code),
    currency: String(r.currency ?? MARKET_CURRENCY[String(r.store_code)] ?? "EUR"),
    orders: Number(r.orders ?? 0),
    revenue: Number(r.revenue ?? 0),
    refunds: Number(r.refunds ?? 0),
    netRevenue: Number(r.net_revenue ?? 0),
  }));
}

async function loadNewCustomersHistoryRaw(monthsBack: number): Promise<NewCustomerMonth[]> {
  const { data, error } = await (supabaseAdmin as any).rpc("shopify_new_customers_monthly", {
    months_back: monthsBack,
  });
  if (error) throw new Error(`shopify_new_customers_monthly: ${error.message}`);
  return ((data ?? []) as any[]).map((r) => ({
    monthIso: isoMonth(r.month_start),
    storeCode: String(r.store_code),
    newCustomers: Number(r.new_customers ?? 0),
    acquisitionRevenue: Number(r.acquisition_revenue ?? 0),
  }));
}

async function loadLoopHistoryRaw(monthsBack: number): Promise<LoopMonth[]> {
  const { data, error } = await (supabaseAdmin as any).rpc("loop_history_by_market", {
    months_back: monthsBack,
  });
  if (error) throw new Error(`loop_history_by_market: ${error.message}`);
  return ((data ?? []) as any[]).map((r) => ({
    monthIso: isoMonth(r.month_start),
    market: String(r.market),
    activeSubs: Number(r.active_subs ?? 0),
    newSubs: Number(r.new_subs ?? 0),
    churnedSubs: Number(r.churned_subs ?? 0),
    mrr: Number(r.mrr ?? 0),
  }));
}

// ─── Cached fronts ────────────────────────────────────────────────────────

async function cached<T>(
  bucket: CacheBucket<T>,
  inflight: { p: Promise<T> | null },
  fetcher: () => Promise<T>,
  label: string,
): Promise<{ value: T; cached: boolean; error: string | null }> {
  const now = Date.now();
  if (bucket.value != null && now - bucket.fetchedAt < HISTORY_TTL_MS) {
    return { value: bucket.value, cached: true, error: bucket.error };
  }
  if (inflight.p) {
    try {
      const v = await inflight.p;
      return { value: v, cached: true, error: null };
    } catch (err: any) {
      if (bucket.value != null) {
        return { value: bucket.value, cached: true, error: err?.message ?? `${label} failed` };
      }
      throw err;
    }
  }
  const task = withTimeout(fetcher(), TIMEOUT_MS, label);
  inflight.p = task;
  try {
    const v = await task;
    bucket.value = v;
    bucket.error = null;
    bucket.fetchedAt = Date.now();
    return { value: v, cached: false, error: null };
  } catch (err: any) {
    const msg = err?.message ?? `${label} failed`;
    if (bucket.value != null) {
      return { value: bucket.value, cached: true, error: msg };
    }
    throw err;
  } finally {
    inflight.p = null;
  }
}

const shopifyInflightRef = { get p() { return shopifyInflight; }, set p(v) { shopifyInflight = v; } };
const newCustInflightRef = { get p() { return newCustInflight; }, set p(v) { newCustInflight = v; } };
const loopInflightRef = { get p() { return loopInflight; }, set p(v) { loopInflight = v; } };

export async function loadShopifyHistory(monthsBack = 36) {
  return cached(shopifyCache, shopifyInflightRef as any,
    () => loadShopifyHistoryRaw(monthsBack), "shopify_history_by_market");
}
export async function loadNewCustomersHistory(monthsBack = 36) {
  return cached(newCustCache, newCustInflightRef as any,
    () => loadNewCustomersHistoryRaw(monthsBack), "shopify_new_customers_monthly");
}
export async function loadLoopHistory(monthsBack = 24) {
  return cached(loopCache, loopInflightRef as any,
    () => loadLoopHistoryRaw(monthsBack), "loop_history_by_market");
}

// ─── Trend regression ─────────────────────────────────────────────────────

/**
 * Linear regression on log(y) over month-index x → returns the monthly
 * growth rate (decimal). e.g. 0.05 = 5%/mo. Returns null if < 3 points
 * with positive y.
 */
function logTrendGrowthRate(points: number[]): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i] > 0 && isFinite(points[i])) {
      xs.push(i);
      ys.push(Math.log(points[i]));
    }
  }
  if (xs.length < 3) return null;
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den; // log growth per month-index step
  return Math.exp(slope) - 1; // back to decimal MoM growth
}

function buildSeasonalIndex(monthsByCalendar: Record<number, number[]>): Record<number, number> {
  // Average value per calendar month, divided by overall average → multiplier.
  const allValues: number[] = [];
  for (const list of Object.values(monthsByCalendar)) allValues.push(...list);
  if (allValues.length === 0) return {};
  const overallAvg = allValues.reduce((a, b) => a + b, 0) / allValues.length;
  if (!isFinite(overallAvg) || overallAvg <= 0) return {};
  const out: Record<number, number> = {};
  for (let mo = 1; mo <= 12; mo++) {
    const list = monthsByCalendar[mo];
    if (!list || list.length === 0) {
      out[mo] = 1;
      continue;
    }
    const avg = list.reduce((a, b) => a + b, 0) / list.length;
    out[mo] = avg > 0 ? +(avg / overallAvg).toFixed(3) : 1;
  }
  return out;
}

// ─── Top-level: per-market history series ────────────────────────────────

export type HistoryResult = {
  series: MarketHistorySeries[];
  diagnostics: Array<{ name: string; ok: boolean; cached: boolean; error: string | null }>;
  fetchedAt: string;
};

export async function loadMarketHistory(markets: string[]): Promise<HistoryResult> {
  const [shopifyR, newCustR, loopR] = await Promise.all([
    loadShopifyHistory(36).catch((err) => ({ value: [] as ShopifyMonth[], cached: false, error: err?.message ?? "fail" })),
    loadNewCustomersHistory(36).catch((err) => ({ value: [] as NewCustomerMonth[], cached: false, error: err?.message ?? "fail" })),
    loadLoopHistory(24).catch((err) => ({ value: [] as LoopMonth[], cached: false, error: err?.message ?? "fail" })),
  ]);

  // Index by market+month
  const shopByKey = new Map<string, ShopifyMonth>();
  for (const r of shopifyR.value) shopByKey.set(`${r.storeCode}|${r.monthIso}`, r);
  const ncByKey = new Map<string, NewCustomerMonth>();
  for (const r of newCustR.value) ncByKey.set(`${r.storeCode}|${r.monthIso}`, r);
  const loopByKey = new Map<string, LoopMonth>();
  for (const r of loopR.value) loopByKey.set(`${r.market}|${r.monthIso}`, r);

  // Union of months we have any data for, per market
  const series: MarketHistorySeries[] = [];
  for (const market of markets) {
    const currency = MARKET_CURRENCY[market] ?? "EUR";
    // collect month list from shopify history (most complete)
    const monthSet = new Set<string>();
    for (const r of shopifyR.value) if (r.storeCode === market) monthSet.add(r.monthIso);
    for (const r of newCustR.value) if (r.storeCode === market) monthSet.add(r.monthIso);
    for (const r of loopR.value) if (r.market === market) monthSet.add(r.monthIso);
    const monthsAsc = Array.from(monthSet).sort();
    const months: MarketHistorySeries["months"] = [];

    for (const iso of monthsAsc) {
      const s = shopByKey.get(`${market}|${iso}`);
      const nc = ncByKey.get(`${market}|${iso}`);
      const lp = loopByKey.get(`${market}|${iso}`);
      // FX → EUR using start-of-month rate (cheap, cached upstream).
      const fx = currency === "EUR" ? 1 : await getEurRate(currency, iso, iso).catch(() => 1);
      const netRevenueEur = +(((s?.netRevenue ?? 0) * fx).toFixed(2));
      const acquisitionRevenueEur = +(((nc?.acquisitionRevenue ?? 0) * fx).toFixed(2));
      const mrrEur = lp ? +((lp.mrr * fx).toFixed(2)) : null;
      const arpuEur = lp && lp.activeSubs > 0 && mrrEur != null
        ? +(mrrEur / lp.activeSubs).toFixed(2)
        : null;
      const churnRate = lp && (lp.activeSubs + lp.churnedSubs) > 0
        ? +(lp.churnedSubs / (lp.activeSubs + lp.churnedSubs)).toFixed(4)
        : null;
      months.push({
        monthIso: iso,
        monthOfYear: Number(iso.slice(5, 7)),
        orders: s?.orders ?? 0,
        netRevenueEur,
        newCustomers: nc?.newCustomers ?? 0,
        acquisitionRevenueEur,
        aov: (s?.orders ?? 0) > 0 ? +(netRevenueEur / (s?.orders ?? 1)).toFixed(2) : null,
        activeSubs: lp?.activeSubs ?? null,
        newSubs: lp?.newSubs ?? null,
        churnedSubs: lp?.churnedSubs ?? null,
        mrrEur,
        arpuEur,
        churnRate,
      });
    }

    // Trend on new customers (exclude the current incomplete month)
    const stableMonths = months.length > 0 ? months.slice(0, -1) : months;
    const newCustPoints = stableMonths.map((m) => m.newCustomers);
    const growthRate = logTrendGrowthRate(newCustPoints);
    const avgNew = stableMonths.length
      ? stableMonths.reduce((a, b) => a + b.newCustomers, 0) / stableMonths.length
      : 0;

    // Seasonality: bucket by calendar month
    const buckets: Record<number, number[]> = {};
    for (const m of stableMonths) {
      (buckets[m.monthOfYear] = buckets[m.monthOfYear] ?? []).push(m.newCustomers);
    }
    const seasonalIndex = buildSeasonalIndex(buckets);

    series.push({
      market,
      currency,
      months,
      trend: {
        newCustomerGrowthRate: growthRate,
        avgNewCustomersPerMonth: +avgNew.toFixed(1),
        seasonalIndex,
        monthsUsed: stableMonths.length,
      },
    });
  }

  return {
    series,
    diagnostics: [
      {
        name: "shopify_history_by_market (36mo)",
        ok: (shopifyR.value as ShopifyMonth[]).length > 0 && !shopifyR.error,
        cached: (shopifyR as any).cached ?? false,
        error: (shopifyR as any).error ?? null,
      },
      {
        name: "shopify_new_customers_monthly (36mo)",
        ok: (newCustR.value as NewCustomerMonth[]).length > 0 && !newCustR.error,
        cached: (newCustR as any).cached ?? false,
        error: (newCustR as any).error ?? null,
      },
      {
        name: "loop_history_by_market (24mo)",
        ok: (loopR.value as LoopMonth[]).length > 0 && !loopR.error,
        cached: (loopR as any).cached ?? false,
        error: (loopR as any).error ?? null,
      },
    ],
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Given a per-market history series and a target month, return the
 * projected new-customer count using:
 *   N(t) = lastObservedBaseline × (1 + growth)^t × seasonalIndex(month_of_year(t))
 *
 * The lastObservedBaseline is the most recent complete month's
 * newCustomers, NOT the trailing average — so the projection starts
 * from where the business actually is today rather than where it was
 * 6 months ago.
 */
export function projectNewCustomers(
  series: MarketHistorySeries,
  futureMonthIso: string,
  baseGrowthOverride: number | null,
): { value: number; baseline: number; growthApplied: number; seasonalMultiplier: number } {
  const months = series.months;
  // Last "stable" month = exclude current incomplete month
  const lastStable = months.length >= 2 ? months[months.length - 2] : months[months.length - 1];
  const baseline = lastStable?.newCustomers ?? 0;

  // Steps from the lastStable month to the target month (rough month count)
  const startD = new Date(`${lastStable?.monthIso ?? futureMonthIso}T00:00:00Z`);
  const targetD = new Date(`${futureMonthIso}T00:00:00Z`);
  const stepCount = Math.max(
    1,
    (targetD.getUTCFullYear() - startD.getUTCFullYear()) * 12 +
      (targetD.getUTCMonth() - startD.getUTCMonth()),
  );

  const growth =
    baseGrowthOverride != null
      ? baseGrowthOverride
      : (series.trend.newCustomerGrowthRate ?? 0);
  const monthOfYear = Number(futureMonthIso.slice(5, 7));
  const seasonal = series.trend.seasonalIndex[monthOfYear] ?? 1;
  const value = baseline * Math.pow(1 + growth, stepCount) * seasonal;
  return {
    value: +value.toFixed(1),
    baseline,
    growthApplied: growth,
    seasonalMultiplier: seasonal,
  };
}
