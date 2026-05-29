import { createServerFn } from "@tanstack/react-start";
import { requireAdminUser, requireAllowedUser } from "./auth.middleware";
import { readCache, readCacheKeys, writeCache, ageMinutes, type CacheMap } from "./cache.server";
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
import {
  getChannelPacing,
  upsertChannelTarget,
  deleteChannelTarget,
  PACING_CHANNELS,
  PACING_MARKETS,
  type Channel,
  type Market,
} from "./channel-pacing.server";
import { buildRevenueForecast } from "./revenue-forecast.server";
import {
  listScenarios,
  getScenario,
  deleteScenario,
} from "./scenarios.server";

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
    ["instagram", "followers"],
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

  // Retention (cohort LTV) + per-market unit economics / break-even ROAS.
  // Cheap: one Supabase RPC over the shopify_orders mirror plus pure
  // arithmetic on already-loaded TW + Xero caches. Non-fatal on failure.
  let retentionEconomics: any = null;
  try {
    const { fetchRetentionEconomics } = await import("./retention-economics.server");
    retentionEconomics = await fetchRetentionEconomics(
      Array.isArray(tripleWhaleCache?.payload) ? tripleWhaleCache.payload : null,
      xeroCache?.payload ?? null,
      Array.isArray(shopifyMonthlyCache?.payload) ? shopifyMonthlyCache.payload : null,
    );
  } catch (err: any) {
    console.error("getDashboardData retention economics failed:", err?.message);
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
    instagram: get("instagram", "followers")?.payload ?? null,
    retentionEconomics,
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

// The upstream Instagram proxy (insta-exe.leapcell.app) is hard-capped at
// 5 requests/day per IP. 6h between live fetches → max 4/day with headroom
// for one manual refresh. Override with INSTAGRAM_CACHE_MIN_MINUTES.
const INSTAGRAM_CACHE_MIN_MINUTES =
  Number(process.env.INSTAGRAM_CACHE_MIN_MINUTES) > 0
    ? Number(process.env.INSTAGRAM_CACHE_MIN_MINUTES)
    : 6 * 60;

// Instagram follower sync — proxied endpoint with public-endpoint fallback.
// Writes to data_cache (instagram/followers) so the Valuation page reads
// the live count without re-fetching on every render. Skips the live call
// when the cached entry is younger than INSTAGRAM_CACHE_MIN_MINUTES so we
// stay under the proxy's 5-req/day limit even if this is called repeatedly.
export const triggerInstagramSync = createServerFn({ method: "POST" }).middleware([requireAllowedUser]).handler(async () => {
  const cached = await readCache("instagram", "followers");
  if (cached?.payload && ageMinutes(cached.fetchedAt) < INSTAGRAM_CACHE_MIN_MINUTES) {
    return { ...(cached.payload as any), cached: true, fetchedAt: cached.fetchedAt };
  }
  const { fetchInstagramFollowers } = await import("./instagram.server");
  const result = await fetchInstagramFollowers();
  if (result && result.followers != null) {
    await writeCache("instagram", "followers", result);
    return result;
  }
  if (cached?.payload) {
    return { ...(cached.payload as any), stale: true, liveError: result?.error ?? null };
  }
  return result;
});

export const getInstagramFollowers = createServerFn({ method: "GET" }).middleware([requireAllowedUser]).handler(async () => {
  const cached = await readCache("instagram", "followers");
  return cached?.payload ?? null;
});

// Full Instagram profile (bio, stats, recent posts) for the standalone
// /ig_zapply page. Returns cached payload when it's younger than the
// daily-cache window (protects the 5 req/day proxy quota). Only when the
// cache is stale do we hit the upstream — and if that fails, fall back to
// the last cached payload so the UI stays useful.
export const getInstagramProfile = createServerFn({ method: "GET" }).middleware([requireAllowedUser]).handler(async () => {
  // Bulletproof: never throw — always return a profile-shaped object so the
  // page can render the real error instead of a null (which the UI was
  // mislabelling as a generic "rate-limited").
  try {
    const cached = await readCache("instagram", "profile");
    const cacheAge = ageMinutes(cached?.fetchedAt);
    if (cached?.payload && cacheAge < INSTAGRAM_CACHE_MIN_MINUTES) {
      return { ...(cached.payload as any), cached: true, cacheAgeMinutes: Math.round(cacheAge) };
    }
    const { fetchInstagramProfile } = await import("./instagram.server");
    const live = await fetchInstagramProfile();
    if (live && live.followers != null) {
      await writeCache("instagram", "profile", live);
      // Mirror the followers/following/posts slice into the followers cache
      // so getInstagramFollowers / the Valuation card stay in sync without a
      // second upstream call.
      await writeCache("instagram", "followers", {
        username: live.username,
        followers: live.followers,
        following: live.following,
        posts: live.postsCount,
        source: "public",
        fetchedAt: live.fetchedAt,
      });
      return live;
    }
    if (cached?.payload) {
      return { ...(cached.payload as any), stale: true, liveError: live?.error ?? null };
    }
    return live; // carries the real error string
  } catch (err: any) {
    return {
      username: "zapply_",
      followers: null,
      following: null,
      postsCount: null,
      posts: [],
      fetchedAt: new Date().toISOString(),
      error: `Server error: ${err?.message ?? String(err)}`,
    };
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

// ── Shopify sync triggers ────────────────────────────────────────────────
// Same shape as the Loop trigger pair: a chunked driver that the UI can
// poll until allDone, and a one-shot helper that drains all stores.
export const runShopifySyncChunk = createServerFn({ method: "POST" })
  .middleware([requireAdminUser])
  .inputValidator((input: { store: "NL" | "UK" | "US"; reset?: boolean }) => ({
    store: input.store,
    reset: !!input.reset,
  }))
  .handler(async ({ data }) => {
    const mod = await import("./shopify-sync.server");
    if (data.reset) {
      try {
        await mod.resetShopifyState(data.store);
      } catch (err: any) {
        console.warn("[shopify] resetShopifyState failed (non-fatal):", err?.message);
      }
    }
    // 40s budget keeps a single-store chunk safely under the 60s Vercel
    // function cap (vercel.json). Resumable, so the next click continues.
    const result = await mod.syncShopifyChunk(data.store, {
      maxPages: 30,
      timeBudgetMs: 40_000,
    });
    return result;
  });

export const triggerShopifyFullSync = createServerFn({ method: "POST" })
  .middleware([requireAdminUser])
  .handler(async () => {
    const mod = await import("./shopify-sync.server");
    // 45-second wall budget. The Vercel function cap (vercel.json
    // maxDuration) is 60s; a 90s budget got the function killed mid-run
    // and the browser saw "Failed to fetch". 45s leaves headroom for the
    // final upsert + state write to flush before the platform limit. The
    // sync is resumable, so a click that doesn't finish just means the
    // next click picks up from the saved cursor.
    const startedAt = new Date().toISOString();
    const results = await mod.syncAllShopify({ wallBudgetMs: 45_000 });
    return { ok: true, startedAt, finishedAt: new Date().toISOString(), results };
  });

export const getShopifySyncStatus = createServerFn({ method: "GET" })
  .middleware([requireAllowedUser])
  .handler(async () => {
    const mod = await import("./shopify-sync.server");
    const dbMod = await import("./shopify-db.server");
    const [state, runs, errors, stats] = await Promise.all([
      mod.getShopifySyncState(),
      mod.getShopifySyncRuns(10),
      mod.getShopifySyncErrors(),
      dbMod.getShopifyOrdersStats(),
    ]);
    return { state, runs, errors, stats };
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


// ─── Channel Pacing ────────────────────────────────────────────────────────
// Read-only: any allowed user can view pacing. Writes require admin (targets
// drive supplier-visible decisions, so we don't want every viewer flipping
// them).

function isValidMonthStart(s: string): boolean {
  return /^\d{4}-\d{2}-01$/.test(s);
}
function isValidIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export const getChannelPacingFn = createServerFn({ method: "POST" })
  .middleware([requireAllowedUser])
  .inputValidator((input: { monthStart?: string; today?: string }) => ({
    monthStart:
      typeof input?.monthStart === "string" && isValidMonthStart(input.monthStart)
        ? input.monthStart
        : undefined,
    today:
      typeof input?.today === "string" && isValidIsoDate(input.today)
        ? input.today
        : undefined,
  }))
  .handler(async ({ data }) => {
    try {
      const result = await getChannelPacing({
        monthStart: data.monthStart,
        today: data.today,
      });
      return { ok: true as const, ...result };
    } catch (err: any) {
      console.error("getChannelPacing failed:", err?.message);
      return { ok: false as const, error: err?.message ?? "Failed to load pacing" };
    }
  });

export const setChannelTargetFn = createServerFn({ method: "POST" })
  .middleware([requireAdminUser])
  .inputValidator((input: {
    market: string;
    channel: string;
    month: string;
    spend_target: number;
    roas_target: number;
    notes?: string | null;
  }) => {
    if (!PACING_MARKETS.includes(input.market as Market)) {
      throw new Error(`Invalid market: ${input.market}`);
    }
    if (!PACING_CHANNELS.includes(input.channel as Channel)) {
      throw new Error(`Invalid channel: ${input.channel}`);
    }
    if (!isValidMonthStart(input.month)) {
      throw new Error(`Invalid month (expected YYYY-MM-01): ${input.month}`);
    }
    const spend = Number(input.spend_target);
    const roas = Number(input.roas_target);
    if (!isFinite(spend) || spend < 0) throw new Error("spend_target must be >= 0");
    if (!isFinite(roas) || roas < 0) throw new Error("roas_target must be >= 0");
    return {
      market: input.market as Market,
      channel: input.channel as Channel,
      month: input.month,
      spend_target: spend,
      roas_target: roas,
      notes: input.notes ?? null,
    };
  })
  .handler(async ({ data }) => {
    const res = await upsertChannelTarget(data);
    return res;
  });

export const deleteChannelTargetFn = createServerFn({ method: "POST" })
  .middleware([requireAdminUser])
  .inputValidator((input: { id: string }) => {
    if (!input?.id || typeof input.id !== "string") {
      throw new Error("id is required");
    }
    return { id: input.id };
  })
  .handler(async ({ data }) => {
    const res = await deleteChannelTarget(data.id);
    return res;
  });


// ─── Revenue Forecast (cohort LTV, 3 streams, P50/P90) ─────────────────────
// Read-only — any allowed user can view. Assumptions are passed per request
// so editing scenarios doesn't require admin or DB writes (saved scenarios
// land in a separate feature).
export const getRevenueForecastFn = createServerFn({ method: "POST" })
  .middleware([requireAllowedUser])
  .inputValidator((input: {
    startMonth?: string;
    horizonMonths?: number;
    monthlyGrowthRate?: number;
    churnRateOverride?: number | null;
    subscriberRateOverride?: number | null;
  }) => {
    const out: {
      startMonth?: string;
      horizonMonths?: number;
      assumptions: {
        monthlyGrowthRate?: number;
        churnRateOverride?: number | null;
        subscriberRateOverride?: number | null;
      };
    } = { assumptions: {} };
    if (typeof input?.startMonth === "string" && isValidMonthStart(input.startMonth)) {
      out.startMonth = input.startMonth;
    }
    if (Number.isFinite(input?.horizonMonths)) {
      out.horizonMonths = Math.min(24, Math.max(1, Math.floor(Number(input.horizonMonths))));
    }
    if (Number.isFinite(input?.monthlyGrowthRate)) {
      out.assumptions.monthlyGrowthRate = Number(input.monthlyGrowthRate);
    }
    if (input?.churnRateOverride === null) {
      out.assumptions.churnRateOverride = null;
    } else if (Number.isFinite(input?.churnRateOverride)) {
      out.assumptions.churnRateOverride = Number(input.churnRateOverride);
    }
    if (input?.subscriberRateOverride === null) {
      out.assumptions.subscriberRateOverride = null;
    } else if (Number.isFinite(input?.subscriberRateOverride)) {
      out.assumptions.subscriberRateOverride = Number(input.subscriberRateOverride);
    }
    return out;
  })
  .handler(async ({ data }) => {
    try {
      const result = await buildRevenueForecast({
        startMonth: data.startMonth,
        horizonMonths: data.horizonMonths,
        assumptions: data.assumptions,
      });
      return { ok: true as const, ...result };
    } catch (err: any) {
      console.error("getRevenueForecast failed:", err?.message);
      return { ok: false as const, error: err?.message ?? "Forecast failed" };
    }
  });

// ─── Forecast scenarios (saved what-if forecasts) ──────────────────────────
// Returns are run through JSON.parse(JSON.stringify(...)) so the TanStack
// Start serializer doesn't choke on jsonb columns (assumptions/events) typed
// as Record<string, unknown> / mixed shapes.
function jsonClean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const listScenariosFn = createServerFn({ method: "POST" })
  .middleware([requireAllowedUser])
  .handler(async () => {
    try {
      const rows = await listScenarios();
      return jsonClean({ ok: true as const, scenarios: rows as any[] });
    } catch (err: any) {
      return { ok: false as const, error: err?.message ?? "Failed to list scenarios" };
    }
  });

export const loadScenarioFn = createServerFn({ method: "POST" })
  .middleware([requireAllowedUser])
  .inputValidator((input: { id: string }) => {
    if (!input?.id || typeof input.id !== "string") throw new Error("id required");
    return { id: input.id };
  })
  .handler(async ({ data }) => {
    const scenario = await getScenario(data.id);
    if (!scenario) return { ok: false as const, error: "Scenario not found" };
    try {
      const forecast = await buildRevenueForecast({
        horizonMonths: scenario.assumptions.horizonMonths,
        assumptions: scenario.assumptions,
      });
      return jsonClean({
        ok: true as const,
        scenario: scenario as any,
        forecast: forecast as any,
      });
    } catch (err: any) {
      return { ok: false as const, error: err?.message ?? "Forecast failed" };
    }
  });

export const deleteScenarioFn = createServerFn({ method: "POST" })
  .middleware([requireAdminUser])
  .inputValidator((input: { id: string }) => {
    if (!input?.id || typeof input.id !== "string") throw new Error("id required");
    return { id: input.id };
  })
  .handler(async ({ data }) => await deleteScenario(data.id));
