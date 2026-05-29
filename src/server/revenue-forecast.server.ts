/**
 * 12-month forward revenue forecast per market with cohort-based LTV.
 *
 * Three revenue streams, projected month-by-month:
 *   1. New customer revenue — acquisition order from customers acquired
 *      in each forecast month (N(m) × AOV).
 *   2. One-time repeat revenue — follow-up orders from non-subscriber
 *      cohorts already acquired (existing + newly forecast).
 *   3. Subscriber tail revenue — surviving MRR from existing active
 *      subscribers + cumulative new subscribers, decayed by churn.
 *
 * Methodology
 * -----------
 * Cohort LTV is sampled at 60 / 90 / 180 / 365 days via the
 * `shopify_cohort_ltv` RPC. We treat those as cumulative LTV at the end of
 * months 2 / 3 / 6 / 12, anchor (month 0) = AOV, and linearly interpolate
 * to derive a monthly cumulative LTV curve. Per-month incremental revenue
 * M(t) = cumLTV(t) − cumLTV(t−1).
 *
 * The new-customer baseline N(m) comes from the trailing 3-month average of
 * Shopify orders × newCustomersPct (from Triple Whale). A user-supplied
 * monthly growth rate (default 0%) is applied on top.
 *
 * P50 = the central projection. P90 ("conservative cap" per the scope doc)
 * is computed as P50 × confidence_factor, where confidence_factor depends
 * on cohort sample size and the longest mature LTV window available:
 *   - 365-day LTV available + >= 500 mature customers  → 0.88
 *   - 180-day LTV available + >= 250 mature customers  → 0.80
 *   - 90-day LTV available                             → 0.72
 *   - else                                             → 0.65
 *
 * Inputs
 * ------
 *   - Triple Whale per-market row (AOV, newCustomersPct, MRR, churnRate,
 *     activeSubscribers, newSubscribers) for the current period.
 *   - shopify_monthly aggregate (last ~6 months of orders per market).
 *   - shopify_cohort_ltv RPC (mature cohort LTV per market).
 *
 * Output: 12 forecast months per market, each carrying the three streams,
 * P50 and P90, plus the assumption snapshot used to compute it.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchTripleWhale, fetchJuoForRange, getEurRate } from "./fetchers.server";
import { fetchShopifyMonthlyFromDb } from "./shopify-db.server";
import { fetchLoopMarketLight } from "./loop-db.server";

const FORECAST_MARKETS = ["NL", "UK", "US"] as const;
export type ForecastMarket = (typeof FORECAST_MARKETS)[number];

export type ForecastAssumptions = {
  // Month-over-month growth applied to N(m). 0.05 = +5% per month.
  monthlyGrowthRate: number;
  // Optional explicit override for churn (decimal/month). null = use TW.
  churnRateOverride: number | null;
  // Optional explicit override for the % of new customers who become subs.
  subscriberRateOverride: number | null;
};

export type ForecastMonthRow = {
  monthIso: string; // YYYY-MM-01
  monthLabel: string; // e.g. "Jun 2026"
  newCustomerRevenue: number;
  oneTimeRepeatRevenue: number;
  subscriberTailRevenue: number;
  totalP50: number;
  totalP90: number;
  newCustomers: number; // projected N(m)
};

export type MarketForecast = {
  market: ForecastMarket;
  currency: "EUR";
  // Snapshot of inputs used
  aov: number | null;
  baselineNewCustomersPerMonth: number | null;
  monthlyChurnRate: number | null;
  subscriberRate: number | null;
  startingMrr: number | null;
  arpuPerSubscriber: number | null;
  // LTV anchors and derived monthly increments
  ltvWindows: {
    day60: number | null;
    day90: number | null;
    day180: number | null;
    day365: number | null;
  };
  matureCustomers: {
    day60: number;
    day90: number;
    day180: number;
    day365: number;
  };
  monthlyIncrementalLTV: number[]; // length 13: M(0)…M(12)
  confidenceFactor: number;
  // 12 forecast months
  months: ForecastMonthRow[];
  // Aggregates across the 12-month window
  totals: {
    newCustomerRevenue: number;
    oneTimeRepeatRevenue: number;
    subscriberTailRevenue: number;
    totalP50: number;
    totalP90: number;
  };
  // Notes / data-quality warnings for this market
  warnings: string[];
};

export type SourceDiagnostic = {
  name: string;
  ok: boolean;
  cached: boolean;
  error: string | null;
};

export type RevenueForecast = {
  startMonth: string; // YYYY-MM-01 — first forecast month
  horizonMonths: number; // 12
  assumptions: ForecastAssumptions;
  markets: MarketForecast[];
  fetchedAt: string;
  twWarning: string | null;
  diagnostics: SourceDiagnostic[];
};

type CohortLtvRow = {
  store_code: string;
  mature_customers_60: number;
  mature_customers_90: number;
  mature_customers_180: number;
  mature_customers_365: number;
  ltv_60: number | null;
  ltv_90: number | null;
  ltv_180: number | null;
  ltv_365: number | null;
  total_customers: number;
  avg_orders_per_customer: number | null;
};

// ─── Per-source caches and outer timeouts ─────────────────────────────────
// All external reads (TW, cohort LTV, Loop, Juo, Shopify monthly) are
// hard-capped so the page never hangs. Hits cache on subsequent loads.
const CACHE_TTL_MS = 5 * 60 * 1000;
const TW_OUTER_TIMEOUT_MS = 90_000;
const COHORT_TIMEOUT_MS = 45_000;
const SUBS_TIMEOUT_MS = 90_000;
const SHOPIFY_MONTHLY_TIMEOUT_MS = 30_000;
const FORECAST_OUTER_TIMEOUT_MS = 120_000;

const twCache = new Map<string, { rows: any[]; fetchedAt: number }>();
const twInflight = new Map<string, Promise<any[]>>();
const cohortCache: { value: Map<string, CohortLtvRow> | null; error: string | null; fetchedAt: number } =
  { value: null, error: null, fetchedAt: 0 };
let cohortInflight: Promise<Map<string, CohortLtvRow>> | null = null;
const subsCache: { value: Map<string, SubscriberStats> | null; error: string | null; fetchedAt: number } =
  { value: null, error: null, fetchedAt: 0 };
let subsInflight: Promise<Map<string, SubscriberStats>> | null = null;
const monthlyCache: { value: any[] | null; error: string | null; fetchedAt: number } =
  { value: null, error: null, fetchedAt: 0 };
let monthlyInflight: Promise<any[] | null> | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function fetchTripleWhaleCached(
  from: string,
  to: string,
): Promise<{ rows: any[]; error: string | null }> {
  const key = `${from}|${to}`;
  const now = Date.now();
  const hit = twCache.get(key);
  if (hit && now - hit.fetchedAt < CACHE_TTL_MS) {
    return { rows: hit.rows, error: null };
  }
  const pending = twInflight.get(key);
  if (pending) {
    try {
      const rows = await pending;
      return { rows, error: null };
    } catch (err: any) {
      return { rows: [], error: err?.message ?? "fetch failed" };
    }
  }
  const task = (async () => {
    const rows = (await withTimeout(
      fetchTripleWhale(from, to),
      TW_OUTER_TIMEOUT_MS,
      "Triple Whale (forecast)",
    )) as any[] | null;
    return Array.isArray(rows) ? rows : [];
  })();
  twInflight.set(key, task);
  try {
    const rows = await task;
    twCache.set(key, { rows, fetchedAt: Date.now() });
    return { rows, error: null };
  } catch (err: any) {
    return { rows: [], error: err?.message ?? "fetch failed" };
  } finally {
    twInflight.delete(key);
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function startOfMonthIso(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
}

function todayIso(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addMonthsIso(monthIso: string, n: number): string {
  const [y, m] = monthIso.split("-").map(Number);
  const d = new Date(Date.UTC(y, (m ?? 1) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`;
}

function monthLabel(monthIso: string): string {
  const [y, m] = monthIso.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, 1)).toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
  });
}

// ── Cohort LTV → monthly retention curve ──────────────────────────────────

/**
 * Build a 13-element array `cumLTV` where cumLTV[t] is the cumulative
 * revenue per acquired customer at the END of month t (so cumLTV[0] = AOV,
 * cumLTV[12] = projected lifetime revenue out to 1 year).
 *
 * Uses cumLTV anchors at months {0, 2, 3, 6, 12} from cohort LTV windows.
 * Missing anchors are filled by forward extrapolation from the longest
 * available window so we always return a non-decreasing curve.
 */
