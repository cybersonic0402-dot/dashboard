/**
 * Shopify orders → Supabase mirror.
 *
 * Resumable, chunked, idempotent backfill + incremental sync. Mirrors the
 * Loop pattern in `loop-sync.server.ts`:
 *   - `shopify_orders`       : one row per (store, order GID)
 *   - `shopify_sync_state`   : per-store progress + cursor / high-water
 *   - `shopify_sync_runs`    : audit log per chunk invocation
 *   - `shopify_sync_errors`  : persistent error cache for the UI banner
 *
 * Two phases:
 *   1. **Backfill** (mode='backfill') — walks orders ascending from the
 *      oldest available, using cursor pagination. Each chunk processes at
 *      most `maxPages` pages or until `timeBudgetMs` is exhausted, then
 *      persists the cursor and exits. The next chunk picks up where this
 *      one stopped. Once `hasNextPage=false`, the store flips to
 *      'incremental' and stores the newest seen `updatedAt` as the
 *      high-water mark.
 *   2. **Incremental** (mode='incremental') — repeats forever with a
 *      `updated_at:>=high_water_mark` filter so new orders AND modified
 *      historicals (refunds, fulfilment status changes) flow through.
 *
 * Failure handling: every transient error is caught, logged to
 * `shopify_sync_errors`, persisted into `shopify_sync_state.last_error`,
 * and the chunk returns. The next chunk retries from the same cursor.
 * Nothing partial leaks into the orders table — we upsert per page in
 * small chunks of 25, retried with exponential backoff on connection
 * resets (same trick that fixed Loop's "TypeError: fetch failed" issue).
 *
 * Note on scope: Shopify silently caps anywhere-public Custom App tokens
 * to the last 60 days unless `read_all_orders` is granted. If the
 * backfill stops at ~day 60, the app needs that scope reinstalled — the
 * sync itself runs fine, there's just no older data to ingest.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const STORES = [
  { code: "NL", storeKey: "SHOPIFY_NL_STORE" },
  { code: "UK", storeKey: "SHOPIFY_UK_STORE" },
  { code: "US", storeKey: "SHOPIFY_US_STORE" },
] as const;
type StoreCode = (typeof STORES)[number]["code"];

const PAGE_SIZE = 250;
const SHOPIFY_API_VERSION = "2024-10";

function envFor(code: StoreCode): string {
  return STORES.find((s) => s.code === code)?.storeKey ?? "";
}

function storeDomain(code: StoreCode): string | null {
  const key = envFor(code);
  return key ? process.env[key] ?? null : null;
}

// Shopify Admin custom app tokens are issued per-shop via the OAuth
// client_credentials grant. The token-fetching helper lives in
// fetchers.server.ts and is imported lazily so this module can be
// pulled into API routes without dragging the whole fetchers bundle.
async function tokenFor(code: StoreCode): Promise<string | null> {
  const domain = storeDomain(code);
  if (!domain) return null;
  const mod = await import("./fetchers.server");
  return await mod.getShopifyToken(domain);
}

// GraphQL page query. Backfill uses (sortKey:UPDATED_AT, reverse:false,
// after:cursor) so resumption is straightforward — the cursor encodes the
// position in the ordered stream, and incremental mode just uses a
// different `query:` filter on the same sort key.
const ORDERS_PAGE = (opts: {
  cursor: string | null;
  query: string;
}) => `{
  orders(first:${PAGE_SIZE}, sortKey:UPDATED_AT, reverse:false${opts.cursor ? `, after:"${opts.cursor}"` : ""}, query:"${opts.query}") {
    pageInfo { hasNextPage endCursor }
    edges {
      cursor
      node {
        id
        name
        createdAt
        updatedAt
        processedAt
        displayFinancialStatus
        displayFulfillmentStatus
        currencyCode
        tags
        customer { id }
        subtotalPriceSet  { shopMoney { amount } }
        totalPriceSet     { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        totalRefundedSet  { shopMoney { amount } }
      }
    }
  }
}`;

type ShopifyPageResult = {
  rows: any[];
  endCursor: string | null;
  hasNextPage: boolean;
};

async function fetchOrdersPage(
  store: string,
  token: string,
  cursor: string | null,
  query: string,
): Promise<ShopifyPageResult> {
  const url = `https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const body = JSON.stringify({ query: ORDERS_PAGE({ cursor, query }) });
  // Retry on 429 / throttled with exponential backoff
  let attempt = 0;
  let lastBody = "";
  while (attempt < 4) {
    attempt++;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body,
    });
    lastBody = "";
    if (res.status === 429) {
      const waitMs = 2000 * 2 ** (attempt - 1); // 2s, 4s, 8s
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      lastBody = errBody.slice(0, 200);
      // 5xx is retryable; 4xx is not
      if (res.status >= 500 && attempt < 4) {
        const waitMs = 1500 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`Shopify GQL ${res.status}: ${lastBody}`);
    }
    const json: any = await res.json();
    if (json.errors) {
      // Shopify throttled errors look like { extensions: { code: 'THROTTLED' } }
      const isThrottled = (json.errors as any[]).some(
        (e) => e?.extensions?.code === "THROTTLED",
      );
      if (isThrottled && attempt < 4) {
        const waitMs = 2000 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      const msg = (json.errors as any[]).map((e) => e?.message ?? String(e)).join("; ");
      throw new Error(`Shopify GQL errors: ${msg.slice(0, 200)}`);
    }
    const data = json.data?.orders ?? {};
    const edges: any[] = data.edges ?? [];
    const rows = edges.map((e: any) => e?.node).filter(Boolean);
    return {
      rows,
      endCursor: data.pageInfo?.endCursor ?? null,
      hasNextPage: data.pageInfo?.hasNextPage ?? false,
    };
  }
  throw new Error(`Shopify GQL: exhausted retries — ${lastBody || "unknown"}`);
}

function n(v: any): number | null {
  if (v == null) return null;
  const num = parseFloat(String(v));
  return Number.isFinite(num) ? num : null;
}

function mapOrder(code: StoreCode, domain: string, o: any) {
  return {
    // Store-qualified ID so two stores can never collide on the numeric
    // suffix of `gid://shopify/Order/...`.
    id: `${code}:${o.id}`,
    store_code: code,
    shop_domain: domain,
    order_number: o.name ?? null,
    customer_id: o.customer?.id ?? null,
    customer_lifetime_orders: null as number | null,
    financial_status: o.displayFinancialStatus ?? null,
    fulfillment_status: o.displayFulfillmentStatus ?? null,
    currency: o.currencyCode ?? null,
    total_price: n(o.totalPriceSet?.shopMoney?.amount),
    subtotal_price: n(o.subtotalPriceSet?.shopMoney?.amount),
    total_refunded: n(o.totalRefundedSet?.shopMoney?.amount),
    total_discounts: n(o.totalDiscountsSet?.shopMoney?.amount),
    total_tax: null as number | null,
    total_shipping: null as number | null,
    processed_at: o.processedAt ?? null,
    shopify_created_at: o.createdAt ?? null,
    shopify_updated_at: o.updatedAt ?? null,
    raw: {
      id: o.id,
      name: o.name,
      tags: o.tags ?? null,
    },
    synced_at: new Date().toISOString(),
  };
}

async function upsertChunked(rows: any[]) {
  if (rows.length === 0) return;
  // 50-row chunks — these payloads are smaller than Loop's (~1KB each since
  // we don't store the full raw blob), so a slightly larger chunk is fine.
  const CHUNK = 50;
  const MAX_RETRIES = 4;
  const byId = new Map<string, any>();
  for (const r of rows) byId.set(r.id, r);
  const deduped = Array.from(byId.values());
  for (let i = 0; i < deduped.length; i += CHUNK) {
    const slice = deduped.slice(i, i + CHUNK);
    let lastErr: any = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { error } = await supabaseAdmin
          .from("shopify_orders" as any)
          .upsert(slice, { onConflict: "id" });
        if (error) throw new Error(error.message);
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          const waitMs = 1000 * 2 ** (attempt - 1);
          console.warn(
            `[shopify-sync] upsert@${i} attempt ${attempt}/${MAX_RETRIES} failed: ${err?.message ?? err}. Retrying in ${waitMs}ms`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }
    if (lastErr) {
      throw new Error(
        `upsert@${i} after ${MAX_RETRIES} retries: ${lastErr?.message ?? lastErr}`,
      );
    }
  }
}

// ── State helpers ────────────────────────────────────────────────────────────
type SyncState = {
  store_code: string;
  shop_domain: string;
  last_updated_at: string | null;
  last_cursor: string | null;
  backfill_complete: boolean;
  total_orders: number;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_message: string | null;
  updated_at: string;
};

async function loadState(code: StoreCode): Promise<SyncState | null> {
  const { data, error } = await supabaseAdmin
    .from("shopify_sync_state" as any)
    .select("*")
    .eq("store_code", code)
    .maybeSingle();
  if (error) throw new Error(`shopify_sync_state read: ${error.message}`);
  return (data ?? null) as unknown as SyncState | null;
}

async function upsertState(row: Partial<SyncState> & { store_code: string; shop_domain: string }) {
  const payload = { ...row, updated_at: new Date().toISOString() };
  const { error } = await supabaseAdmin
    .from("shopify_sync_state" as any)
    .upsert(payload, { onConflict: "store_code" });
  if (error) throw new Error(`shopify_sync_state upsert: ${error.message}`);
}

async function recordError(code: StoreCode, message: string) {
  const now = new Date().toISOString();
  const { data } = await supabaseAdmin
    .from("shopify_sync_errors" as any)
    .select("retry_count")
    .eq("store_code", code)
    .maybeSingle();
  const retryCount = Number((data as any)?.retry_count ?? 0) + 1;
  await supabaseAdmin.from("shopify_sync_errors" as any).upsert(
    {
      store_code: code,
      last_error: message,
      retry_count: retryCount,
      last_seen_at: now,
      resolved_at: null,
    },
    { onConflict: "store_code" },
  );
}

async function resolveError(code: StoreCode) {
  await supabaseAdmin
    .from("shopify_sync_errors" as any)
    .update({ resolved_at: new Date().toISOString() })
    .eq("store_code", code)
    .is("resolved_at", null);
}

type RunRow = {
  id: string;
  store_code: string;
  started_at: string;
  finished_at: string | null;
  outcome: string;
};

async function createRun(code: StoreCode, mode: string, runGroupId?: string) {
  const { data, error } = await supabaseAdmin
    .from("shopify_sync_runs" as any)
    .insert({
      store_code: code,
      mode,
      run_group_id: runGroupId ?? null,
      outcome: "running",
    })
    .select("*")
    .single();
  if (error || !data) return null;
  return data as unknown as RunRow;
}

async function finishRun(run: RunRow | null, patch: Record<string, any>) {
  if (!run) return;
  await supabaseAdmin
    .from("shopify_sync_runs" as any)
    .update({
      ...patch,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - new Date(run.started_at).getTime(),
    })
    .eq("id", run.id);
}

// ── Public API ───────────────────────────────────────────────────────────────
export type ChunkResult = {
  store: StoreCode;
  mode: "backfill" | "incremental";
  pagesFetched: number;
  rowsUpserted: number;
  allDone: boolean;
  newestUpdatedAt: string | null;
  lastError?: string;
};

/**
 * Run one chunk of sync for a store. Caller wraps this in a loop to drive
 * the whole sync to completion within a wall-time budget (see syncAllShopify
 * below), or invokes it from a cron / HTTP endpoint that picks up where
 * the previous invocation left off.
 */
