import { createServerFn } from "@tanstack/react-start";
import { requireAllowedUser } from "./auth.middleware";
import { z } from "zod";
import {
  fetchShopifyStoreDetail,
  fetchLoopMarketDetail,
  fetchJuoDetail,
  fetchJorttInvoiceDetail,
} from "./dashboard-detail.server";
import { fetchTripleWhale, fetchXero } from "./fetchers.server";
import { readCache, writeCache, ageMinutes } from "./cache.server";

/**
 * CACHE-FIRST strategy for dashboard pages.
 *
 * - Each (provider, store, range) combo has its own cache row.
 * - GET reads only the requested cache row and returns it immediately.
 * - If the cache is stale OR missing, a background refresh is scheduled;
 *   missing cache no longer blocks the user on slow upstream APIs.
 * - When the user hits "Refresh" the page passes force=true and the
 *   server awaits the live fetch (and writes it back).
 *
 * Result: dashboard UI is never held hostage by paginated upstream APIs.
 */

const dateRangeSchema = z.object({
  from: z.string(),
  to: z.string(),
  force: z.boolean().optional(),
});

const STALE_MIN = 30; // minutes — refresh cached entries older than this in the background

function subscriptionSummaryFallback(summary: any, storeCode: "NL" | "UK" | "US") {
  const row = (Array.isArray(summary) ? summary : []).find((item) => item?.market === storeCode);
  if (!row) return null;
  return {
    live: row.live === true,
    platform: row.platform ?? (storeCode === "NL" ? "juo" : "loop"),
    market: storeCode,
    currency: row.currency ?? (storeCode === "US" ? "USD" : storeCode === "UK" ? "GBP" : "EUR"),
    summaryOnly: true,
    totals: {
      total: row.totalFetched ?? row.activeSubs ?? 0,
      active: row.activeSubs ?? 0,
      canceled: row.canceledSubs ?? row.churnedThisMonth ?? 0,
      newInRange: row.newThisMonth ?? 0,
      mrr: row.mrr ?? 0,
      arpu: row.arpu ?? 0,
    },
    subscriptions: [],
  };
}

// Background-safe scheduler for the Worker runtime.
function scheduleBackground(p: Promise<unknown>) {
  const ER = (globalThis as any).EdgeRuntime;
  if (ER && typeof ER.waitUntil === "function") {
    ER.waitUntil(p);
  }
  // Fallback: just let it run. Errors are swallowed.
  p.catch(() => {});
}

const inFlight = new Map<string, Promise<any>>();

async function dedupedFetch<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

interface CacheReadResult<T> {
  data: T | null;
  fetchedAt: string | null;
  source: "cache" | "live" | "none";
  ageMinutes: number;
  error: string | null;
}

/**
 * Cache-first wrapper:
 *  - If cache hit: return it. If stale, kick off background refresh.
 *  - If cache miss: return immediately and populate cache in the background.
 *  - If force=true: do live fetch synchronously regardless.
 */
async function cacheFirst<T>(
  provider: string,
  cacheKey: string,
  liveFetch: () => Promise<T>,
  opts: { force?: boolean } = {}
): Promise<CacheReadResult<T>> {
  const fullKey = `${provider}/${cacheKey}`;

  // Read just the cache row needed for this dashboard/filter combo.
  const entry = await readCache(provider, cacheKey);

  // Force refresh path: do live now and write
  if (opts.force) {
    try {
      const live = await dedupedFetch(fullKey, liveFetch);
      await writeCache(provider, cacheKey, live);
      return { data: live, fetchedAt: new Date().toISOString(), source: "live", ageMinutes: 0, error: null };
    } catch (err: any) {
      // Fall back to cache if live fails
      if (entry?.payload && !entry.payload.__error) {
        return {
          data: entry.payload as T,
          fetchedAt: entry.fetchedAt,
          source: "cache",
          ageMinutes: ageMinutes(entry.fetchedAt),
          error: err?.message ?? String(err),
        };
      }
      return { data: null, fetchedAt: null, source: "none", ageMinutes: Infinity, error: err?.message ?? String(err) };
    }
  }

  // Cache hit
  if (entry?.payload && !entry.payload.__error && !entry.payload.__empty) {
    const age = ageMinutes(entry.fetchedAt);
    // Stale → kick off background refresh, but return cached data NOW
    if (age > STALE_MIN) {
      scheduleBackground(
        dedupedFetch(fullKey, liveFetch)
          .then((live) => writeCache(provider, cacheKey, live))
          .catch((e) => console.error(`[bg-refresh] ${fullKey}:`, e?.message))
      );
    }
    return {
      data: entry.payload as T,
      fetchedAt: entry.fetchedAt,
      source: "cache",
      ageMinutes: age,
      error: null,
    };
  }

  // Cache miss — do NOT block the user. Populate cache for the next request.
  scheduleBackground(
    dedupedFetch(fullKey, liveFetch)
      .then((live) => writeCache(provider, cacheKey, live))
      .catch((e) => console.error(`[bg-fill] ${fullKey}:`, e?.message))
  );
  return { data: null, fetchedAt: null, source: "none", ageMinutes: Infinity, error: null };
}