function buildCumLtvCurve(
  aov: number | null,
  ltv: {
    day60: number | null;
    day90: number | null;
    day180: number | null;
    day365: number | null;
  },
): number[] {
  const safeAov = aov && aov > 0 ? aov : 0;
  // Anchor points: [monthIndex, cumLTV]. cumLTV must be ≥ AOV.
  const anchors: Array<[number, number]> = [[0, safeAov]];
  if (ltv.day60 != null) anchors.push([2, Math.max(safeAov, ltv.day60)]);
  if (ltv.day90 != null) anchors.push([3, Math.max(safeAov, ltv.day90)]);
  if (ltv.day180 != null) anchors.push([6, Math.max(safeAov, ltv.day180)]);
  if (ltv.day365 != null) anchors.push([12, Math.max(safeAov, ltv.day365)]);

  // Enforce non-decreasing across anchors (cohort LTV is cumulative; a
  // smaller value at a later window means immature data — bump it up).
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i][1] < anchors[i - 1][1]) {
      anchors[i] = [anchors[i][0], anchors[i - 1][1]];
    }
  }

  const cum: number[] = new Array(13).fill(0);
  // Linear interpolation between adjacent anchors.
  for (let i = 0; i < anchors.length - 1; i++) {
    const [t0, v0] = anchors[i];
    const [t1, v1] = anchors[i + 1];
    for (let t = t0; t <= t1; t++) {
      const frac = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
      cum[t] = v0 + (v1 - v0) * frac;
    }
  }
  // Extrapolate beyond the last anchor using the average per-month
  // increment from the last interval (capped at the value to avoid
  // pretending growth where none was measured).
  const last = anchors[anchors.length - 1];
  if (last[0] < 12) {
    const second = anchors.length >= 2 ? anchors[anchors.length - 2] : null;
    const monthlyInc =
      second && last[0] > second[0]
        ? Math.max(0, (last[1] - second[1]) / (last[0] - second[0]))
        : 0;
    let prev = last[1];
    for (let t = last[0] + 1; t <= 12; t++) {
      prev = prev + monthlyInc;
      cum[t] = prev;
    }
  }
  return cum;
}

