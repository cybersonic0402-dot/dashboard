// DB-backed Loop fetchers + status helpers.
// Reads from public."UK_loop" / "US_loop" instead of hitting the Loop API.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOOP_STORES = [
  { market: "UK", flag: "🇬🇧", table: "UK_loop", currency: "GBP", envKey: "LOOP_UK_API_KEY" },
  { market: "US", flag: "🇺🇸", table: "US_loop", currency: "USD", envKey: "LOOP_US_API_KEY" },
] as const;

// PAGE size lowered from 1000 -> 500. UK_loop has ~43k rows; even small
// per-row payloads add up over many pages, and Supabase's PostgREST
// occasionally drops connections on the larger reads. 500 doubles the round
// trips but each is fast and stable.
const PAGE = 500;
const PAGE_FALLBACK = 100;
const READ_MAX_RETRIES = 4;

async function readAll(table: string): Promise<any[]> {
  const out: any[] = [];
  let from = 0;
  // Page size is reduced when reads keep failing, so a flaky UK_loop read
  // can recover by halving the payload instead of giving up entirely. Once
  // shrunk it stays shrunk for the rest of the read.
  let pageSize = PAGE;
  while (true) {
    // shipping_address is intentionally EXCLUDED from the bulk read — it's
    // a JSONB blob ~500 bytes per row, which over 43k UK rows balloons the
    // total transfer to ~500MB and reliably blows past Supabase's
    // per-request timeout. Customer dedup degrades to per-subscription
    // counting (without it) on UK; an explicit secondary fetch can be
    // added later if the dedup is critical.
    const columns =
      "id,status,total_line_item_price,currency_code,created_at,cancelled_at,updated_at," +
      "is_marked_for_cancellation,billing_policy,cancellation_reason,last_payment_status," +
      "shopify_id,origin_order_shopify_id";

    let attempt = 0;
    let lastErr: any = null;
    while (attempt < READ_MAX_RETRIES) {
      attempt++;
      try {
        // ORDER BY id is REQUIRED for safe pagination. Without it PostgREST
        // returns rows in physical storage order, which shifts whenever the
        // Railway loop-sync service writes to the table mid-read — pages
        // then overlap (same row in two ranges) AND skip rows, silently
        // mangling the totals downstream (the funnel cohort was capped at
        // ~49k because ~15k UK rows were paginated twice and collapsed by
        // the by-id Map). Stable ordering eliminates both failure modes.
        const { data, error } = await supabaseAdmin
          .from(table as any)
          .select(columns)
          .order("id", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw new Error(error.message);
        const batch = data ?? [];
        out.push(...batch);
        if (batch.length < pageSize) return out;
        from += pageSize;
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        if (attempt < READ_MAX_RETRIES) {
          // Drop to a smaller page size after the first failure — most
          // Supabase timeouts here are payload-size driven, so a smaller
          // window has a much better chance of completing.
          if (pageSize > PAGE_FALLBACK) pageSize = PAGE_FALLBACK;
          const waitMs = 750 * attempt; // 750ms, 1500ms, 2250ms
          console.warn(
            `[loop-db] read ${table}@${from} attempt ${attempt}/${READ_MAX_RETRIES} (pageSize=${pageSize}) failed: ${err?.message ?? err}. Retrying in ${waitMs}ms`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }
    if (lastErr) {
      throw new Error(`${table} read failed at offset ${from} after ${READ_MAX_RETRIES} retries: ${lastErr?.message ?? lastErr}`);
    }
  }
}

/**
 * Convert a billed-per-cycle price to its monthly equivalent.
 *
 * Loop's `billing_policy` JSONB looks like:
 *   { "interval": "MONTH" | "WEEK" | "DAY" | "YEAR", "intervalCount": 3 }
 * meaning "every 3 months" / "every 2 weeks" / etc.
 *
 * Examples:
 *   £30, MONTH, count=1  →  £30/mo
 *   £90, MONTH, count=3  →  £30/mo
 *   £30, WEEK,  count=2  →  £30 ÷ 2 weeks × 4.33 wks/mo ≈ £64.95/mo
 *   £120, YEAR, count=1  →  £10/mo
 *
 * Defaults to monthly when the policy is missing/malformed so a single bad
 * row can't drag total MRR to zero.
 */
function loopPriceToMonthly(price: number, policy: any): number {
  if (!Number.isFinite(price) || price === 0) return 0;
  const rawInterval = policy?.interval ?? policy?.billingInterval ?? "MONTH";
  const interval = String(rawInterval).toUpperCase();
  const n = Number(policy?.intervalCount ?? policy?.billingIntervalCount ?? 1) || 1;
  switch (interval) {
    case "DAY":
      return (price / n) * 30;
    case "WEEK":
      return (price / n) * 4.33;
    case "YEAR":
      return price / (n * 12);
    case "MONTH":
    default:
      return price / n;
  }
}

// Resolve a stable customer identifier from whatever fields are present.
// The current bulk read no longer fetches shipping_address (it bloated
// UK_loop reads past Supabase timeouts), so dedup falls back to
// shopify_id when present, else null. When null, the caller treats the
// row as a unique customer — i.e. dedup quietly disabled, which means
// activeSubs ≈ "Active subscriptions" (Loop UI's higher number) rather
// than "Active subscribers" (the unique-customer headline). Acceptable
// trade-off: UK loads correctly. A future enhancement can fetch
// shipping_address only for the active subset to restore email dedup.
function loopCustomerKey(row: any): string | null {
  // shipping_address may still be present if a future read includes it
  // (e.g., a smaller-batch enrichment pass); keep the email/phone path
  // for forward compatibility.
  const addr = row.shipping_address ?? null;
  const email = addr?.email ?? addr?.Email ?? null;
  if (email != null && email !== "") return `email:${String(email).toLowerCase()}`;
  const phone = addr?.phone ?? addr?.Phone ?? null;
  if (phone != null && phone !== "") return `phone:${String(phone).replace(/\D/g, "")}`;
  // shopify_id is per-subscription, not per-customer, but if every row has
  // it and we use it as the key, dedup degrades to identity (one row =
  // one "customer"). That preserves the existing behaviour without
  // crashing.
  return null;
}

function summarize(market: string, flag: string, currency: string, rows: any[], from?: Date, to?: Date) {
  const monthStart = from ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const cutoff = to ?? null;

  // "Active" here matches Loop's own dashboard definition:
  // status === ACTIVE AND not pending cancellation. A sub with
  // is_marked_for_cancellation=true keeps status ACTIVE in the API until the
  // current period ends, but Loop excludes it from their "Active subscriptions"
  // headline — so we mirror that. Without this filter our count runs
  // several hundred over Loop's UI (each "ending soon" sub double-counted).
  const activeAsOf = rows.filter((s) => {
    if (s.is_marked_for_cancellation === true) return false;
    const status = (s.status ?? "").toUpperCase();
    // Loop UI's "Active subscriptions" headline definition:
    //   1. CURRENT status === ACTIVE
    //   2. Not marked for cancellation (already handled above)
    //   3. No cancellation_reason set (i.e. not already in cancellation flow)
    //   4. Last payment did not fail (dunning rows are not "active subscribers")
    // Previously the cutoff branch counted any sub not yet cancelled — which
    // folded PAUSED / EXPIRED / failed-payment / dunning rows into the
    // headline, overstating active subscribers by ~4k on UK alone (41k vs
    // the true ~37k). Lifecycle bounds (created/cancelled vs cutoff) still
    // apply on top for historical-range queries.
    if (status !== "ACTIVE") return false;
    if (s.cancellation_reason != null && s.cancellation_reason !== "") return false;
    const lastPaymentStatus = (s.last_payment_status ?? "").toString().toUpperCase();
    if (lastPaymentStatus === "FAILED") return false;
    if (cutoff) {
      const created = s.created_at ? new Date(s.created_at) : null;
      if (!created || created > cutoff) return false;
      const cancelled = s.cancelled_at ? new Date(s.cancelled_at) : null;
      if (cancelled && cancelled <= cutoff) return false;
    }
    return true;
  });

  // Build a transparent count breakdown so the user can see why our active
  // total differs from Loop's UI — they're hidden in different bucket
  // boundaries (marked-for-cancellation, dunning, etc.).
  const statusCounts: Record<string, number> = {};
  let markedForCancellation = 0;
  let withCancellationReason = 0;
  let withFailedPayment = 0;
  let statusActiveCount = 0;
  let statusActiveAndNotMarkedCount = 0;
  let rowsWithoutCustomerKey = 0;
  for (const r of rows) {
    const st = (r.status ?? "unknown").toString().toUpperCase();
    statusCounts[st] = (statusCounts[st] ?? 0) + 1;
    if (r.is_marked_for_cancellation === true) markedForCancellation++;
    if (r.cancellation_reason) withCancellationReason++;
    if ((r.last_payment_status ?? "").toString().toUpperCase() === "FAILED") withFailedPayment++;
    if (st === "ACTIVE") {
      statusActiveCount++;
      if (r.is_marked_for_cancellation !== true) statusActiveAndNotMarkedCount++;
    }
    if (loopCustomerKey(r) == null) rowsWithoutCustomerKey++;
  }

  // Loop's UI headline "Active subscribers" = unique customer count.
  // "Active subscriptions" = subscription record count. We've been counting
  // the latter; switching to customer-level dedup matches their headline.
  // Rows where no customer identifier was extractable (e.g. older synced
  // rows whose raw JSON predates this column extraction) each get counted
  // as their own unique customer — won't undercount, may slightly overcount
  // until the next full Loop resync repopulates the raw column.
  const uniqueCustomerIds = new Set<string>();
  let activeRowsWithoutCustomer = 0;
  for (const s of activeAsOf) {
    const key = loopCustomerKey(s);
    if (key) uniqueCustomerIds.add(key);
    else activeRowsWithoutCustomer++;
  }
  const activeSubscribersUnique = uniqueCustomerIds.size + activeRowsWithoutCustomer;

  const loopMarketDiagnostic = {
    totalRows: rows.length,
    statusCounts,
    markedForCancellation,
    withCancellationReason,
    withFailedPayment,
    statusActiveCount,
    statusActiveAndNotMarkedCount,
    rowsWithoutCustomerKey,
    activeSubscriptions: activeAsOf.length,         // record count (was the old "active")
    activeSubscribersUnique,                         // unique-customer count (Loop UI headline)
    finalActiveCount: activeSubscribersUnique,       // what the dashboard now uses
  };

  // MRR = sum of each active sub's billed amount NORMALIZED to monthly.
  // Loop's total_line_item_price is per-billing-cycle, not per-month, so
  // a customer base of quarterly subs would otherwise show ~3× true MRR.
  const mrr = activeAsOf.reduce(
    (sum, s) =>
      sum + loopPriceToMonthly(parseFloat(s.total_line_item_price ?? "0"), s.billing_policy),
    0,
  );
  const newInRange = rows.filter((s) => {
    const c = s.created_at ? new Date(s.created_at) : null;
    if (!c) return false;
    if (cutoff) return c >= monthStart && c <= cutoff;
    return c >= monthStart;
  }).length;
  const churnedInRange = rows.filter((s) => {
    const c = s.cancelled_at ? new Date(s.cancelled_at) : null;
    if (!c) return false;
    if (cutoff) return c >= monthStart && c <= cutoff;
    return c >= monthStart;
  }).length;

  const arpu = activeAsOf.length > 0 ? mrr / activeAsOf.length : null;
  const churnRate =
    activeAsOf.length + churnedInRange > 0
      ? +((churnedInRange / (activeAsOf.length + churnedInRange)) * 100).toFixed(1)
      : null;

  // ARPU should be MRR per UNIQUE CUSTOMER, not per subscription record,
  // to match what platforms call ARPU/ARPPU. Recompute against the unique
  // customer count.
  const arpuByCustomer = activeSubscribersUnique > 0 ? mrr / activeSubscribersUnique : null;

  return {
    market,
    flag,
    platform: "loop" as const,
    live: true,
    // Bumped to 9: range-mode filter now requires CURRENT status === ACTIVE
    // (previously it counted any sub not yet cancelled, which folded PAUSED
    // / EXPIRED rows into the headline — UK reported 41,010 instead of the
    // true ~37,914). UI filter "calcVersion >= 3" still passes.
    calcVersion: 9,
    rangeMode: !!cutoff,
    mrr: Math.round(mrr),
    // activeSubs is now unique CUSTOMER count (Loop UI "Active subscribers"
    // headline). The previous subscription-record count is preserved in
    // _diagnostics.activeSubscriptions for reference.
    activeSubs: activeSubscribersUnique,
    totalFetched: rows.length,
    newThisMonth: newInRange,
    churnedThisMonth: churnedInRange,
    arpu: arpuByCustomer != null ? +arpuByCustomer.toFixed(2) : (arpu != null ? +arpu.toFixed(2) : null),
    churnRate,
    currency,
    source: "db" as const,
    _diagnostics: loopMarketDiagnostic,
  };
}

// Stub entry returned when a market's read fails. Keeps the market visible on
// the dashboard (with `live: true` so the OverviewView filter doesn't drop it)
// and surfaces the underlying error in the diagnostic block instead of the
// store silently disappearing — which is what was happening to UK whenever
// the ~43k-row UK_loop read hit a Supabase timeout or transient connection
// reset.
function emptyMarketRow(
  market: string,
  flag: string,
  currency: string,
  error: string | null,
) {
  return {
    market,
    flag,
    platform: "loop" as const,
    live: true,
    calcVersion: 8,
    rangeMode: false,
    mrr: 0,
    activeSubs: 0,
    totalFetched: 0,
    newThisMonth: 0,
    churnedThisMonth: 0,
    arpu: null,
    churnRate: null,
    currency,
    source: "db" as const,
    _error: error,
    _diagnostics: {
      totalRows: 0,
      statusCounts: {},
      markedForCancellation: 0,
      withCancellationReason: 0,
      withFailedPayment: 0,
      statusActiveCount: 0,
      statusActiveAndNotMarkedCount: 0,
      rowsWithoutCustomerKey: 0,
      activeSubscriptions: 0,
      activeSubscribersUnique: 0,
      finalActiveCount: 0,
      error,
    },
  };
}

export async function fetchLoopFromDb() {
  // Run per-store reads in parallel so a slow or failing UK read no longer
  // blocks the (much smaller) US read from completing. Each store is wrapped
  // in its own try so one bad table can't take down the other.
  const results = await Promise.all(
    LOOP_STORES.map(async (s) => {
      try {
        const rows = await readAll(s.table);
        return summarize(s.market, s.flag, s.currency, rows);
      } catch (err: any) {
        const message = err?.message ?? String(err);
        console.error(`[loop-db] ${s.market} failed:`, message);
        return emptyMarketRow(s.market, s.flag, s.currency, message);
      }
    }),
  );
  return results.length > 0 ? results : null;
}

export async function fetchLoopFromDbForRange(fromIso: string, toIso: string) {
  const from = new Date(fromIso + "T00:00:00");
  const to = new Date(toIso + "T23:59:59");
  const results = await Promise.all(
    LOOP_STORES.map(async (s) => {
      try {
        const rows = await readAll(s.table);
        return summarize(s.market, s.flag, s.currency, rows, from, to);
      } catch (err: any) {
        const message = err?.message ?? String(err);
        console.error(`[loop-db] range ${s.market} failed:`, message);
        return emptyMarketRow(s.market, s.flag, s.currency, message);
      }
    }),
  );
  return results.length > 0 ? results : null;
}

// ── Funnel reader ─────────────────────────────────────────────────────────────
// Returns minimal fields needed by the subscription repeat-purchase funnel:
// just enough to bucket each sub into its cohort month and read its cycle
// count. Reads from Supabase rather than the Loop API so the funnel sees the
// full 45k+ UK book instead of timing out mid-pagination against the live
// API (which kept the cohort size pinned around 20k).
export async function fetchLoopSubsForFunnelFromDb(): Promise<
  Array<{ id: string; createdAt: string; cycles: number }>
> {
  const PAGE_SIZE = 1000;
  const out: Array<{ id: string; createdAt: string; cycles: number }> = [];
  for (const s of LOOP_STORES) {
    let from = 0;
    while (true) {
      try {
        const { data, error } = await supabaseAdmin
          .from(s.table as any)
          .select("id,created_at,completed_orders_count")
          .order("id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(error.message);
        const batch = data ?? [];
        for (const row of batch as any[]) {
          if (!row?.created_at) continue;
          const cycles = Number(row.completed_orders_count);
          out.push({
            id: `${s.market}:${row.id}`,
            createdAt: String(row.created_at),
            cycles: Number.isFinite(cycles) && cycles > 0 ? Math.floor(cycles) : 1,
          });
        }
        if (batch.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      } catch (err: any) {
        console.error(`[loop-db] funnel read ${s.market}@${from} failed:`, err?.message);
        break;
      }
    }
  }
  return out;
}

// ── Lightweight per-market summary (for revenue forecast) ────────────────
// fetchLoopFromDb reads ALL rows (~43k for UK) which routinely times out.
// This variant uses Postgres COUNT(*) for the counts and only reads the
// two columns needed (price, billing_policy) for ACTIVE rows to compute
// MRR — dropping payload by ~80% and total time from ~60s to ~5-15s.
export async function fetchLoopMarketLight(marketCode: "UK" | "US"): Promise<{
  market: string;
  flag: string;
  currency: string;
  activeSubs: number;
  mrr: number;
  arpu: number | null;
  churnRate: number | null; // percent (e.g. 4.5)
  newThisMonth: number;
  churnedThisMonth: number;
  source: "loop";
  live: true;
}> {
  const store = LOOP_STORES.find((s) => s.market === marketCode);
  if (!store) throw new Error(`Unknown Loop market: ${marketCode}`);
  const table = store.table;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  // 1-3. Counts via head:true — no rows transferred.
  const [activeRes, newRes, churnedRes] = await Promise.all([
    supabaseAdmin
      .from(table as any)
      .select("*", { count: "exact", head: true })
      .eq("status", "ACTIVE"),
    supabaseAdmin
      .from(table as any)
      .select("*", { count: "exact", head: true })
      .gte("created_at", monthStart),
    supabaseAdmin
      .from(table as any)
      .select("*", { count: "exact", head: true })
      .gte("cancelled_at", monthStart),
  ]);

  const activeSubs = activeRes.count ?? 0;
  const newThisMonth = newRes.count ?? 0;
  const churnedThisMonth = churnedRes.count ?? 0;

  // 4. MRR — read ONLY price + policy for active rows. Page size 1000 is the
  // PostgREST default cap; with 2 small columns this is ~50KB per page, so a
  // 37k-row UK book lands in ~38 round trips that are each <1s.
  const MRR_PAGE = 1000;
  let mrr = 0;
  let from = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from(table as any)
      .select("total_line_item_price,billing_policy")
      .eq("status", "ACTIVE")
      .order("id", { ascending: true })
      .range(from, from + MRR_PAGE - 1);
    if (error) throw new Error(`${table} MRR read failed at ${from}: ${error.message}`);
    const batch = (data ?? []) as unknown as Array<{
      total_line_item_price: string | null;
      billing_policy: any;
    }>;
    if (batch.length === 0) break;
    for (const r of batch) {
      const price = parseFloat(r.total_line_item_price ?? "0");
      mrr += loopPriceToMonthly(price, r.billing_policy);
    }
    if (batch.length < MRR_PAGE) break;
    from += MRR_PAGE;
  }

  const arpu = activeSubs > 0 ? +(mrr / activeSubs).toFixed(2) : null;
  const churnRate =
    activeSubs + churnedThisMonth > 0
      ? +((churnedThisMonth / (activeSubs + churnedThisMonth)) * 100).toFixed(1)
      : null;

  return {
    market: store.market,
    flag: store.flag,
    currency: store.currency,
    activeSubs,
    mrr: +mrr.toFixed(2),
    arpu,
    churnRate,
    newThisMonth,
    churnedThisMonth,
    source: "loop",
    live: true,
  };
}

// ── Status ────────────────────────────────────────────────────────────────────
export async function getLoopDbStatus() {
  const out: Array<{
    market: string;
    table: string;
    dbCount: number;
    lastSyncedAt: string | null;
    maxUpdatedAt: string | null;
    byStatus: Record<string, number>;
  }> = [];
  for (const s of LOOP_STORES) {
    const { count } = await supabaseAdmin
      .from(s.table as any)
      .select("*", { count: "exact", head: true });
    const { data: last } = await supabaseAdmin
      .from(s.table as any)
      .select("synced_at,updated_at")
      .order("synced_at", { ascending: false })
      .limit(1);
    // status breakdown
    const byStatus: Record<string, number> = {};
    for (const st of ["ACTIVE", "CANCELLED", "PAUSED"]) {
      const { count: c } = await supabaseAdmin
        .from(s.table as any)
        .select("*", { count: "exact", head: true })
        .eq("status", st);
      byStatus[st] = c ?? 0;
    }
    const { data: maxUpd } = await supabaseAdmin
      .from(s.table as any)
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);
    out.push({
      market: s.market,
      table: s.table,
      dbCount: count ?? 0,
      lastSyncedAt: (last?.[0] as any)?.synced_at ?? null,
      maxUpdatedAt: (maxUpd?.[0] as any)?.updated_at ?? null,
      byStatus,
    });
  }
  return out;
}

// Light API peek per market: pages until updatedAt <= maxUpdatedAt in DB.
// Counts subscriptions whose updatedAt is newer than what we have stored.
// Respects 2 req / 3s rate limit.
export async function getLoopApiPending(): Promise<
  Array<{ market: string; pending: number; checked: number; error?: string }>
> {
  const BASE = "https://api.loopsubscriptions.com";
  const PAGE_SIZE = 100;
  const GAP = 1500;
  const dbStatus = await getLoopDbStatus();
  const dbMap = new Map(dbStatus.map((d) => [d.market, d]));

  const results: Array<{ market: string; pending: number; checked: number; error?: string }> = [];
  for (const s of LOOP_STORES) {
    const apiKey = process.env[s.envKey];
    if (!apiKey) {
      results.push({ market: s.market, pending: 0, checked: 0, error: "missing API key" });
      continue;
    }
    const headers = { "X-Loop-Token": apiKey, Accept: "application/json" };
    const maxUpdated = dbMap.get(s.market)?.maxUpdatedAt;
    const cutoff = maxUpdated ? new Date(maxUpdated).getTime() : 0;

    let pending = 0;
    let checked = 0;
    let lastErr: string | undefined;
    try {
      for (const status of ["ACTIVE", "CANCELLED", "PAUSED"] as const) {
        let page = 1;
        let stop = false;
        while (!stop && page <= 50) {
          if (page > 1 || status !== "ACTIVE") {
            await new Promise((r) => setTimeout(r, GAP));
          }
          const url = `${BASE}/admin/2023-10/subscription?pageNo=${page}&pageSize=${PAGE_SIZE}&status=${status}`;
          let res = await fetch(url, { headers, cache: "no-store" });
          if (res.status === 429) {
            await new Promise((r) => setTimeout(r, 4000));
            res = await fetch(url, { headers, cache: "no-store" });
          }
          if (!res.ok) {
            lastErr = `${status} ${res.status}`;
            break;
          }
          const json: any = await res.json();
          const batch: any[] = json?.data ?? [];
          checked += batch.length;
          let pageHasNew = false;
          for (const sub of batch) {
            const u = sub?.updatedAt ? new Date(sub.updatedAt).getTime() : 0;
            if (u > cutoff) {
              pending++;
              pageHasNew = true;
            }
          }
          const hasNext =
            json?.pageInfo?.hasNextPage ?? batch.length === PAGE_SIZE;
          if (!hasNext || !pageHasNew) stop = true;
          page++;
        }
      }
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
    results.push({ market: s.market, pending, checked, error: lastErr });
  }
  return results;
}
