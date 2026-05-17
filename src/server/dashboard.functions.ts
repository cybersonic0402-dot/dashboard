import { createServerFn } from "@tanstack/react-start";
import { requireAdminUser, requireAllowedUser } from "./auth.middleware";
import { readCacheKeys, writeCache, ageMinutes, type CacheMap } from "./cache.server";
import { refreshStaleInBackground, runAll } from "./sync.server";
import {
  fetchTripleWhale,
  fetchTripleWhaleCustomerEconomics,
  fetchShopifyGrowthYear,
  fetchXero,
} from "./fetchers.server";
import { getProgress } from "./progress.server";
import { fetchPicqerInventory, probePicqer } from "./picqer.server";
// Loop integration imports — hoisted here from mid-file (they used to live
// just before getLoopStoreStatus). The TanStack Start server-function
// splitter does AST analysis on this module and gets confused by top-level
// imports placed after createServerFn declarations, intermittently dropping
// the export immediately preceding the imports from its virtual-module
// registry. Symptom: "Invalid server function ID:
// getSyncStatus_createServerFn_handler" with no apparent compile error.
import { getLoopDbStatus, getLoopApiPending } from "./loop-db.server";
import { resetLoopState, getLoopSyncState, getLoopSyncRuns, getLoopSyncErrors } from "./loop-sync.server";
import { triggerRemoteLoopSync, isRemoteLoopSyncConfigured } from "./loop-remote.server";

// In-memory range cache (per Worker instance). Triple Whale aggregates are
// expensive (4 stores × external API). For a given (from,to) range the data
// is identical for everyone, so we can safely cache it for a few minutes.
const RANGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const rangeCache = new Map<
  string,
  { rows: any[]; error: string | null; fetchedAt: number }
