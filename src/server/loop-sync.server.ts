import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BASE = "https://api.loopsubscriptions.com";
const PAGE_SIZE = 100;
const STATUSES = ["ACTIVE", "CANCELLED", "PAUSED"] as const;
type LoopStatus = (typeof STATUSES)[number];
type Market = "UK" | "US";

// Loop rate limit: 2 requests per 3 seconds → 1500ms gap between calls.
const GAP_MS = 1500;

function tableFor(market: Market) {
  return market === "UK" ? "UK_loop" : "US_loop";
}
function envKeyFor(market: Market) {
  return market === "UK" ? "LOOP_UK_API_KEY" : "LOOP_US_API_KEY";
}

async function fetchPage(
  apiKey: string,
  status: LoopStatus,
  page: number,
): Promise<{ data: any[]; hasNextPage: boolean }> {
  const headers = { "X-Loop-Token": apiKey, Accept: "application/json" };
  const url = `${BASE}/admin/2023-10/subscription?pageNo=${page}&pageSize=${PAGE_SIZE}&status=${status}`;
  let res = await fetch(url, { headers, cache: "no-store" });
  let backoff = 3000;
  for (let i = 0; i < 3 && res.status === 429; i++) {
    await new Promise((r) => setTimeout(r, backoff));
    backoff *= 2;
    res = await fetch(url, { headers, cache: "no-store" });
  }
  if (!res.ok) {
    throw new Error(`Loop ${status} page ${page}: ${res.status} ${res.statusText}`);
  }
  const json: any = await res.json();
  const batch: any[] = json?.data ?? [];
  const hasNextPage =
    json?.pageInfo?.hasNextPage ??
    json?.pagination?.hasNextPage ??
    batch.length === PAGE_SIZE;
  return { data: batch, hasNextPage };
}

function mapRow(sub: any): Record<string, any> {
  return {
    id: sub.id,
    shopify_id: sub.shopifyId ?? null,
    origin_order_shopify_id: sub.originOrderShopifyId ?? null,
    created_at: sub.createdAt ?? null,
    updated_at: sub.updatedAt ?? null,
    order_note: sub.orderNote ?? null,
    total_line_item_price:
      sub.totalLineItemPrice != null ? Number(sub.totalLineItemPrice) : null,
    total_line_item_discounted_price:
      sub.totalLineItemDiscountedPrice != null
        ? Number(sub.totalLineItemDiscountedPrice)
        : null,
    delivery_price: sub.deliveryPrice != null ? Number(sub.deliveryPrice) : null,
    currency_code: sub.currencyCode ?? null,
    status: sub.status ?? null,
    cancellation_reason: sub.cancellationReason ?? null,
    cancellation_comment: sub.cancellationComment ?? null,
    completed_orders_count: sub.completedOrdersCount ?? null,
    paused_at: sub.pausedAt ?? null,
    cancelled_at: sub.cancelledAt ?? null,
    is_prepaid: sub.isPrepaid ?? null,
    is_marked_for_cancellation: sub.isMarkedForCancellation ?? null,
    next_billing_date_epoch: sub.nextBillingDateEpoch ?? null,
    last_payment_status: sub.lastPaymentStatus ?? null,
    last_inventory_action: sub.lastInventoryAction ?? null,
    delivery_method: sub.deliveryMethod ?? null,
    billing_policy: sub.billingPolicy ?? null,
    delivery_policy: sub.deliveryPolicy ?? null,
    shipping_address: sub.shippingAddress ?? null,
    lines: sub.lines ?? null,
    attributes: sub.attributes ?? null,
    raw: sub,
    synced_at: new Date().toISOString(),
  };
}