// ─── Store dashboard (Shopify) ──────────────────────────────────────────────
export const getStoreDashboard = createServerFn({ method: "GET" }).middleware([requireAllowedUser])
  .inputValidator(
    dateRangeSchema.extend({
      storeCode: z.enum(["NL", "UK", "US"]),
    })
  )
  .handler(async ({ data }) => {
    const cacheKey = `detail_${data.storeCode}_${data.from}_${data.to}`;
    const result = await cacheFirst(
      "shopify",
      cacheKey,
      () => fetchShopifyStoreDetail(data.storeCode, data.from, data.to),
      { force: data.force }
    );
    return {
      detail: result.data,
      source: result.source,
      fetchedAt: result.fetchedAt,
      ageMinutes: result.ageMinutes,
      error: result.error,
    };
  });

// ─── Triple Whale dashboard ─────────────────────────────────────────────────
export const getTripleWhaleDashboard = createServerFn({ method: "GET" }).middleware([requireAllowedUser])
  .inputValidator(dateRangeSchema)
  .handler(async ({ data }) => {
    const cacheKey = `summary_${data.from}_${data.to}`;
    const result = await cacheFirst(
      "triplewhale",
      cacheKey,
      () => fetchTripleWhale(data.from, data.to),
      { force: data.force }
    );
    return {
      data: result.data,
      source: result.source,
      fetchedAt: result.fetchedAt,
      ageMinutes: result.ageMinutes,
      error: result.error,
    };
  });

// ─── Subscription dashboard (Loop UK/US/EU OR Juo NL) ───────────────────────
export const getSubscriptionDashboard = createServerFn({ method: "GET" }).middleware([requireAllowedUser])
  .inputValidator(
    dateRangeSchema.extend({
      storeCode: z.enum(["NL", "UK", "US"]),
    })
  )
  .handler(async ({ data }) => {
    const platform = data.storeCode === "NL" ? "juo" : "loop";
    const cacheKey = `detail_${data.storeCode}_${data.from}_${data.to}`;

    const result = await cacheFirst(
      platform,
      cacheKey,
      async () => {
        if (data.storeCode === "NL") return fetchJuoDetail(data.from, data.to);
        return fetchLoopMarketDetail(data.storeCode, data.from, data.to);
      },
      { force: data.force }
    );

    if (result.source === "none" && !data.force) {
      const summary = await readCache(platform, "subscriptions");
      const fallback = subscriptionSummaryFallback(summary?.payload, data.storeCode);
      if (fallback) {
        return {
          data: fallback,
          platform,
          source: "cache" as const,
          fetchedAt: summary?.fetchedAt ?? null,
          ageMinutes: ageMinutes(summary?.fetchedAt),
          error: null,
        };
      }
    }

    return {
      data: result.data,
      platform,
      source: result.source,
      fetchedAt: result.fetchedAt,
      ageMinutes: result.ageMinutes,
      error: result.error,
    };
  });

// ─── Invoice dashboard (Jortt) ──────────────────────────────────────────────
export const getInvoiceDashboard = createServerFn({ method: "GET" }).middleware([requireAllowedUser])
  .inputValidator(dateRangeSchema)
  .handler(async ({ data }) => {
    const cacheKey = `detail_${data.from}_${data.to}`;
    const result = await cacheFirst(
      "jortt",
      cacheKey,
      () => fetchJorttInvoiceDetail(data.from, data.to),
      { force: data.force }
    );
    return {
      data: result.data,
      source: result.source,
      fetchedAt: result.fetchedAt,
      ageMinutes: result.ageMinutes,
      error: result.error,
    };
  });

// ─── Accounting dashboard (Xero) ────────────────────────────────────────────
export const getAccountingDashboard = createServerFn({ method: "GET" }).middleware([requireAllowedUser])
  .inputValidator(z.object({ force: z.boolean().optional() }).optional())
  .handler(async ({ data }) => {
    const force = data?.force === true;
    const result = await cacheFirst("xero", "accounting", () => fetchXero(), { force });
    return {
      data: result.data,
      source: result.source,
      fetchedAt: result.fetchedAt,
      ageMinutes: result.ageMinutes,
      error: result.error,
    };
  });