function incrementalFromCum(cum: number[]): number[] {
  const inc = new Array(cum.length).fill(0);
  inc[0] = cum[0];
  for (let t = 1; t < cum.length; t++) {
    inc[t] = Math.max(0, cum[t] - cum[t - 1]);
  }
  return inc;
}

function computeConfidenceFactor(
  ltv: MarketForecast["ltvWindows"],
  mature: MarketForecast["matureCustomers"],
): number {
  if (ltv.day365 != null && mature.day365 >= 500) return 0.88;
  if (ltv.day180 != null && mature.day180 >= 250) return 0.8;
  if (ltv.day90 != null) return 0.72;
  return 0.65;
}

// ── Loader: subscriber stats (Loop + Juo as primary, EUR-normalised) ──────

export type SubscriberStats = {
  market: string;
  source: "loop" | "juo" | null;
  mrr: number | null; // EUR/month
  activeSubs: number | null;
  arpu: number | null; // EUR
  churnRate: number | null; // decimal/month (e.g. 0.045)
  newSubsThisMonth: number | null;
};

const LOOP_CURRENCY: Record<string, string> = { UK: "GBP", US: "USD", EU: "EUR" };

async function loadSubscriberStatsCached(
  fromIso: string,
  toIso: string,
): Promise<{ value: Map<string, SubscriberStats>; error: string | null; cached: boolean }> {
  const now = Date.now();
  if (subsCache.value && now - subsCache.fetchedAt < CACHE_TTL_MS) {
    return { value: subsCache.value, error: subsCache.error, cached: true };
  }
  if (subsInflight) {
    try {
      const v = await subsInflight;
      return { value: v, error: null, cached: true };
    } catch (err: any) {
      return {
        value: new Map(),
        error: err?.message ?? "subscriber fetch failed",
        cached: false,
      };
    }
  }
  const task = withTimeout(
    loadSubscriberStatsRaw(fromIso, toIso),
    SUBS_TIMEOUT_MS,
    "Subscriber stats (Loop/Juo)",
  );
  subsInflight = task;
  try {
    const v = await task;
    subsCache.value = v;
    subsCache.error = null;
    subsCache.fetchedAt = Date.now();
    return { value: v, error: null, cached: false };
  } catch (err: any) {
    const msg = err?.message ?? "subscriber fetch failed";
    // Keep stale cache if we have one; otherwise return empty.
    if (subsCache.value) {
      return { value: subsCache.value, error: msg, cached: true };
    }
    return { value: new Map(), error: msg, cached: false };
  } finally {
    subsInflight = null;
  }
}