>();
const inflight = new Map<string, Promise<{ rows: any[]; error: string | null }>>();

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export const getTripleWhaleRange = createServerFn({ method: "POST" }).middleware([requireAllowedUser])
  .inputValidator((input: { from: string; to: string }) => input)
  .handler(async ({ data }) => {
    const key = `${data.from}|${data.to}`;
    const now = Date.now();

    // 1) Serve from cache if fresh
    const cached = rangeCache.get(key);
    if (cached && now - cached.fetchedAt < RANGE_TTL_MS) {
      return { rows: cached.rows, error: cached.error };
    }

    // 2) De-duplicate concurrent requests for the same range
    const pending = inflight.get(key);
    if (pending) return await pending;

    const task = (async () => {
      try {
        const rows = await withTimeout(
          fetchTripleWhale(data.from, data.to, key),
          150_000,
          "Triple Whale fetch"
        );
        const result = { rows: (rows ?? []) as any[], error: null as string | null };
        rangeCache.set(key, { ...result, fetchedAt: Date.now() });
        return result;
      } catch (err: any) {
        console.error("getTripleWhaleRange failed:", err?.message);
        const result = {
          rows: [] as any[],
          error: err?.message?.includes("timed out")
            ? "Triple Whale is taking too long. Please try again."
            : "Failed to load Triple Whale data",
        };
        return result;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, task);
    return await task;
  });

export const getTripleWhaleProgress = createServerFn({ method: "POST" }).middleware([requireAllowedUser])
  .inputValidator((input: { from: string; to: string }) => input)
  .handler(async ({ data }) => {
    const key = `${data.from}|${data.to}`;
    const p = getProgress(key);
    if (!p) {
      return { total: 0, fetched: 0, remaining: 0, stores: [], done: true } as const;
    }
    return {
      total: p.total,
      fetched: p.fetched,
      remaining: p.remaining,
      stores: p.stores,
      done: p.done,
    };
  });

function getConnections(): Record<string, string> {
  const connections: Record<string, string> = {};
  if (process.env.SHOPIFY_APP_CLIENT_ID && process.env.SHOPIFY_APP_CLIENT_SECRET) {
    const stores = ["SHOPIFY_NL_STORE", "SHOPIFY_UK_STORE", "SHOPIFY_US_STORE"];
    for (const key of stores) {
      const v = process.env[key];
      if (v) {
        connections["shopify"] = "connected";
        connections[`shopify_${v.replace(".myshopify.com", "")}`] = "connected";
      }
    }
  }
  if (process.env.JORTT_CLIENT_ID) connections["jortt"] = "connected";
  if (process.env.JUO_NL_API_KEY) connections["juo"] = "connected";
  if (process.env.LOOP_UK_API_KEY || process.env.LOOP_US_API_KEY || process.env.LOOP_EU_API_KEY)
    connections["loop"] = "connected";
  if (process.env.TRIPLE_WHALE_API_KEY) connections["triplewhale"] = "connected";
  if (process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET) connections["xero"] = "connected";
  if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) connections["paypal"] = "connected";
  if (process.env.MOLLIE_API_KEY) connections["mollie"] = "connected";
  // Picqer-backed fulfilment provider (e.g. TRL Fulfilment). Accept the
  // canonical PICQER_* names plus the legacy FULLFILMENT_PROVIDER_API_KEY
  // typo'd name so existing .env files keep working.
  if (
    (process.env.PICQER_API_KEY ||
      process.env.FULFILMENT_API_KEY ||
      process.env.FULLFILMENT_PROVIDER_API_KEY) &&
    (process.env.PICQER_SUBDOMAIN ||
      process.env.FULFILMENT_SUBDOMAIN ||
      process.env.FULLFILMENT_SUBDOMAIN)
  ) {
    connections["picqer"] = "connected";
  }
  return connections;
}

function describePayload(payload: any): { ok: boolean; reason: string | null; rows: number | null } {
  if (payload == null) return { ok: false, reason: "No data cached yet", rows: null };
  if (typeof payload === "object") {
    if (payload.__error) return { ok: false, reason: String(payload.message ?? payload.__error).slice(0, 700), rows: null };
    if (payload.__empty) return { ok: false, reason: "Provider returned empty payload", rows: 0 };
  }
  const rows = Array.isArray(payload)
    ? payload.length
    : Array.isArray(payload?.rows)
      ? payload.rows.length
      : Array.isArray(payload?.funnel)
        ? payload.funnel.length
        : null;
  return { ok: true, reason: null, rows };
}

function buildSourceStatus(cache: CacheMap) {
  const conns = getConnections();
  const get = (p: string, k: string) => cache[`${p}/${k}`] ?? null;
  function entry(provider: string, key: string, label: string, expected: string, maxAge = 60) {
    const c = get(provider, key);
    const d = describePayload(c?.payload);
    const connected = !!conns[provider];
    let status: "healthy" | "degraded" | "error" | "disconnected";
    if (!connected) status = "disconnected";
    else if (!c || !d.ok) status = "error";
    else if (ageMinutes(c.fetchedAt) > maxAge) status = "degraded";
    else status = "healthy";
    return { provider, key, label, expected, connected, status, lastSyncedAt: c?.fetchedAt ?? null, ageMinutes: c?.fetchedAt ? ageMinutes(c.fetchedAt) : null, rowCount: d.rows, error: d.reason };
  }

  const sources = [
    entry("shopify", "markets", "Shopify Plus · Markets", "Per-market revenue, orders, AOV and FX", 30),
    entry("shopify", "monthly", "Shopify Plus · Monthly", "Historical revenue and orders by month", 120),
    entry("shopify", "today", "Shopify Plus · Today", "Today orders and revenue", 15),
    entry("shopify", "daily", "Shopify Plus · Daily", "Daily revenue for profit math", 720),
    entry("shopify", "repeat_funnel", "Shopify Plus · Repeat funnel", "Customer order-history cohorts", 720),
    entry("shopify", "payouts", "Shopify Payments · Payouts", "Pending balances and scheduled payouts per market", 60),
    entry("paypal", "balances", "PayPal · Balances", "Live PayPal account balances", 60),
    entry("mollie", "balances", "Mollie · Balances", "Live Mollie balances (available + pending)", 60),
    entry("triplewhale", "summary", "Triple Whale · Summary", "Ad spend, ROAS, MER and gross profit", 30),
    entry("triplewhale", "customer_economics", "Triple Whale · Customer economics", "NCPA, 90D LTV and 365D LTV", 720),
    entry("triplewhale", "daily", "Triple Whale · Daily", "Daily ad spend for profit math", 720),
    entry("juo", "subscriptions", "Juo · Subscriptions (NL)", "Active subs, churn and MRR", 60),
    entry("loop", "subscriptions", "Loop · Subscriptions (UK/US/EU)", "Active subs, churn and MRR", 60),
    entry("jortt", "invoices", "Jortt · Invoices", "Invoices, OpEx and accounting bridge", 120),
    entry("xero", "accounting", "Xero · Accounting", "P&L, cash and balance sheet", 120),
    entry("picqer", "inventory", "Picqer · Inventory", "Per-warehouse stock from TRL Fulfilment", 360),
  ];
  return {
    sources,
    failing: sources.filter((s) => s.status === "error" || s.status === "disconnected"),
    degraded: sources.filter((s) => s.status === "degraded"),
    healthy: sources.filter((s) => s.status === "healthy"),
    checkedAt: Date.now(),
  };
}

export const getDashboardData = createServerFn({ method: "GET" }).middleware([requireAllowedUser]).handler(async () => {
  const cache = await readCacheKeys([
    ["shopify", "markets"],
    ["shopify", "monthly"],
    ["shopify", "today"],
    ["shopify", "daily"],
    ["shopify", "repeat_funnel"],
    ["shopify", "payouts"],
    ["paypal", "balances"],
    ["mollie", "balances"],
    ["triplewhale", "summary"],
    ["triplewhale", "customer_economics"],
    ["triplewhale", "daily"],
    ["triplewhale", "shipping_monthly"],
    ["fees", "monthly"],
    ["juo", "subscriptions"],
    ["loop", "subscriptions"],
    ["subscription", "repeat_funnel"],
    ["jortt", "invoices"],
    ["xero", "accounting"],
    ["picqer", "inventory"],
  ]);
  const get = (provider: string, key: string) => cache[`${provider}/${key}`] ?? null;

  // Fire-and-forget background refresh for any source whose cache entry is
  // missing or older than its max age. Dashboard returns instantly with
  // whatever is currently cached (stale-while-revalidate).
  refreshStaleInBackground(cache);

  const shopifyMarketsCache = get("shopify", "markets");
  const shopifyMonthlyCache = get("shopify", "monthly");
  const shopifyTodayCache = get("shopify", "today");
  const shopifyDailyCache = get("shopify", "daily");
  const shopifyRepeatFunnelCache = get("shopify", "repeat_funnel");
  const shopifyPayoutsCache = get("shopify", "payouts");
  const paypalBalancesCache = get("paypal", "balances");
  const mollieBalancesCache = get("mollie", "balances");
  const tripleWhaleCache = get("triplewhale", "summary");
  const tripleWhaleCustomerEconomicsCache = get("triplewhale", "customer_economics");
  const tripleWhaleDailyCache = get("triplewhale", "daily");
  const tripleWhaleShippingMonthlyCache = get("triplewhale", "shipping_monthly");
  const paymentFeesMonthlyCache = get("fees", "monthly");
  const juoCache = get("juo", "subscriptions");
  const loopCache = get("loop", "subscriptions");
  const subscriptionRepeatFunnelCache = get("subscription", "repeat_funnel");
  const jorttCache = get("jortt", "invoices");
  const xeroCache = get("xero", "accounting");
  const picqerCache = get("picqer", "inventory");

  const syncTimes = [shopifyMarketsCache, tripleWhaleCache, juoCache, loopCache, xeroCache]
    .filter(Boolean)
    .map((c) => c!.fetchedAt);
  const oldestSyncedAt =
    syncTimes.length > 0 ? syncTimes.reduce((a, b) => (a < b ? a : b)) : null;

  const dataIsStale = ageMinutes(oldestSyncedAt) > 30;
  const hasAnyData = !!(shopifyMarketsCache || tripleWhaleCache || loopCache || juoCache || xeroCache);
  let tripleWhaleCustomerEconomics = tripleWhaleCustomerEconomicsCache?.payload ?? null;
  if (!tripleWhaleCustomerEconomics || ageMinutes(tripleWhaleCustomerEconomicsCache?.fetchedAt) > 720) {
    try {
      const fresh = await withTimeout(fetchTripleWhaleCustomerEconomics(), 12_000, "Triple Whale customer economics");
      if (fresh) {
        tripleWhaleCustomerEconomics = fresh;
        await writeCache("triplewhale", "customer_economics", fresh);
      }
    } catch (err: any) {
      console.error("getDashboardData customer economics failed:", err?.message);
    }
  }

  // Build a structured errors map so the UI can show *why* a tile is empty
  // (e.g., "Shopify token expired" vs. "no data yet"). Reads the __error and
  // __empty sentinels written by sync.server.ts.
  const errors: Record<string, string> = {};
  const collectError = (label: string, c: { payload: any } | null) => {
    const p = c?.payload;
    if (!p || typeof p !== "object") return;
    if ((p as any).__error) {
      errors[label] = String((p as any).message ?? "fetch failed").slice(0, 700);
    } else if ((p as any).__empty) {
      errors[label] = "Source returned empty payload";
    }
  };
  collectError("shopifyMarkets", shopifyMarketsCache);
  collectError("shopifyMonthly", shopifyMonthlyCache);
  collectError("shopifyToday", shopifyTodayCache);
  collectError("shopifyDaily", shopifyDailyCache);
  collectError("shopifyRepeatFunnel", shopifyRepeatFunnelCache);
  collectError("shopifyPayouts", shopifyPayoutsCache);
  collectError("paypalBalances", paypalBalancesCache);
  collectError("mollieBalances", mollieBalancesCache);
  collectError("tripleWhale", tripleWhaleCache);
  collectError("tripleWhaleCustomerEconomics", tripleWhaleCustomerEconomicsCache);
  collectError("tripleWhaleDaily", tripleWhaleDailyCache);
  collectError("juo", juoCache);
  collectError("loop", loopCache);
  collectError("subscriptionRepeatFunnel", subscriptionRepeatFunnelCache);
  collectError("jortt", jorttCache);
  collectError("xero", xeroCache);
  collectError("picqer", picqerCache);

  // Cash and inventory now come exclusively from real sources — Xero +
  // banking platforms for cash, Picqer for inventory. The manual
  // cash_positions / inventory_positions tables (and the /admin/manual-data
  // page that fed them) were retired. Only app_settings remains here for
  // user-editable configuration (min_cash_buffer_eur, market_costs).
  let manual: {
    cashPositions: any[];
    inventoryPositions: any[];
    manualInventoryCount: 0;
    picqerInventoryCount: number;
    inventorySource: "picqer" | "none";
    settings: Record<string, any>;
  } = {
    cashPositions: [],
    inventoryPositions: [],
    manualInventoryCount: 0,
    picqerInventoryCount: 0,
    inventorySource: "none",
    settings: {},
  };
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: settingsRows } = await supabaseAdmin.from("app_settings").select("*");
    const settingsMap: Record<string, any> = {};
    for (const r of settingsRows ?? []) settingsMap[r.key] = r.value;
    // Inventory positions = whatever Picqer returns. Manual augmentation
    // is no longer accepted, so no merge step.
    const picqerPayload = picqerCache?.payload as any;
    const picqerRows: any[] =
      picqerPayload &&
      typeof picqerPayload === "object" &&
      !picqerPayload.__error &&
      !picqerPayload.__empty &&
      Array.isArray(picqerPayload.rows)
        ? picqerPayload.rows
        : [];
    const sortedRows = [...picqerRows].sort((a, b) =>
      String(a.sku).localeCompare(String(b.sku)) ||
      String(a.location ?? "").localeCompare(String(b.location ?? "")),
    );
    manual = {
      cashPositions: [],
      inventoryPositions: sortedRows,
      manualInventoryCount: 0,
      picqerInventoryCount: picqerRows.length,
      inventorySource: picqerRows.length > 0 ? "picqer" : "none",
      settings: settingsMap,
    };
  } catch (err: any) {
    console.error("getDashboardData manual data failed:", err?.message);
  }

  return {
    shopifyMarkets: shopifyMarketsCache?.payload ?? null,
    shopifyMonthly: shopifyMonthlyCache?.payload ?? null,
    shopifyToday: shopifyTodayCache?.payload ?? null,
    shopifyDaily: shopifyDailyCache?.payload ?? null,
    shopifyRepeatFunnel: shopifyRepeatFunnelCache?.payload ?? null,
    shopifyPayouts: shopifyPayoutsCache?.payload ?? null,
    paypalBalances: paypalBalancesCache?.payload ?? null,
    mollieBalances: mollieBalancesCache?.payload ?? null,
    tripleWhale: tripleWhaleCache?.payload ?? null,
    tripleWhaleCustomerEconomics,
    tripleWhaleDaily: tripleWhaleDailyCache?.payload ?? null,
    tripleWhaleShippingMonthly: tripleWhaleShippingMonthlyCache?.payload ?? null,
    paymentFeesMonthly: paymentFeesMonthlyCache?.payload ?? null,
    juo: juoCache?.payload ?? null,
    loop: loopCache?.payload ?? null,
    subscriptionRepeatFunnel: subscriptionRepeatFunnelCache?.payload ?? null,
    jortt: jorttCache?.payload ?? null,
    xero: xeroCache?.payload ?? null,
    picqer: picqerCache?.payload ?? null,
    connections: getConnections(),
    sourceStatus: buildSourceStatus(cache),
    syncedAt: oldestSyncedAt,
    dataIsStale,
    hasAnyData,
    errors,
    manual,
  };
});