async function upsertChunked(table: "UK_loop" | "US_loop", rows: any[]) {
  if (rows.length === 0) return;
  // 25-row chunks (was 50): each Loop subscription row carries the full
  // ~5KB `raw` JSONB, so 50 rows = ~250-500KB upsert payloads, which
  // produces the "TypeError: fetch failed" connection-reset errors we kept
  // hitting on the bigger UK store. 25 rows keeps the per-request body
  // small and the connection stable. Throughput stays similar because the
  // bottleneck is the HTTPS round-trip, not the payload size.
  const CHUNK = 25;
  const MAX_RETRIES = 4;
  // Dedupe within batch by id (Loop sometimes returns the same sub twice on
  // adjacent pages when records shift between fetches).
  const byId = new Map<number, any>();
  for (const r of rows) byId.set(r.id, r);
  const deduped = Array.from(byId.values());
  for (let i = 0; i < deduped.length; i += CHUNK) {
    const slice = deduped.slice(i, i + CHUNK);
    // Retry with exponential backoff. `TypeError: fetch failed` and
    // similar transient network errors are throws (not Supabase-returned
    // {error}), so they need a try/catch around the await as well as the
    // returned-error check.
    let lastErr: any = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { error } = await supabaseAdmin
          .from(table as any)
          .upsert(slice, { onConflict: "id" });
        if (error) throw new Error(error.message);
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          const waitMs = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s
          console.warn(
            `[loop-sync] upsert ${table}@${i} attempt ${attempt}/${MAX_RETRIES} failed: ${err?.message ?? err}. Retrying in ${waitMs}ms`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }
    if (lastErr) {
      throw new Error(`upsert ${table}@${i} after ${MAX_RETRIES} retries: ${lastErr?.message ?? lastErr}`);
    }
  }
}

// ── Sync state helpers ────────────────────────────────────────────────────────
type StateRow = {
  market: string;
  status: string;
  page_no: number;
  done: boolean;
  total_fetched: number;
  last_error: string | null;
  retry_count: number;
  last_error_at: string | null;
  last_success_at: string | null;
  started_at: string;
  updated_at: string;
};

type LoopRunRow = {
  id: string;
  run_group_id: string;
  market: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  total_fetched: number;
  rows_upserted: number;
  pages_fetched: number;
  outcome: string;
  last_error: string | null;
  per_status: any;
};

type LoopErrorRow = {
  market: string;
  status: string;
  last_error: string | null;
  retry_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
};

export async function getLoopSyncState(): Promise<StateRow[]> {
  const { data, error } = await supabaseAdmin
    .from("loop_sync_state" as any)
    .select("*");
  if (error) throw new Error(`loop_sync_state read: ${error.message}`);
  return (data ?? []) as unknown as StateRow[];
}

async function loadStateMap(market: Market): Promise<Map<LoopStatus, StateRow>> {
  const { data, error } = await supabaseAdmin
    .from("loop_sync_state" as any)
    .select("*")
    .eq("market", market);
  if (error) throw new Error(`loop_sync_state read: ${error.message}`);
  const m = new Map<LoopStatus, StateRow>();
  for (const r of ((data ?? []) as unknown as StateRow[])) m.set(r.status as LoopStatus, r);
  return m;
}

async function upsertState(row: Partial<StateRow> & { market: string; status: string }) {
  const { error } = await supabaseAdmin
    .from("loop_sync_state" as any)
    .upsert(row, { onConflict: "market,status" });
  if (error) throw new Error(`loop_sync_state upsert: ${error.message}`);
}

async function createRun(market: Market, runGroupId?: string) {
  const startedAt = new Date().toISOString();
  const row = { market, run_group_id: runGroupId, started_at: startedAt, outcome: "running" };
  const { data, error } = await supabaseAdmin.from("loop_sync_runs" as any).insert(row).select("*").single();
  if (error || !data) return null;
  return data as unknown as LoopRunRow;
}

async function finishRun(run: LoopRunRow | null, patch: Partial<LoopRunRow>) {
  if (!run) return;
  const finishedAt = new Date().toISOString();
  await supabaseAdmin
    .from("loop_sync_runs" as any)
    .update({ ...patch, finished_at: finishedAt, duration_ms: Date.now() - new Date(run.started_at).getTime() })
    .eq("id", run.id);
}

async function recordLoopError(market: Market, status: LoopStatus, message: string) {
  const now = new Date().toISOString();
  const { data } = await supabaseAdmin
    .from("loop_sync_errors" as any)
    .select("retry_count")
    .eq("market", market)
    .eq("status", status)
    .maybeSingle();
  const retryCount = Number((data as any)?.retry_count ?? 0) + 1;
  await supabaseAdmin.from("loop_sync_errors" as any).upsert(
    { market, status, last_error: message, retry_count: retryCount, last_seen_at: now, resolved_at: null },
    { onConflict: "market,status" },
  );
}

async function resolveLoopError(market: Market, status: LoopStatus) {
  await supabaseAdmin
    .from("loop_sync_errors" as any)
    .update({ resolved_at: new Date().toISOString() })
    .eq("market", market)
    .eq("status", status)
    .is("resolved_at", null);
}