// Each subscriber source gets its own short timeout. A slow NL (Juo API
// pagination) or UK (~52k rows) can't drag the whole bundle past the outer
// SUBS_TIMEOUT_MS — slow markets just come back empty while fast markets
// render normally.
const PER_SOURCE_TIMEOUT_MS = 30_000;

async function loadSubscriberStatsRaw(
  fromIso: string,
  toIso: string,
): Promise<Map<string, SubscriberStats>> {
  const out = new Map<string, SubscriberStats>();
  // Each market runs independently via Promise.allSettled so one slow store
  // (UK Loop has ~52k rows) doesn't break the others. UK + US use the
  // loop_market_summary Postgres RPC (~2s each); NL hits the Juo API.
  const tasks: Array<Promise<{ market: string; stats: SubscriberStats } | null>> = [
    withTimeout(fetchLoopMarketLight("UK"), PER_SOURCE_TIMEOUT_MS, "Loop UK")
      .then(async (r) => {
        const fx = await getEurRate(r.currency, fromIso, toIso).catch(() => 1);
        return {
          market: r.market,
          stats: {
            market: r.market,
            source: "loop" as const,
            mrr: +(r.mrr * fx).toFixed(2),
            activeSubs: r.activeSubs,
            arpu: r.arpu != null ? +(r.arpu * fx).toFixed(2) : null,
            churnRate: r.churnRate != null ? +(r.churnRate / 100).toFixed(4) : null,
            newSubsThisMonth: r.newThisMonth,
          },
        };
      })
      .catch((err) => {
        console.warn("[forecast] loop UK failed:", err?.message ?? err);
        return null;
      }),
    withTimeout(fetchLoopMarketLight("US"), PER_SOURCE_TIMEOUT_MS, "Loop US")
      .then(async (r) => {
        const fx = await getEurRate(r.currency, fromIso, toIso).catch(() => 1);
        return {
          market: r.market,
          stats: {
            market: r.market,
            source: "loop" as const,
            mrr: +(r.mrr * fx).toFixed(2),
            activeSubs: r.activeSubs,
            arpu: r.arpu != null ? +(r.arpu * fx).toFixed(2) : null,
            churnRate: r.churnRate != null ? +(r.churnRate / 100).toFixed(4) : null,
            newSubsThisMonth: r.newThisMonth,
          },
        };
      })
      .catch((err) => {
        console.warn("[forecast] loop US failed:", err?.message ?? err);
        return null;
      }),
    withTimeout(fetchJuoForRange(fromIso, toIso), PER_SOURCE_TIMEOUT_MS, "Juo NL")
      .then((rows) => {
        const r = (rows ?? [])[0] as any;
        if (!r) return null;
        return {
          market: String(r.market),
          stats: {
            market: String(r.market),
            source: "juo" as const,
            mrr: r.mrr != null ? +Number(r.mrr).toFixed(2) : null,
            activeSubs: r.activeSubs != null ? Number(r.activeSubs) : null,
            arpu: r.arpu != null ? +Number(r.arpu).toFixed(2) : null,
            churnRate:
              r.churnRate != null ? +(Number(r.churnRate) / 100).toFixed(4) : null,
            newSubsThisMonth:
              r.newThisMonth != null ? Number(r.newThisMonth) : null,
          },
        };
      })
      .catch((err) => {
        console.warn("[forecast] juo NL failed:", err?.message ?? err);
        return null;
      }),
  ];

  const settled = await Promise.allSettled(tasks);
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      out.set(r.value.market, r.value.stats);
    }
  }

  return out;
}

