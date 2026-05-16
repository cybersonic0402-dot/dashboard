import { createServerFn } from "@tanstack/react-start";
import { requireAllowedUser } from "./auth.middleware";
import { readAllCache, ageMinutes, getWriteErrors } from "./cache.server";

export interface ProviderDebug {
  provider: string;
  key: string;
  id: string;
  status: "live" | "empty" | "error" | "missing";
  fetchedAt: string | null;
  ageMinutes: number | null;
  payloadSize: number;
  emptyMarker: boolean;
  errorMarker: boolean;
  errorMessage: string | null;
  writeError: { message: string; at: string } | null;
}

const TRACKED: Array<{ provider: string; key: string }> = [
  { provider: "shopify", key: "markets" },
  { provider: "shopify", key: "monthly" },
  { provider: "shopify", key: "today" },
  { provider: "triplewhale", key: "summary" },
  { provider: "loop", key: "subscriptions" },
  { provider: "juo", key: "subscriptions" },
  { provider: "jortt", key: "invoices" },
  { provider: "xero", key: "accounting" },
];

export const getSyncDebug = createServerFn({ method: "GET" }).middleware([requireAllowedUser]).handler(async () => {
  const cache = await readAllCache();
  const writeErrors = getWriteErrors();

  const providers: ProviderDebug[] = TRACKED.map(({ provider, key }) => {
    const id = `${provider}/${key}`;
    const entry = cache[id] ?? null;
    const payload: any = entry?.payload ?? null;
    const writeErr = writeErrors[id] ?? null;

    const emptyMarker = !!payload && payload.__empty === true;
    const errorMarker = !!payload && payload.__error === true;
    const errorMessage =
      errorMarker && typeof payload?.message === "string" ? payload.message : null;

    let status: ProviderDebug["status"];
    if (!entry) status = "missing";
    else if (errorMarker) status = "error";
    else if (emptyMarker) status = "empty";
    else status = "live";

    const payloadSize = entry ? JSON.stringify(payload ?? null).length : 0;

    return {
      provider,
      key,
      id,
      status,
      fetchedAt: entry?.fetchedAt ?? null,
      ageMinutes: entry ? Math.round(ageMinutes(entry.fetchedAt)) : null,
      payloadSize,
      emptyMarker,
      errorMarker,
      errorMessage,
      writeError: writeErr,
    };
  });

  // Most recent successful write across all providers.
  const successfulFetches = providers
    .filter((p) => p.fetchedAt && p.status === "live")
    .map((p) => p.fetchedAt as string);
  const lastSuccessAt =
    successfulFetches.length > 0
      ? successfulFetches.reduce((a, b) => (a > b ? a : b))
      : null;

  // Most recent write of any kind.
  const allFetches = providers.filter((p) => p.fetchedAt).map((p) => p.fetchedAt as string);
  const lastWriteAt =
    allFetches.length > 0 ? allFetches.reduce((a, b) => (a > b ? a : b)) : null;

  // Per-store Shopify status, derived from the shopify/markets payload.
  // Keys match the SyncView store ids (e.g. "shopify_zapply-nl").
  const shopifyStores: Record<string, "live" | "empty" | "error" | "missing"> = {};
  const shopifyEntry = cache["shopify/markets"];
  const shopifyPayload: any = shopifyEntry?.payload ?? null;
  const SHOPIFY_STORE_IDS: Record<string, string> = {
    NL: "shopify_zapply-nl",
    UK: "shopify_zapplyde",
    US: "shopify_zapply-usa",
    
  };
  if (Array.isArray(shopifyPayload)) {
    for (const market of shopifyPayload) {
      const id = SHOPIFY_STORE_IDS[market?.code];
      if (!id) continue;
      if (market.live === true) shopifyStores[id] = "live";
      else if (market.error) shopifyStores[id] = "error";
      else shopifyStores[id] = "missing";
    }
  } else if (shopifyPayload?.__error) {
    for (const id of Object.values(SHOPIFY_STORE_IDS)) shopifyStores[id] = "error";
  } else if (shopifyPayload?.__empty) {
    for (const id of Object.values(SHOPIFY_STORE_IDS)) shopifyStores[id] = "empty";
  } else if (!shopifyEntry) {
    for (const id of Object.values(SHOPIFY_STORE_IDS)) shopifyStores[id] = "missing";
  }

  return {
    providers,
    shopifyStores,
    lastSuccessAt,
    lastWriteAt,
    writeErrorCount: Object.keys(writeErrors).length,
    generatedAt: new Date().toISOString(),
  };
});