export async function syncShopifyChunk(
  code: StoreCode,
  opts: { maxPages?: number; timeBudgetMs?: number; runGroupId?: string } = {},
): Promise<ChunkResult> {
  const domain = storeDomain(code);
  if (!domain) {
    throw new Error(`Shopify store env missing for ${code} (set ${envFor(code)})`);
  }
  const token = await tokenFor(code);
  if (!token) {
    throw new Error(`Shopify token unavailable for ${code} — SHOPIFY_APP_CLIENT_ID/SECRET set?`);
  }

  const maxPages = opts.maxPages ?? 20;
  const timeBudgetMs = opts.timeBudgetMs ?? 45_000;
  const startedAt = Date.now();

  // Ensure state row exists
  let state = await loadState(code);
  if (!state) {
    await upsertState({
      store_code: code,
      shop_domain: domain,
      last_cursor: null,
      last_updated_at: null,
      backfill_complete: false,
      total_orders: 0,
      last_run_status: null,
      last_run_message: null,
    });
    state = (await loadState(code))!;
  }

  const mode: "backfill" | "incremental" = state.backfill_complete ? "incremental" : "backfill";
  const run = await createRun(code, mode, opts.runGroupId);

  let pagesFetched = 0;
  let rowsUpserted = 0;
  let lastError: string | undefined;
  let cursor: string | null = state.last_cursor ?? null;
  let newestUpdatedAt: string | null = state.last_updated_at ?? null;
  let allDone = false;

  // Build the GQL query filter. Backfill walks every order ever, oldest
  // first (UPDATED_AT ascending with no filter). Incremental restricts to
  // orders updated since the high-water mark.
  const baseQuery =
    mode === "incremental" && state.last_updated_at
      ? `updated_at:>='${state.last_updated_at}'`
      : "";
  // Always escape the inner double-quotes (the GraphQL `query` field is a
  // string within JSON; the ORDERS_PAGE builder wraps it in `"..."`).
  const escapedQuery = baseQuery.replace(/"/g, '\\"');

  while (pagesFetched < maxPages && Date.now() - startedAt < timeBudgetMs) {
    let page: ShopifyPageResult;
    try {
      page = await fetchOrdersPage(domain, token, cursor, escapedQuery);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      lastError = message;
      await recordError(code, message);
      await upsertState({
        store_code: code,
        shop_domain: domain,
        last_cursor: cursor,
        last_updated_at: newestUpdatedAt,
        backfill_complete: state.backfill_complete,
        total_orders: state.total_orders + rowsUpserted,
        last_run_at: new Date().toISOString(),
        last_run_status: "error",
        last_run_message: message,
      });
      break;
    }
    pagesFetched++;
    // Map and upsert
    const mapped = page.rows.map((o) => mapOrder(code, domain, o));
    try {
      await upsertChunked(mapped);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      lastError = message;
      await recordError(code, message);
      await upsertState({
        store_code: code,
        shop_domain: domain,
        last_cursor: cursor,
        last_updated_at: newestUpdatedAt,
        backfill_complete: state.backfill_complete,
        total_orders: state.total_orders + rowsUpserted,
        last_run_at: new Date().toISOString(),
        last_run_status: "error",
        last_run_message: message,
      });
      break;
    }
    rowsUpserted += mapped.length;
    // Track newest updated_at seen so we can use it as the next
    // incremental high-water mark.
    for (const r of mapped) {
      if (r.shopify_updated_at && (!newestUpdatedAt || r.shopify_updated_at > newestUpdatedAt)) {
        newestUpdatedAt = r.shopify_updated_at;
      }
    }
    cursor = page.endCursor;
    if (!page.hasNextPage) {
      // Sweep done for this mode. If we were in backfill, flip to
      // incremental and reset the cursor (next runs will use updated_at).
      if (mode === "backfill") {
        await upsertState({
          store_code: code,
          shop_domain: domain,
          last_cursor: null,
          last_updated_at: newestUpdatedAt,
          backfill_complete: true,
          total_orders: state.total_orders + rowsUpserted,
          last_run_at: new Date().toISOString(),
          last_run_status: "success",
          last_run_message: "backfill complete",
        });
      } else {
        await upsertState({
          store_code: code,
          shop_domain: domain,
          last_cursor: null,
          last_updated_at: newestUpdatedAt,
          backfill_complete: true,
          total_orders: state.total_orders + rowsUpserted,
          last_run_at: new Date().toISOString(),
          last_run_status: "success",
          last_run_message: "incremental sweep complete",
        });
      }
      await resolveError(code);
      allDone = true;
      break;
    }
    // Persist progress every page so the UI can see the cursor move.
    await upsertState({
      store_code: code,
      shop_domain: domain,
      last_cursor: cursor,
      last_updated_at: newestUpdatedAt,
      backfill_complete: state.backfill_complete,
      total_orders: state.total_orders + rowsUpserted,
      last_run_at: new Date().toISOString(),
      last_run_status: "running",
      last_run_message: null,
    });
  }

  const totalAfter = state.total_orders + rowsUpserted;
  await finishRun(run, {
    pages_fetched: pagesFetched,
    rows_upserted: rowsUpserted,
    total_after_run: totalAfter,
    outcome: lastError ? "error" : allDone ? "success" : "partial",
    last_error: lastError ?? null,
    meta: { mode, newestUpdatedAt },
  });

  return {
    store: code,
    mode,
    pagesFetched,
    rowsUpserted,
    allDone,
    newestUpdatedAt,
    lastError,
  };
}

/**
 * Drive every store to completion within a wall-time budget. Used by
 * cron / admin sync-now buttons. Runs the 3 stores in parallel; each loops
 * until allDone or the slice budget is exhausted.
 */
export async function syncAllShopify(opts: { wallBudgetMs?: number } = {}): Promise<ChunkResult[]> {
  const wall = opts.wallBudgetMs ?? 90_000;
  const start = Date.now();
  const codes: StoreCode[] = ["NL", "UK", "US"];
  const results: Record<StoreCode, ChunkResult> = {
    NL: { store: "NL", mode: "backfill", pagesFetched: 0, rowsUpserted: 0, allDone: false, newestUpdatedAt: null },
    UK: { store: "UK", mode: "backfill", pagesFetched: 0, rowsUpserted: 0, allDone: false, newestUpdatedAt: null },
    US: { store: "US", mode: "backfill", pagesFetched: 0, rowsUpserted: 0, allDone: false, newestUpdatedAt: null },
  };
  while (Date.now() - start < wall) {
    const remaining = wall - (Date.now() - start);
    const slice = Math.max(8_000, Math.floor(remaining / 2));
    const settled = await Promise.allSettled(
      codes.map((c) =>
        results[c].allDone
          ? Promise.resolve(null)
          : syncShopifyChunk(c, { timeBudgetMs: slice, maxPages: 30 }),
      ),
    );
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      const r = settled[i];
      if (r.status === "fulfilled" && r.value) {
        // accumulate
        const v = r.value;
        results[c] = {
          store: c,
          mode: v.mode,
          pagesFetched: results[c].pagesFetched + v.pagesFetched,
          rowsUpserted: results[c].rowsUpserted + v.rowsUpserted,
          allDone: v.allDone,
          newestUpdatedAt: v.newestUpdatedAt,
          lastError: v.lastError,
        };
      } else if (r.status === "rejected") {
        results[c].lastError = String(r.reason?.message ?? r.reason);
      }
    }
    if (codes.every((c) => results[c].allDone)) break;
  }
  return codes.map((c) => results[c]);
}

// Status helpers for the sync-status page
export async function getShopifySyncState() {
  const { data, error } = await supabaseAdmin
    .from("shopify_sync_state" as any)
    .select("*");
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as SyncState[];
}

export async function getShopifySyncRuns(limit = 20) {
  const { data } = await supabaseAdmin
    .from("shopify_sync_runs" as any)
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function getShopifySyncErrors() {
  const { data } = await supabaseAdmin
    .from("shopify_sync_errors" as any)
    .select("*")
    .order("last_seen_at", { ascending: false });
  return data ?? [];
}

export async function resetShopifyState(code: StoreCode) {
  const domain = storeDomain(code);
  if (!domain) throw new Error(`Shopify env not set for ${code}`);
  await upsertState({
    store_code: code,
    shop_domain: domain,
    last_cursor: null,
    last_updated_at: null,
    backfill_complete: false,
    total_orders: 0,
    last_run_status: null,
    last_run_message: null,
  });
}