// ── Loader: cohort LTV ────────────────────────────────────────────────────

async function loadCohortLtvCached(): Promise<{
  value: Map<string, CohortLtvRow>;
  error: string | null;
  cached: boolean;
}> {
  const now = Date.now();
  if (cohortCache.value && now - cohortCache.fetchedAt < CACHE_TTL_MS) {
    return { value: cohortCache.value, error: cohortCache.error, cached: true };
  }
  if (cohortInflight) {
    try {
      const v = await cohortInflight;
      return { value: v, error: null, cached: true };
    } catch (err: any) {
      return { value: new Map(), error: err?.message ?? "cohort fetch failed", cached: false };
    }
  }
  const task = withTimeout(loadCohortLtvRaw(), COHORT_TIMEOUT_MS, "shopify_cohort_ltv");
  cohortInflight = task;
  try {
    const v = await task;
    cohortCache.value = v;
    cohortCache.error = null;
    cohortCache.fetchedAt = Date.now();
    return { value: v, error: null, cached: false };
  } catch (err: any) {
    const msg = err?.message ?? "cohort fetch failed";
    if (cohortCache.value) return { value: cohortCache.value, error: msg, cached: true };
    return { value: new Map(), error: msg, cached: false };
  } finally {
    cohortInflight = null;
  }
}

async function loadCohortLtvRaw(): Promise<Map<string, CohortLtvRow>> {
  const { data, error } = await (supabaseAdmin as any).rpc("shopify_cohort_ltv");
  if (error) throw new Error(error.message);
  const out = new Map<string, CohortLtvRow>();
  for (const r of (data ?? []) as CohortLtvRow[]) {
    if (r?.store_code) out.set(r.store_code, r);
  }
  return out;
}

async function loadShopifyMonthlyCached(): Promise<{
  value: any[] | null;
  error: string | null;
  cached: boolean;
}> {
  const now = Date.now();
  if (monthlyCache.value && now - monthlyCache.fetchedAt < CACHE_TTL_MS) {
    return { value: monthlyCache.value, error: monthlyCache.error, cached: true };
  }
  if (monthlyInflight) {
    try {
      const v = await monthlyInflight;
      return { value: v, error: null, cached: true };
    } catch (err: any) {
      return { value: null, error: err?.message ?? "monthly fetch failed", cached: false };
    }
  }
  const task = withTimeout(
    fetchShopifyMonthlyFromDb(6),
    SHOPIFY_MONTHLY_TIMEOUT_MS,
    "shopify_monthly_agg",
  );
  monthlyInflight = task;
  try {
    const v = await task;
    monthlyCache.value = v;
    monthlyCache.error = null;
    monthlyCache.fetchedAt = Date.now();
    return { value: v, error: null, cached: false };
  } catch (err: any) {
    const msg = err?.message ?? "monthly fetch failed";
    if (monthlyCache.value) return { value: monthlyCache.value, error: msg, cached: true };
    return { value: null, error: msg, cached: false };
  } finally {
    monthlyInflight = null;
  }
}

// ── Baseline new-customer projection ─────────────────────────────────────

/**
 * Project the baseline number of new customers per month for a market.
 *
 * Uses the trailing 3 months of Shopify orders × current new-customer %
 * (from TW). Returns null if we have insufficient signal so the caller
 * can flag the warning.
 */
