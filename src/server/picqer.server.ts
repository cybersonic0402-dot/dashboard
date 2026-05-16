/**
 * Picqer Fulfilment integration — pulls inventory (per-warehouse stock) from
 * a Picqer-hosted 3PL backend. Many UK / EU fulfilment providers (incl. TRL
 * Fulfilment) run their portal on Picqer's WMS.
 *
 * Auth — HTTP Basic, with the API key as the *username* and an empty
 * password. The User-Agent header is mandatory; Picqer rejects requests that
 * don't identify themselves.
 *   https://picqer.com/en/api
 *
 * Endpoints used:
 *   GET /api/v1/products       — paginated product list (incl. embedded
 *                                stock-per-warehouse array)
 *   GET /api/v1/warehouses     — resolves idwarehouse → human-readable name
 *
 * Pagination: 100 rows per page, advance with ?offset=N.
 * Rate limit: 500 req/min — well within budget for incremental syncs.
 *
 * Output mirrors the existing manual `inventory_positions` shape so the
 * dashboard consumers (FinanceDashboard + balance-sheet pillar) can read
 * Picqer-sourced rows without any extra mapping at the call site:
 *   { sku, name, location, pieces, unit_cost_eur, source: "picqer" }
 */

const PAGE_SIZE = 100;
const DEFAULT_USER_AGENT = "ZapplyDash (zapply.dev - support@zapply.dev)";

/**
 * Normalize whatever the user pasted into PICQER_SUBDOMAIN. Accept any of:
 *   - bare subdomain:        "trl-fulfilment"
 *   - hostname:              "trl-fulfilment.picqer.com"
 *   - full URL with scheme:  "https://trl-fulfilment.picqer.com/"
 *   - URL with trailing path: "https://trl-fulfilment.picqer.com/api/v1"
 * All forms collapse to the bare subdomain so `${subdomain}.picqer.com`
 * always produces a single valid hostname (never the trl.picqer.com.picqer.com
 * double-suffix that bit us at launch).
 */
function normalizeSubdomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Drop scheme
  s = s.replace(/^https?:\/\//i, "");
  // Drop trailing path / slash
  s = s.split("/")[0];
  // Drop .picqer.com suffix (and any trailing dot)
  s = s.replace(/\.?picqer\.com\.?$/i, "");
  s = s.replace(/\.+$/, "");
  return s || null;
}

function resolveCreds() {
  const subdomain = normalizeSubdomain(
    process.env.PICQER_SUBDOMAIN ||
      process.env.FULFILMENT_SUBDOMAIN ||
      process.env.FULLFILMENT_SUBDOMAIN ||
      null,
  );
  // Accept the legacy typo'd env name (FULLFILMENT_PROVIDER_API_KEY) so we
  // don't force the user to rename .env keys before the first sync works.
  const apiKey =
    process.env.PICQER_API_KEY ||
    process.env.FULFILMENT_API_KEY ||
    process.env.FULLFILMENT_PROVIDER_API_KEY ||
    null;
  const userAgent =
    process.env.PICQER_USER_AGENT ||
    process.env.FULFILMENT_USER_AGENT ||
    DEFAULT_USER_AGENT;
  return { subdomain, apiKey, userAgent };
}

function base64(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s).toString("base64");
  // Workers / browser path
  // eslint-disable-next-line no-undef
  return btoa(s);
}

function picqerHeaders(apiKey: string, userAgent: string): Record<string, string> {
  // HTTP Basic: "username:password" base64-encoded. Picqer wants the API
  // key as the username, password ignored — but a trailing ":" is still
  // required by the Basic Auth spec, so we send "apiKey:".
  return {
    Authorization: `Basic ${base64(`${apiKey}:`)}`,
    "User-Agent": userAgent,
    Accept: "application/json",
  };
}

type PicqerStock = {
  idwarehouse: number;
  stock: number;
  reserved?: number;
  reservedbackorders?: number;
  reservedpicklists?: number;
  reservedallocations?: number;
  freestock?: number;
};

type PicqerProduct = {
  idproduct: number;
  productcode: string;
  name: string;
  price?: number | null;
  fixedstockprice?: number | null;
  stock?: PicqerStock[];
};

type PicqerWarehouse = {
  idwarehouse: number;
  name?: string;
  accept_orders?: boolean;
  active?: boolean;
};