export async function getLoopSyncRuns(limit = 20): Promise<LoopRunRow[]> {
  const { data, error } = await supabaseAdmin
    .from("loop_sync_runs" as any)
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as unknown as LoopRunRow[];
}

export async function getLoopSyncErrors(): Promise<LoopErrorRow[]> {
  const { data, error } = await supabaseAdmin
    .from("loop_sync_errors" as any)
    .select("*")
    .order("last_seen_at", { ascending: false });
  if (error) return [];
  return (data ?? []) as unknown as LoopErrorRow[];
}

export async function resetLoopState(market: Market) {
  for (const status of STATUSES) {
    await upsertState({
      market,
      status,
      page_no: 1,
      done: false,
      total_fetched: 0,
      last_error: null,
      retry_count: 0,
      last_error_at: null,
      last_success_at: null,
      started_at: new Date().toISOString(),
    });
  }
}

// ── Resumable chunk sync ──────────────────────────────────────────────────────
export async function syncLoopChunk(
  market: Market,
  opts: { maxPages?: number; timeBudgetMs?: number; runGroupId?: string } = {},
): Promise<{
  market: Market;
  pagesFetched: number;
  rowsUpserted: number;
  perStatus: Record<string, { page: number; total: number; done: boolean }>;
  allDone: boolean;
  lastError?: string;
}> {
  const apiKey = process.env[envKeyFor(market)];
  if (!apiKey) throw new Error(`Missing ${envKeyFor(market)}`);
  const table = tableFor(market) as "UK_loop" | "US_loop";

  const maxPages = opts.maxPages ?? 25;
  const timeBudgetMs = opts.timeBudgetMs ?? 45_000;
  const startedAt = Date.now();
  const run = await createRun(market, opts.runGroupId);

  const stateMap = await loadStateMap(market);
  // Ensure rows exist for each status
  for (const s of STATUSES) {
    if (!stateMap.has(s)) {
      const row: StateRow = {
        market,
        status: s,
        page_no: 1,
        done: false,
        total_fetched: 0,
        last_error: null,
        retry_count: 0,
        last_error_at: null,
        last_success_at: null,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      stateMap.set(s, row);
      await upsertState(row);
    }
  }

  let pagesFetched = 0;
  let rowsUpserted = 0;
  let lastError: string | undefined;

  outer: for (const status of STATUSES) {
    const st = stateMap.get(status)!;
    if (st.done) continue;
    let page = st.page_no || 1;
    let total = st.total_fetched || 0;
    while (pagesFetched < maxPages && Date.now() - startedAt < timeBudgetMs) {
      // rate limit gap (skip on very first call of the chunk)
      if (pagesFetched > 0) await new Promise((r) => setTimeout(r, GAP_MS));
      let result;
      try {
        result = await fetchPage(apiKey, status, page);
      } catch (err: any) {
        const message = err?.message ?? String(err);
        lastError = message;
        const errorAt = new Date().toISOString();
        await recordLoopError(market, status, message);
        await upsertState({
          market,
          status,
          page_no: page,
          done: false,
          total_fetched: total,
          last_error: message,
          retry_count: (st.retry_count ?? 0) + 1,
          last_error_at: errorAt,
        });
        stateMap.set(status, { ...st, page_no: page, total_fetched: total, done: false, last_error: message, retry_count: (st.retry_count ?? 0) + 1, last_error_at: errorAt });
        break outer;
      }
      pagesFetched++;
      const rows = result.data.map(mapRow);
      try {
        await upsertChunked(table, rows);
      } catch (err: any) {
        const message = err?.message ?? String(err);
        lastError = message;
        const errorAt = new Date().toISOString();
        await recordLoopError(market, status, message);
        await upsertState({
          market,
          status,
          page_no: page,
          done: false,
          total_fetched: total,
          last_error: message,
          retry_count: (st.retry_count ?? 0) + 1,
          last_error_at: errorAt,
        });
        stateMap.set(status, { ...st, page_no: page, total_fetched: total, done: false, last_error: message, retry_count: (st.retry_count ?? 0) + 1, last_error_at: errorAt });
        break outer;
      }
      rowsUpserted += rows.length;
      total += rows.length;

      if (!result.hasNextPage || rows.length === 0) {
        const successAt = new Date().toISOString();
        await resolveLoopError(market, status);
        await upsertState({
          market,
          status,
          page_no: page,
          done: true,
          total_fetched: total,
          last_error: null,
          retry_count: 0,
          last_error_at: null,
          last_success_at: successAt,
        });
        stateMap.set(status, { ...st, page_no: page, total_fetched: total, done: true, last_error: null, retry_count: 0, last_error_at: null, last_success_at: successAt });
        break; // move to next status in this chunk
      }
      page++;
      // persist progress every page so the UI sees movement
      await upsertState({
        market,
        status,
        page_no: page,
        done: false,
        total_fetched: total,
        last_error: null,
        last_error_at: null,
      });
      stateMap.set(status, { ...st, page_no: page, total_fetched: total, last_error: null, last_error_at: null });
    }
    if (pagesFetched >= maxPages || Date.now() - startedAt >= timeBudgetMs) break;
  }

  const perStatus: Record<string, { page: number; total: number; done: boolean }> = {};
  for (const s of STATUSES) {
    const r = stateMap.get(s)!;
    perStatus[s] = { page: r.page_no, total: r.total_fetched, done: r.done };
  }
  const allDone = STATUSES.every((s) => stateMap.get(s)!.done);
  await finishRun(run, {
    total_fetched: Object.values(perStatus).reduce((sum, s) => sum + s.total, 0),
    rows_upserted: rowsUpserted,
    pages_fetched: pagesFetched,
    outcome: lastError ? "error" : allDone ? "success" : "partial",
    last_error: lastError ?? null,
    per_status: perStatus,
  });
  return { market, pagesFetched, rowsUpserted, perStatus, allDone, lastError };
}

// Convenience: drive both markets to completion, respecting a wall-time budget.
// Used by cron / background sync. Returns once allDone for both, or the budget
// is exhausted.
export async function syncAllLoop(opts: { wallBudgetMs?: number } = {}): Promise<
  Array<{ market: Market; allDone: boolean; lastError?: string; perStatus: any }>
> {
  const wall = opts.wallBudgetMs ?? 50_000;
  const start = Date.now();
  const results: Record<Market, { market: Market; allDone: boolean; lastError?: string; perStatus: any }> = {
    UK: { market: "UK", allDone: false, perStatus: {} },
    US: { market: "US", allDone: false, perStatus: {} },
  };
  while (Date.now() - start < wall) {
    const remaining = wall - (Date.now() - start);
    const slice = Math.max(8_000, Math.floor(remaining / 2));
    const [uk, us] = await Promise.allSettled([
      results.UK.allDone ? Promise.resolve(null) : syncLoopChunk("UK", { timeBudgetMs: slice, maxPages: 30 }),
      results.US.allDone ? Promise.resolve(null) : syncLoopChunk("US", { timeBudgetMs: slice, maxPages: 30 }),
    ]);
    if (uk.status === "fulfilled" && uk.value) {
      results.UK = { market: "UK", allDone: uk.value.allDone, lastError: uk.value.lastError, perStatus: uk.value.perStatus };
    } else if (uk.status === "rejected") {
      results.UK.lastError = String(uk.reason?.message ?? uk.reason);
    }
    if (us.status === "fulfilled" && us.value) {
      results.US = { market: "US", allDone: us.value.allDone, lastError: us.value.lastError, perStatus: us.value.perStatus };
    } else if (us.status === "rejected") {
      results.US.lastError = String(us.reason?.message ?? us.reason);
    }
    if (results.UK.allDone && results.US.allDone) break;
  }
  return [results.UK, results.US];
}

// Back-compat: a single market full sync (used by the /api/sync-loop?market=X
// route). Drives that market to completion within a budget.
export async function syncLoopStore(market: Market): Promise<{
  market: Market;
  allDone: boolean;
  perStatus: Record<string, { page: number; total: number; done: boolean }>;
  lastError?: string;
}> {
  const wall = 50_000;
  const start = Date.now();
  let last: Awaited<ReturnType<typeof syncLoopChunk>> | null = null;
  while (Date.now() - start < wall) {
    const remaining = wall - (Date.now() - start);
    last = await syncLoopChunk(market, { timeBudgetMs: Math.max(8_000, remaining), maxPages: 30 });
    if (last.allDone || last.lastError) break;
  }
  return last
    ? { market, allDone: last.allDone, perStatus: last.perStatus, lastError: last.lastError }
    : { market, allDone: false, perStatus: {} };
}
