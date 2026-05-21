import { writeCache, ageMinutes, readCache, type CacheMap } from "./cache.server";
import {
  fetchShopifyMarkets,
  fetchShopifyMonthly,
  fetchShopifyToday,
  fetchShopifyDaily,
  fetchShopifyRepeatFunnel,
  fetchShopifyPayouts,
  fetchPaypalBalances,
  fetchMollieBalances,
  fetchTripleWhale,
  fetchTripleWhaleCustomerEconomics,
  fetchTripleWhaleDaily,
  fetchTripleWhaleShippingMonthly,
  fetchPaymentFeesMonthly,
  fetchJortt,
  fetchJuoRaw,
  fetchLoopRaw,
  fetchSubscriptionRepeatFunnel,
  fetchXero,
} from "./fetchers.server";
import { syncAllLoop } from "./loop-sync.server";
import { fetchPicqerInventory } from "./picqer.server";

// Loop job wrapper: refresh Supabase UK_loop/US_loop from the Loop API,
// then recompute dashboard payload from the DB tables.
async function fetchLoopFull() {
  try {
    await syncAllLoop();
  } catch (err) {
    console.error("[sync] loop DB sync failed (continuing with existing DB rows):", err);
  }
  return fetchLoopRaw();
}

// Module-level guards — prevent duplicate concurrent syncs hammering APIs.
// One in-flight promise per provider/key.
const inFlight = new Map<string, Promise<void>>();

interface Job {
  name: string;
  provider: string;
  key: string;
  fn: () => Promise<unknown>;
  /** Max age (minutes) before this job is considered stale and re-fetched. */
  maxAgeMin: number;
}