export const getSyncStatus = createServerFn({ method: "GET" }).middleware([requireAllowedUser]).handler(async () => {
  const cache = await readCacheKeys([
    ["shopify", "markets"],
    ["shopify", "monthly"],
    ["shopify", "today"],
    ["shopify", "daily"],
    ["shopify", "repeat_funnel"],
    ["shopify", "payouts"],
    ["paypal", "balances"],
    ["mollie", "balances"],
    ["triplewhale", "summary"],
    ["triplewhale", "customer_economics"],
    ["triplewhale", "daily"],
    ["juo", "subscriptions"],
    ["loop", "subscriptions"],
    ["subscription", "repeat_funnel"],
    ["jortt", "invoices"],
    ["xero", "accounting"],
    ["picqer", "inventory"],
  ]);
  return buildSourceStatus(cache);
});

export const triggerSyncNow = createServerFn({ method: "POST" }).middleware([requireAdminUser]).handler(async () => {
  const results = await runAll();
  return { ok: true, finishedAt: new Date().toISOString(), results };
});

export const triggerXeroSyncNow = createServerFn({ method: "POST" }).middleware([requireAllowedUser]).handler(async () => {
  try {
    const live = await withTimeout(fetchXero(), 90_000, "Xero sync");
    await writeCache("xero", "accounting", live);
    return { ok: true, finishedAt: new Date().toISOString(), error: null };
  } catch (err: any) {
    const message = err?.message ?? "Xero sync failed";
    await writeCache("xero", "accounting", {
      __error: true,
      message,
      fetchedAt: new Date().toISOString(),
    });
    return { ok: false, finishedAt: new Date().toISOString(), error: message };
  }
});