export type PicqerInventoryRow = {
  sku: string;
  name: string;
  location: string;     // warehouse name (fallback to "warehouse-<id>")
  idwarehouse: number;
  pieces: number;       // free stock — total minus reservations
  pieces_total: number; // on-hand stock (incl. reservations) for reconciliation
  unit_cost_eur: number;
  source: "picqer";
};

async function picqerGet<T>(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  query?: Record<string, string | number>,
): Promise<T | null> {
  const qs = query
    ? "?" + Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")
    : "";
  const url = `${baseUrl}${path}${qs}`;
  let res: Response;
  let attempt = 0;
  // 429 retry with light backoff. Picqer rate limit is generous so this
  // should rarely fire, but we keep it for safety on big initial syncs.
  while (true) {
    try {
      res = await fetch(url, { headers, cache: "no-store" });
    } catch (err: any) {
      // fetch() throws on DNS failure, connection refused, TLS errors, etc.
      // Always echo the URL we tried to hit — that single string answers
      // 90% of "why is it failing" questions (wrong subdomain, typo, etc.).
      const cause = err?.cause?.code ?? err?.code ?? err?.name ?? "unknown";
      throw new Error(
        `Picqer network error reaching ${url} — ${cause}: ${err?.message ?? String(err)}. ` +
          `Check that PICQER_SUBDOMAIN is correct; if you pasted "trl-fulfilment.picqer.com" or "https://trl-fulfilment.picqer.com" that's fine, the code now normalizes them.`,
      );
    }
    if (res.status !== 429 || attempt >= 3) break;
    const wait = 1000 * 2 ** attempt; // 1s, 2s, 4s
    await new Promise((r) => setTimeout(r, wait));
    attempt++;
  }
  if (res.status === 401) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    // Pull the headers Picqer (or a gateway in front of it) actually sets.
    // WWW-Authenticate often tells us the expected scheme; Server / X-Powered-By
    // sometimes reveals it's a CDN 401 (e.g. Cloudflare WAF) rather than Picqer.
    const wwwAuth = res.headers.get("www-authenticate") ?? "—";
    const server = res.headers.get("server") ?? "—";
    const cfRay = res.headers.get("cf-ray") ?? null;
    // Surface a redacted preview of the Authorization header value so we can
    // confirm Basic auth is being formed (never log the raw key).
    const authHeader = headers.Authorization ?? "";
    const authPreview = authHeader
      ? `${authHeader.slice(0, 12)}…${authHeader.length > 16 ? authHeader.slice(-4) : ""} (len=${authHeader.length})`
      : "(none)";
    const uaPreview = headers["User-Agent"] ?? "(none)";
    throw new Error(
      `Picqer 401 from ${url}. ` +
        `WWW-Authenticate=${wwwAuth} · Server=${server}${cfRay ? ` · CF-Ray=${cfRay}` : ""}. ` +
        `Request sent: Authorization=${authPreview}, User-Agent="${uaPreview}". ` +
        `Body: ${body || "(empty — Picqer rejected before the API; usually means tenant/key mismatch)"}. ` +
        `Verify in Picqer admin: Settings > API Keys → the key you copied is listed there AND active. ` +
        `If the key was created on a different tenant, point PICQER_SUBDOMAIN at that tenant.`,
    );
  }
  if (res.status === 404) {
    throw new Error(
      `Picqer 404 from ${url} — the tenant subdomain resolves but the endpoint isn't there. Most likely PICQER_SUBDOMAIN points at the wrong tenant.`,
    );
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Picqer ${res.status} from ${url}: ${body}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetches the full /products list, paginated.
 * Picqer's /products embeds the per-warehouse stock array, so a single
 * paginated walk is enough — we don't need to make a second call per
 * product to /product-stock.
 */
async function fetchAllProducts(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<PicqerProduct[]> {
  const all: PicqerProduct[] = [];
  let offset = 0;
  // Hard cap so a malformed paging response can't infinite-loop.
  for (let page = 0; page < 200; page++) {
    const batch = await picqerGet<PicqerProduct[]>(baseUrl, "/api/v1/products", headers, {
      offset,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

async function fetchWarehouses(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const list = await picqerGet<PicqerWarehouse[]>(baseUrl, "/api/v1/warehouses", headers);
    for (const w of list ?? []) {
      if (typeof w?.idwarehouse === "number") {
        map.set(w.idwarehouse, String(w.name ?? `warehouse-${w.idwarehouse}`));
      }
    }
  } catch (err: any) {
    // Non-fatal — we can still render rows labelled "warehouse-<id>".
    console.warn(`[picqer] warehouses lookup failed: ${err?.message ?? err}`);
  }
  return map;
}

/**
 * Fetch + flatten Picqer inventory into one row per (SKU, warehouse).
 * Throws on auth / config errors so the caller can surface them via the
 * cache `__error` payload pattern used elsewhere in the codebase.
 */
export async function fetchPicqerInventory(): Promise<{
  live: true;
  fetchedAt: string;
  calcVersion: 1;
  totalProducts: number;
  totalRows: number;
  rows: PicqerInventoryRow[];
  warehouses: Array<{ idwarehouse: number; name: string }>;
}> {
  const { subdomain, apiKey, userAgent } = resolveCreds();
  if (!subdomain) {
    throw new Error(
      "PICQER_SUBDOMAIN is not set. Add it to .env — it's the subdomain that comes before .picqer.com in your TRL Fulfilment admin URL (e.g. PICQER_SUBDOMAIN=trlfulfilment).",
    );
  }
  if (!apiKey) {
    throw new Error(
      "PICQER_API_KEY is not set. Either set PICQER_API_KEY in .env, or rely on the legacy FULLFILMENT_PROVIDER_API_KEY value (already supported as a fallback).",
    );
  }
  const baseUrl = `https://${subdomain}.picqer.com`;
  const headers = picqerHeaders(apiKey, userAgent);

  const [products, warehouseNames] = await Promise.all([
    fetchAllProducts(baseUrl, headers),
    fetchWarehouses(baseUrl, headers),
  ]);

  const rows: PicqerInventoryRow[] = [];
  for (const p of products) {
    const sku = String(p.productcode ?? "").trim();
    if (!sku) continue;
    const unitCost = Number(p.fixedstockprice ?? p.price ?? 0);
    const stockArr = Array.isArray(p.stock) ? p.stock : [];
    if (stockArr.length === 0) continue;
    for (const s of stockArr) {
      const id = Number(s?.idwarehouse);
      if (!Number.isFinite(id)) continue;
      const free = Number(s?.freestock ?? s?.stock ?? 0);
      const total = Number(s?.stock ?? 0);
      // Skip rows with no stock and no cost signal — they pollute the table.
      if (free === 0 && total === 0) continue;
      rows.push({
        sku,
        name: String(p.name ?? sku),
        location: warehouseNames.get(id) ?? `warehouse-${id}`,
        idwarehouse: id,
        pieces: free,
        pieces_total: total,
        unit_cost_eur: Number.isFinite(unitCost) ? unitCost : 0,
        source: "picqer",
      });
    }
  }

  // Stable ordering — SKU then warehouse — so cached payloads diff cleanly
  // and the UI doesn't reshuffle on every sync.
  rows.sort((a, b) => a.sku.localeCompare(b.sku) || a.idwarehouse - b.idwarehouse);

  return {
    live: true,
    fetchedAt: new Date().toISOString(),
    calcVersion: 1,
    totalProducts: products.length,
    totalRows: rows.length,
    rows,
    warehouses: Array.from(warehouseNames.entries()).map(([idwarehouse, name]) => ({
      idwarehouse,
      name,
    })),
  };
}

/**
 * Lightweight reachability probe — used by /admin/manual-data and the
 * sync-status page to surface auth/config problems without forcing a full
 * inventory pull. Returns a structured result instead of throwing so callers
 * can render a clear status.
 */
export async function probePicqer(): Promise<{
  ok: boolean;
  status: number | null;
  reason: string | null;
  baseUrl: string | null;
  warehouseCount?: number;
}> {
  const { subdomain, apiKey, userAgent } = resolveCreds();
  if (!subdomain || !apiKey) {
    return {
      ok: false,
      status: null,
      baseUrl: null,
      reason: !subdomain
        ? "PICQER_SUBDOMAIN missing in .env"
        : "PICQER_API_KEY missing in .env",
    };
  }
  const baseUrl = `https://${subdomain}.picqer.com`;
  try {
    const list = await picqerGet<PicqerWarehouse[]>(
      baseUrl,
      "/api/v1/warehouses",
      picqerHeaders(apiKey, userAgent),
    );
    return {
      ok: true,
      status: 200,
      baseUrl,
      reason: null,
      warehouseCount: Array.isArray(list) ? list.length : 0,
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const m = msg.match(/Picqer (\d+)/);
    return {
      ok: false,
      status: m ? Number(m[1]) : null,
      baseUrl,
      reason: msg.slice(0, 400),
    };
  }
}