const ALL_JOBS: Job[] = [
  {
    name: "shopify_markets",
    provider: "shopify",
    key: "markets",
    fn: () => fetchShopifyMarkets(),
    maxAgeMin: 30,
  },
  {
    name: "shopify_monthly",
    provider: "shopify",
    key: "monthly",
    // Prefer the Postgres mirror (full multi-year history, no 60-day cap).
    // Falls back to the live API only when the mirror hasn't been backfilled
    // yet, so a fresh environment still shows recent months.
    fn: async () => {
      try {
        const dbMod = await import("./shopify-db.server");
        const fromDb = await dbMod.fetchShopifyMonthlyFromDb(13);
        if (fromDb && fromDb.length > 0) return fromDb;
      } catch (err: any) {
        console.warn("[sync] shopify_monthly DB read failed, falling back to live:", err?.message);
      }
      return fetchShopifyMonthly();
    },
    maxAgeMin: 60,
  },
  {
    name: "shopify_today",
    provider: "shopify",
    key: "today",
    fn: fetchShopifyToday,
    maxAgeMin: 10,
  },
  {
    name: "shopify_daily",
    provider: "shopify",
    key: "daily",
    // Mirror-backed (full history); live API fallback when not yet backfilled.
    fn: async () => {
      try {
        const dbMod = await import("./shopify-db.server");
        const fromDb = await dbMod.fetchShopifyDailyFromDb(400);
        if (fromDb && fromDb.daily && Object.keys(fromDb.daily).length > 0) return fromDb;
      } catch (err: any) {
        console.warn("[sync] shopify_daily DB read failed, falling back to live:", err?.message);
      }
      return fetchShopifyDaily();
    },
    maxAgeMin: 720,
  },
  {
    name: "shopify_repeat_funnel",
    provider: "shopify",
    key: "repeat_funnel",
    fn: fetchShopifyRepeatFunnel,
    maxAgeMin: 720,
  },
  {
    name: "shopify_payouts",
    provider: "shopify",
    key: "payouts",
    fn: fetchShopifyPayouts,
    maxAgeMin: 30,
  },
  {
    name: "paypal_balances",
    provider: "paypal",
    key: "balances",
    fn: fetchPaypalBalances,
    maxAgeMin: 30,
  },
  {
    name: "mollie_balances",
    provider: "mollie",
    key: "balances",
    fn: fetchMollieBalances,
    maxAgeMin: 30,
  },
  {
    name: "triplewhale",
    provider: "triplewhale",
    key: "summary",
    fn: () => fetchTripleWhale(),
    maxAgeMin: 30,
  },
  {
    name: "triplewhale_customer_economics",
    provider: "triplewhale",
    key: "customer_economics",
    fn: fetchTripleWhaleCustomerEconomics,
    maxAgeMin: 720,
  },
  {
    name: "triplewhale_daily",
    provider: "triplewhale",
    key: "daily",
    fn: fetchTripleWhaleDaily,
    maxAgeMin: 720,
  },
  {
    name: "triplewhale_shipping_monthly",
    provider: "triplewhale",
    key: "shipping_monthly",
    fn: () => fetchTripleWhaleShippingMonthly(12),
    maxAgeMin: 720,
  },
  {
    name: "payment_fees_monthly",
    provider: "fees",
    key: "monthly",
    fn: () => fetchPaymentFeesMonthly(12),
    maxAgeMin: 720,
  },
  { name: "jortt", provider: "jortt", key: "invoices", fn: fetchJortt, maxAgeMin: 60 },
  { name: "juo", provider: "juo", key: "subscriptions", fn: fetchJuoRaw, maxAgeMin: 60 },
  { name: "loop", provider: "loop", key: "subscriptions", fn: fetchLoopFull, maxAgeMin: 60 },
  {
    name: "subscription_repeat_funnel",
    provider: "subscription",
    key: "repeat_funnel",
    fn: fetchSubscriptionRepeatFunnel,
    maxAgeMin: 720,
  },
  { name: "xero", provider: "xero", key: "accounting", fn: fetchXero, maxAgeMin: 60 },
  // Picqer (TRL Fulfilment) inventory — large product catalogues = slower
  // pagination, so we sync less frequently (6h) than other sources.
  {
    name: "picqer_inventory",
    provider: "picqer",
    key: "inventory",
    fn: async () => {
      // Surface missing-config as a descriptive __error payload (via throw)
      // instead of the generic __empty sentinel — so the sync-status card
      // tells the user *which* env var is missing rather than just
      // "Provider returned empty payload."
      const hasKey = !!(
        process.env.PICQER_API_KEY ||
        process.env.FULFILMENT_API_KEY ||
        process.env.FULLFILMENT_PROVIDER_API_KEY
      );
      const hasSub = !!(
        process.env.PICQER_SUBDOMAIN ||
        process.env.FULFILMENT_SUBDOMAIN ||
        process.env.FULLFILMENT_SUBDOMAIN
      );
      if (!hasKey || !hasSub) {
        const missing: string[] = [];
        if (!hasKey) missing.push("PICQER_API_KEY (or the legacy FULLFILMENT_PROVIDER_API_KEY)");
        if (!hasSub) missing.push("PICQER_SUBDOMAIN");
        throw new Error(
          `Picqer not configured — missing ${missing.join(" and ")} in .env. Add the variable(s) and restart the dev server (Vite only reads .env on boot).`,
        );
      }
      return fetchPicqerInventory();
    },
    maxAgeMin: 360,
  },
];