function baselineNewCustomersFromShopify(
  market: ForecastMarket,
  shopifyMonthly: any[] | null,
  newCustomerPct: number | null,
): number | null {
  if (!Array.isArray(shopifyMonthly) || shopifyMonthly.length === 0) return null;
  const last3 = shopifyMonthly.slice(-3);
  let totalOrders = 0;
  let count = 0;
  for (const m of last3) {
    const ord = Number(m?.byMarket?.[market]?.orders ?? 0);
    if (ord > 0) {
      totalOrders += ord;
      count++;
    }
  }
  if (count === 0) return null;
  const avgOrders = totalOrders / count;
  const ncPctDecimal =
    newCustomerPct != null
      ? newCustomerPct > 1
        ? newCustomerPct / 100
        : newCustomerPct
      : 0.7; // sensible default: 70% new
  const value = avgOrders * ncPctDecimal;
  return value > 0 ? +value.toFixed(1) : null;
}

// ── Main forecast computation per market ─────────────────────────────────

function computeMarketForecast(
  market: ForecastMarket,
  startMonth: string,
  horizon: number,
  tw: any | null,
  cohort: CohortLtvRow | null,
  shopifyMonthly: any[] | null,
  subs: SubscriberStats | null,
  assumptions: ForecastAssumptions,
): MarketForecast {
  const warnings: string[] = [];

  const aov = tw?.aov != null ? Number(tw.aov) : null;
  const newCustomerPct = tw?.newCustomersPct != null ? Number(tw.newCustomersPct) : null;
  // Subscriber inputs: prefer Loop/Juo (direct DB) over TW (often null on
  // Zapply's TW account). Fall back to TW only when the direct source is
  // unavailable.
  const startingMrr =
    subs?.mrr != null
      ? subs.mrr
      : tw?.mrr != null
        ? Number(tw.mrr)
        : null;
  const activeSubs =
    subs?.activeSubs != null
      ? subs.activeSubs
      : tw?.activeSubscribers != null
        ? Number(tw.activeSubscribers)
        : null;
  const newSubsTw =
    subs?.newSubsThisMonth != null
      ? subs.newSubsThisMonth
      : tw?.newSubscribers != null
        ? Number(tw.newSubscribers)
        : null;
  const churnFromTw = tw?.churnRate != null ? Number(tw.churnRate) : null;
  // TW reports churn as a percent (e.g. 4.5 → 4.5%/month). Normalise.
  // Loop/Juo churn is already in decimal form via loadSubscriberStats.
  const churnRate = (() => {
    if (assumptions.churnRateOverride != null) return assumptions.churnRateOverride;
    if (subs?.churnRate != null) return subs.churnRate;
    if (churnFromTw == null) return null;
    return churnFromTw > 1 ? churnFromTw / 100 : churnFromTw;
  })();

  // Subscriber rate (% of new customers who subscribe). Override > TW.
  const subscriberRate = (() => {
    if (assumptions.subscriberRateOverride != null) return assumptions.subscriberRateOverride;
    // Derive: newSubscribers / newCustomers if both available
    const orders = tw?.orders != null ? Number(tw.orders) : null;
    const ncDecimal =
      newCustomerPct != null ? (newCustomerPct > 1 ? newCustomerPct / 100 : newCustomerPct) : null;
    if (newSubsTw != null && orders != null && ncDecimal != null) {
      const newCustomers = orders * ncDecimal;
      if (newCustomers > 0) return Math.min(1, newSubsTw / newCustomers);
    }
    return null;
  })();

  const arpuPerSubscriber =
    startingMrr != null && activeSubs && activeSubs > 0 ? startingMrr / activeSubs : null;

  const ltvWindows = {
    day60: cohort?.ltv_60 != null ? Number(cohort.ltv_60) : null,
    day90: cohort?.ltv_90 != null ? Number(cohort.ltv_90) : null,
    day180: cohort?.ltv_180 != null ? Number(cohort.ltv_180) : null,
    day365: cohort?.ltv_365 != null ? Number(cohort.ltv_365) : null,
  };
  const matureCustomers = {
    day60: Number(cohort?.mature_customers_60 ?? 0),
    day90: Number(cohort?.mature_customers_90 ?? 0),
    day180: Number(cohort?.mature_customers_180 ?? 0),
    day365: Number(cohort?.mature_customers_365 ?? 0),
  };

  if (aov == null || aov <= 0) warnings.push("AOV unavailable — using cohort LTV alone.");
  if (
    ltvWindows.day60 == null &&
    ltvWindows.day90 == null &&
    ltvWindows.day180 == null &&
    ltvWindows.day365 == null
  ) {
    warnings.push("No mature cohort LTV yet; tail revenue not modelled.");
  }
  if (churnRate == null && startingMrr != null && startingMrr > 0) {
    warnings.push("Churn rate unavailable — subscriber tail held flat.");
  }
  if (subscriberRate == null) {
    warnings.push("Subscriber rate unavailable — new subs not added to MRR.");
  }

  const cumLtv = buildCumLtvCurve(aov, ltvWindows);
  const incLtv = incrementalFromCum(cumLtv);

  const baseline = baselineNewCustomersFromShopify(market, shopifyMonthly, newCustomerPct);
  if (baseline == null) {
    warnings.push("Insufficient Shopify history — new-customer baseline missing.");
  }

  const confidenceFactor = computeConfidenceFactor(ltvWindows, matureCustomers);

  // Project N(m) for m = 1..horizon
  const N: number[] = new Array(horizon + 1).fill(0);
  N[0] = baseline ?? 0; // a phantom "month 0" used for cohort math
  for (let m = 1; m <= horizon; m++) {
    N[m] = N[m - 1] * (1 + assumptions.monthlyGrowthRate);
  }

  const months: ForecastMonthRow[] = [];
  const totals = {
    newCustomerRevenue: 0,
    oneTimeRepeatRevenue: 0,
    subscriberTailRevenue: 0,
    totalP50: 0,
    totalP90: 0,
  };

  const subRate = subscriberRate ?? 0;
  const oneTimeShare = 1 - subRate;
  const churn = churnRate ?? 0;
  const mrrInit = startingMrr ?? 0;
  const arpu = arpuPerSubscriber ?? 0;

  for (let m = 1; m <= horizon; m++) {
    // Stream 1: new-customer acquisition revenue.
    const newCustomerRevenue = N[m] * (incLtv[0] ?? aov ?? 0);

    // Stream 2: one-time repeat revenue from non-subscriber cohorts
    // acquired in the previous (m-1) … 1 forecast months.
    let oneTimeRepeat = 0;
    for (let k = 1; k <= m && k <= 12; k++) {
      const cohortSize = N[m - k];
      oneTimeRepeat += cohortSize * oneTimeShare * (incLtv[k] ?? 0);
    }

    // Stream 3: subscriber tail.
    //   - existing MRR decayed by churn over m months
    //   - plus MRR from new subscribers acquired in each forecast month,
    //     each decayed by churn for their age.
    let subTail = mrrInit * Math.pow(1 - churn, m);
    for (let k = 1; k <= m; k++) {
      const newSubs = N[m - k + 1] * subRate;
      subTail += newSubs * arpu * Math.pow(1 - churn, k - 1);
    }

    const p50 = newCustomerRevenue + oneTimeRepeat + subTail;
    const p90 = p50 * confidenceFactor;

    const monthIso = addMonthsIso(startMonth, m - 1);
    months.push({
      monthIso,
      monthLabel: monthLabel(monthIso),
      newCustomerRevenue: +newCustomerRevenue.toFixed(2),
      oneTimeRepeatRevenue: +oneTimeRepeat.toFixed(2),
      subscriberTailRevenue: +subTail.toFixed(2),
      totalP50: +p50.toFixed(2),
      totalP90: +p90.toFixed(2),
      newCustomers: +N[m].toFixed(1),
    });
    totals.newCustomerRevenue += newCustomerRevenue;
    totals.oneTimeRepeatRevenue += oneTimeRepeat;
    totals.subscriberTailRevenue += subTail;
    totals.totalP50 += p50;
    totals.totalP90 += p90;
  }

  return {
    market,
    currency: "EUR",
    aov: aov != null ? +aov.toFixed(2) : null,
    baselineNewCustomersPerMonth: baseline,
    monthlyChurnRate: churnRate,
    subscriberRate,
    startingMrr: startingMrr != null ? +startingMrr.toFixed(2) : null,
    arpuPerSubscriber: arpuPerSubscriber != null ? +arpuPerSubscriber.toFixed(2) : null,
    ltvWindows,
    matureCustomers,
    monthlyIncrementalLTV: incLtv.map((v) => +v.toFixed(2)),
    confidenceFactor,
    months,
    totals: {
      newCustomerRevenue: +totals.newCustomerRevenue.toFixed(2),
      oneTimeRepeatRevenue: +totals.oneTimeRepeatRevenue.toFixed(2),
      subscriberTailRevenue: +totals.subscriberTailRevenue.toFixed(2),
      totalP50: +totals.totalP50.toFixed(2),
      totalP90: +totals.totalP90.toFixed(2),
    },
    warnings,
  };
}