/**
 * Strict full Xero sync — fetches P&L, Balance Sheet, Bank Summary, Invoices.
 * Returns a per-report status so the UI can show exactly which reports
 * succeeded and which failed. Cache is ONLY updated when ALL four reports
 * succeed; otherwise the existing cache is left untouched.
 */
export type XeroReportKey =
  | "profitAndLoss"
  | "balanceSheet"
  | "bankSummary"
  | "invoices";

export interface XeroReportStatus {
  key: XeroReportKey;
  label: string;
  ok: boolean;
  reason?: string;
  diagnostics?: any;
}

export const syncXeroAll = createServerFn({ method: "POST" }).middleware([requireAllowedUser]).handler(async () => {
  const live: any = await fetchXero();

  if (!live) {
    const failed: XeroReportStatus[] = [
      { key: "profitAndLoss", label: "Profit & Loss", ok: false, reason: "Xero not connected" },
      { key: "balanceSheet",  label: "Balance Sheet", ok: false, reason: "Xero not connected" },
      { key: "bankSummary",   label: "Bank Summary",  ok: false, reason: "Xero not connected" },
      { key: "invoices",      label: "Invoices",      ok: false, reason: "Xero not connected" },
    ];
    return {
      ok: false as const,
      error: "Xero is not connected. Visit /api/auth/xero to connect your organization.",
      reports: failed,
    };
  }

  const reports: XeroReportStatus[] = [];
  const diag = live._diagnostics ?? {};

  // P&L: monthly revenue rows + YTD figure
  if (
    live.revenueByMonth &&
    Object.keys(live.revenueByMonth).length > 0 &&
    live.ytdRevenue !== null
  ) {
    reports.push({ key: "profitAndLoss", label: "Profit & Loss", ok: true, diagnostics: diag.profitAndLoss });
  } else {
    const why =
      !live.revenueByMonth || Object.keys(live.revenueByMonth).length === 0
        ? "no monthly revenue rows parsed"
        : "missing YTD revenue total";
    reports.push({ key: "profitAndLoss", label: "Profit & Loss", ok: false, reason: why, diagnostics: diag.profitAndLoss });
  }

  // Balance Sheet: needs Assets, Liabilities and Equity totals
  const bsMissing: string[] = [];
  if (live.totalAssets === null) bsMissing.push("Total Assets");
  if (live.totalLiabilities === null) bsMissing.push("Total Liabilities");
  if (live.equity === null) bsMissing.push("Equity");
  if (bsMissing.length === 0) {
    reports.push({ key: "balanceSheet", label: "Balance Sheet", ok: true, diagnostics: diag.balanceSheet });
  } else {
    reports.push({
      key: "balanceSheet",
      label: "Balance Sheet",
      ok: false,
      reason: `missing ${bsMissing.join(", ")}`,
      diagnostics: diag.balanceSheet,
    });
  }

  // Bank Summary: at least one bank account OR a non-null cash balance
  if (
    (Array.isArray(live.bankAccounts) && live.bankAccounts.length > 0) ||
    live.cashBalance !== null
  ) {
    reports.push({ key: "bankSummary", label: "Bank Summary", ok: true, diagnostics: diag.bankSummary });
  } else {
    reports.push({
      key: "bankSummary",
      label: "Bank Summary",
      ok: false,
      reason: "no bank accounts or cash balance returned",
      diagnostics: diag.bankSummary,
    });
  }

  // Invoices (A/R): unpaidInvoiceCount is always set when the endpoint responds
  if (typeof live.unpaidInvoiceCount === "number") {
    reports.push({ key: "invoices", label: "Invoices (A/R)", ok: true, diagnostics: diag.invoices });
  } else {
    reports.push({
      key: "invoices",
      label: "Invoices (A/R)",
      ok: false,
      reason: "invoice endpoint did not return data",
      diagnostics: diag.invoices,
    });
  }

  const failed = reports.filter((r) => !r.ok);

  if (failed.length > 0) {
    return {
      ok: false as const,
      error: `Sync incomplete — ${failed.length} report${failed.length > 1 ? "s" : ""} failed. Cache was not updated.`,
      reports,
      partial: live,
    };
  }

  // All reports succeeded — commit to cache atomically.
  await writeCache("xero", "accounting", live);

  return {
    ok: true as const,
    data: live,
    reports,
    fetchedAt: new Date().toISOString(),
  };
});