async function runJob(job: Job): Promise<void> {
  const id = `${job.provider}/${job.key}`;
  const existing = inFlight.get(id);
  if (existing) return existing;
  const p = (async () => {
    try {
      const data = await job.fn();
      if (data === null || data === undefined) {
        // Fetcher returned no data. DO NOT overwrite an existing healthy
        // cache row with an empty marker — that would mask good data behind
        // a transient upstream hiccup. Only write the marker if there is
        // no previous successful payload to preserve.
        const existingRow = await readCache(job.provider, job.key);
        const hasGoodPrevious =
          existingRow?.payload &&
          typeof existingRow.payload === "object" &&
          !(existingRow.payload as any).__empty &&
          !(existingRow.payload as any).__error;
        if (hasGoodPrevious) {
          console.warn(
            `[sync] ${job.name} returned no data — keeping previous cached payload (fetched ${existingRow!.fetchedAt})`,
          );
        } else {
          await writeCache(job.provider, job.key, {
            __empty: true,
            fetchedAt: new Date().toISOString(),
          });
          console.warn(`[sync] ${job.name} returned no data (empty/null)`);
        }
      } else {
        await writeCache(job.provider, job.key, data);
        console.log(`[sync] ${job.name} ok`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync] ${job.name} failed:`, msg);
      // Same protection for hard errors — preserve previously good data.
      const existingRow = await readCache(job.provider, job.key);
      const hasGoodPrevious =
        existingRow?.payload &&
        typeof existingRow.payload === "object" &&
        !(existingRow.payload as any).__empty &&
        !(existingRow.payload as any).__error;
      if (!hasGoodPrevious) {
        await writeCache(job.provider, job.key, {
          __error: true,
          message: msg,
          fetchedAt: new Date().toISOString(),
        });
      }
    } finally {
      inFlight.delete(id);
    }
  })();
  inFlight.set(id, p);
  return p;
}

/**
 * Run a full background sync of every source. Resolves when ALL jobs finish.
 * Use `runAllInBackground()` for fire-and-forget.
 */
export async function runAll(): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  await Promise.all(
    ALL_JOBS.map(async (job) => {
      try {
        await runJob(job);
        results[job.name] = "ok";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results[job.name] = `error: ${msg}`;
      }
    }),
  );
  return results;
}

/** Fire-and-forget — caller does NOT await individual jobs. Uses waitUntil where available so Workers don't kill the promise. */
export function runAllInBackground(): void {
  const p = runAll().catch((e) => console.error("[sync] runAll background error:", e));
  const ER = (globalThis as any).EdgeRuntime;
  if (ER && typeof ER.waitUntil === "function") {
    ER.waitUntil(p);
    return;
  }
  void p;
}

/**
 * Look at the existing cache map and kick off background fetches for any
 * sources whose entry is missing or older than the per-job maxAge.
 * Returns immediately. Safe to call on every dashboard render.
 */
export function refreshStaleInBackground(cache: CacheMap): void {
  for (const job of ALL_JOBS) {
    const entry = cache[`${job.provider}/${job.key}`];
    const age = ageMinutes(entry?.fetchedAt);
    const payload = entry?.payload as any;
    const needsFreshCalc =
      (job.provider === "loop" &&
        job.key === "subscriptions" &&
        !Array.isArray(payload?.__empty) &&
        !payload?.__error &&
        Array.isArray(payload) &&
        payload.some((row: any) => (row?.calcVersion ?? 0) < 4)) ||
      (job.provider === "juo" &&
        job.key === "subscriptions" &&
        !payload?.__error &&
        Array.isArray(payload) &&
        payload.some((row: any) => row?.calcVersion !== 2)) ||
      (job.provider === "shopify" &&
        job.key === "monthly" &&
        !payload?.__error &&
        Array.isArray(payload) &&
        // Accept either the live-API calc (3) or the mirror-backed calc (4).
        payload.some((row: any) => ![3, 4].includes(row?.calcVersion))) ||
      (job.provider === "shopify" &&
        job.key === "daily" &&
        payload &&
        !payload.__empty &&
        !payload.__error &&
        // Live-API daily = 2, mirror-backed daily = 3.
        ![2, 3].includes(payload.calcVersion)) ||
      (job.provider === "shopify" &&
        job.key === "repeat_funnel" &&
        payload &&
        !payload.__empty &&
        !payload.__error &&
        payload.calcVersion !== 6) ||
      (job.provider === "subscription" &&
        job.key === "repeat_funnel" &&
        payload &&
        !payload.__empty &&
        !payload.__error &&
        payload.calcVersion !== 6) ||
      (job.provider === "triplewhale" &&
        job.key === "shipping_monthly" &&
        payload &&
        !payload.__empty &&
        !payload.__error &&
        payload.calcVersion !== 2);
    if (!entry || age > job.maxAgeMin || needsFreshCalc) {
      void runJob(job);
    }
  }
}