// ── Public entrypoint ────────────────────────────────────────────────────

export async function buildRevenueForecast(opts?: {
  startMonth?: string;
  horizonMonths?: number;
  assumptions?: Partial<ForecastAssumptions>;
}): Promise<RevenueForecast> {
  const horizon = Math.min(24, Math.max(1, opts?.horizonMonths ?? 12));
  const now = new Date();
  // Default start = next month (a true forward forecast).
  const defaultStart = addMonthsIso(startOfMonthIso(now), 1);
  const startMonth = opts?.startMonth ?? defaultStart;
  const assumptions: ForecastAssumptions = {
    monthlyGrowthRate: opts?.assumptions?.monthlyGrowthRate ?? 0,
    churnRateOverride: opts?.assumptions?.churnRateOverride ?? null,
    subscriberRateOverride: opts?.assumptions?.subscriberRateOverride ?? null,
  };

  // Use a recent 30-day window so TW has fresh AOV / sub / churn signal.
  // Range cache (5 min) keeps repeat calls cheap.
  const twToDate = todayIso(now);
  const twFromDate = (() => {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return todayIso(d);
  })();

  // All four loaders run in parallel. Each one has its own timeout + cache;
  // failures don't take the whole forecast down — they just degrade that
  // section and surface in the diagnostics strip.
  const [cohortR, twResult, monthlyR, subsR] = await withTimeout(
    Promise.all([
      loadCohortLtvCached(),
      fetchTripleWhaleCached(twFromDate, twToDate),
      loadShopifyMonthlyCached(),
      loadSubscriberStatsCached(twFromDate, twToDate),
    ]),
    FORECAST_OUTER_TIMEOUT_MS,
    "Revenue forecast (outer)",
  );

  const cohort = cohortR.value;
  const subsByMarket = subsR.value;
  const shopifyMonthly = monthlyR.value;

  const twByMarket = new Map<string, any>();
  for (const r of twResult.rows ?? []) {
    if (r?.market) twByMarket.set(String(r.market), r);
  }

  const markets: MarketForecast[] = [];
  for (const market of FORECAST_MARKETS) {
    markets.push(
      computeMarketForecast(
        market,
        startMonth,
        horizon,
        twByMarket.get(market) ?? null,
        cohort.get(market) ?? null,
        shopifyMonthly,
        subsByMarket.get(market) ?? null,
        assumptions,
      ),
    );
  }

  const diagnostics: SourceDiagnostic[] = [
    {
      name: "Triple Whale (30d)",
      ok: twResult.rows.length > 0 && !twResult.error,
      cached: false,
      error: twResult.error,
    },
    {
      name: "Cohort LTV",
      ok: cohort.size > 0 && !cohortR.error,
      cached: cohortR.cached,
      error: cohortR.error,
    },
    {
      name: "Shopify monthly",
      ok: Array.isArray(shopifyMonthly) && shopifyMonthly.length > 0 && !monthlyR.error,
      cached: monthlyR.cached,
      error: monthlyR.error,
    },
    {
      name: "Loop + Juo subscribers",
      ok: subsByMarket.size > 0 && !subsR.error,
      cached: subsR.cached,
      error: subsR.error,
    },
  ];

  return {
    startMonth,
    horizonMonths: horizon,
    assumptions,
    markets,
    fetchedAt: new Date().toISOString(),
    twWarning: twResult.error
      ? `Triple Whale unreachable (${twResult.error}). AOV/MRR/churn defaulted.`
      : null,
    diagnostics,
  };
}