// Force a Picqer (TRL Fulfilment) inventory pull. Same shape as the Xero
// trigger above — succeeds with payload, or writes a `__error` cache row so
// the inventory UI can show what went wrong.
export const triggerPicqerSyncNow = createServerFn({ method: "POST" }).middleware([requireAllowedUser]).handler(async () => {
  try {
    const live = await withTimeout(fetchPicqerInventory(), 60_000, "Picqer inventory sync");
    await writeCache("picqer", "inventory", live);
    return { ok: true, finishedAt: new Date().toISOString(), error: null, rows: live.totalRows };
  } catch (err: any) {
    const message = err?.message ?? "Picqer sync failed";
    await writeCache("picqer", "inventory", {
      __error: true,
      message,
      fetchedAt: new Date().toISOString(),
    });
    return { ok: false, finishedAt: new Date().toISOString(), error: message };
  }
});

// Reachability probe — returns auth/config status without paginating /products.
// Useful when first setting up the .env keys.
export const probePicqerConnection = createServerFn({ method: "GET" }).middleware([requireAllowedUser]).handler(async () => {
  return await probePicqer();
});

// ── Loop DB status / full sync ────────────────────────────────────────────────
// (Loop-related imports are hoisted to the top of this file; see the
// comment near line 13 for why.)

export const getLoopStoreStatus = createServerFn({ method: "GET" })
  .middleware([requireAdminUser])
  .handler(async () => {
    const [stores, syncState, runs, errors] = await Promise.all([
      getLoopDbStatus(),
      getLoopSyncState(),
      getLoopSyncRuns(24),
      getLoopSyncErrors(),
    ]);
    return { stores, syncState, runs, errors, checkedAt: Date.now() };
  });

export const getLoopApiPendingCount = createServerFn({ method: "POST" })
  .middleware([requireAdminUser])
  .handler(async () => {
    return { results: await getLoopApiPending(), checkedAt: Date.now() };
  });

// Resumable-chunk API kept for backwards compatibility with the existing UI.
// When LOOP_SYNC_SERVICE_URL is set we delegate the whole sync to the hosted
// microservice (Railway) — the UI no longer needs to drive the pagination
// itself, so a single call kicks off the remote sync and reports allDone=true
// so the UI's loop exits immediately. Row counts in Supabase keep updating
// in the background; getLoopStoreStatus reflects that progress live.
export const runLoopSyncChunk = createServerFn({ method: "POST" })
  .middleware([requireAdminUser])
  .inputValidator((input: { market: "UK" | "US"; reset?: boolean }) => ({
    market: input.market === "UK" ? ("UK" as const) : ("US" as const),
    reset: !!input.reset,
  }))
  .handler(async ({ data }) => {
    if (!isRemoteLoopSyncConfigured()) {
      throw new Error(
        "LOOP_SYNC_SERVICE_URL is not set — configure the hosted microservice or revert to in-process sync.",
      );
    }
    // Only trigger remote sync on the first (reset) call to avoid re-firing
    // the long-running Railway job every poll iteration. Follow-up chunk
    // calls just return allDone=true so the UI loop exits cleanly.
    if (data.reset) {
      try {
        await resetLoopState(data.market);
      } catch (err: any) {
        // resetLoopState writes to loop_sync_state, which the remote service
        // doesn't drive anymore. Failing to reset isn't fatal.
        console.warn("[loop] resetLoopState failed (non-fatal):", err?.message);
      }
      const remote = await triggerRemoteLoopSync(data.market);
      if (!remote.ok) {
        return {
          market: data.market,
          pagesFetched: 0,
          rowsUpserted: 0,
          perStatus: {},
          allDone: true,
          lastError: `remote sync rejected: HTTP ${remote.status} ${JSON.stringify(remote.body).slice(0, 200)}`,
        };
      }
    }
    return {
      market: data.market,
      pagesFetched: 0,
      rowsUpserted: 0,
      perStatus: {},
      allDone: true,
      remote: true,
      message: "Sync handed off to Railway microservice — UK_loop / US_loop will keep updating for the next 10–15 minutes.",
    };
  });

export const triggerLoopFullSync = createServerFn({ method: "POST" })
  .middleware([requireAdminUser])
  .handler(async () => {
    if (!isRemoteLoopSyncConfigured()) {
      throw new Error(
        "LOOP_SYNC_SERVICE_URL is not set — configure the hosted microservice or revert to in-process sync.",
      );
    }
    const startedAt = new Date().toISOString();
    const remote = await triggerRemoteLoopSync();
    // The dashboard data_cache row for "loop/subscriptions" is repopulated
    // on the next getDashboardData call via refreshStaleInBackground — no
    // need to fetchLoopFromDb here while Railway is still mid-write.
    return {
      ok: remote.ok,
      remote: true as const,
      startedAt,
      finishedAt: new Date().toISOString(),
      sync: remote.body == null ? null : (JSON.parse(JSON.stringify(remote.body)) as { started?: boolean; market?: string; error?: string }),
      url: remote.url,
      status: remote.status,
    };
  });


// In-memory cache for Growth Plan year data — 10 minutes per year.
// Bump GROWTH_YEAR_CACHE_VERSION to invalidate previously cached partial fetches.
const GROWTH_YEAR_TTL_MS = 10 * 60 * 1000;
const GROWTH_YEAR_CACHE_VERSION = 3;
const growthYearCache = new Map<string, { data: any; fetchedAt: number }>();
const growthYearInflight = new Map<string, Promise<any>>();

export const getGrowthYearData = createServerFn({ method: "POST" }).middleware([requireAllowedUser])
  .inputValidator((input: { year: number }) => ({ year: Number(input.year) }))
  .handler(async ({ data }) => {
    const year = data.year;
    if (!Number.isInteger(year) || year < 2015 || year > 2100) {
      return { ok: false, error: "Invalid year" } as const;
    }
    const cacheKey = `${GROWTH_YEAR_CACHE_VERSION}:${year}`;
    const now = Date.now();
    const cached = growthYearCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < GROWTH_YEAR_TTL_MS) {
      return { ok: true, ...cached.data } as const;
    }
    const pending = growthYearInflight.get(cacheKey);
    if (pending) return await pending;

    const task = (async () => {
      try {
        const result = await withTimeout(
          fetchShopifyGrowthYear(year),
          240_000,
          `Growth Year ${year}`,
        );
        if (!result) return { ok: false, error: "No Shopify data for that year" } as const;
        growthYearCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
        return { ok: true, ...result } as const;
      } catch (err: any) {
        return { ok: false, error: err?.message ?? "fetch failed" } as const;
      } finally {
        growthYearInflight.delete(cacheKey);
      }
    })();
    growthYearInflight.set(cacheKey, task);
    return await task;
  });
