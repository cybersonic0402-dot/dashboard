import { createClient as createSupabaseJS } from "@supabase/supabase-js";
import { getRequestHeader } from "@tanstack/react-start/server";
import { resolveSupabasePublishableKey, resolveSupabaseServiceKey, resolveSupabaseUrl } from "./supabase-env.server";

// Resolve Supabase credentials with sensible fallbacks.
// In the TanStack Worker runtime, only VITE_* vars are injected reliably;
// SUPABASE_SERVICE_ROLE_KEY may be unavailable. The data_cache table has
// permissive RLS for authenticated users, so the publishable/anon key works.
function resolveCreds() {
  const url = resolveSupabaseUrl();
  const key = resolveSupabaseServiceKey();
  return { url, key };
}

let _client: ReturnType<typeof createSupabaseJS> | null = null;
function serviceClient() {
  if (!_client) {
    const { url, key } = resolveCreds();
    if (!url || !key) {
      throw new Error(
        `Supabase creds missing (url=${!!url}, key=${!!key}). Need SUPABASE_URL/VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/VITE_SUPABASE_PUBLISHABLE_KEY.`
      );
    }
    _client = createSupabaseJS(url, key, { auth: { persistSession: false } });
  }
  return _client;
}

function requestClient() {
  try {
    const auth = getRequestHeader("authorization");
    if (!auth?.startsWith("Bearer ")) return serviceClient();
    const { url } = resolveCreds();
    const publishableKey = resolveSupabasePublishableKey();
    if (!url || !publishableKey) return serviceClient();
    return createSupabaseJS(url, publishableKey, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return serviceClient();
  }
}

export interface CacheEntry {
  payload: any;
  fetchedAt: string;
}

export type CacheMap = Record<string, CacheEntry | null>;

// Keep a server-memory fallback long enough for preview/dev syncs to be visible.
// If Supabase rejects writes because the service-role key is unavailable, the
// dashboard can still show the freshly fetched data in the current runtime.
const MEMORY_TTL_MS = 30 * 60_000;
const rowMemory = new Map<string, { entry: CacheEntry; readAt: number }>();

function cacheId(provider: string, key: string) {
  return `${provider}/${key}`;
}

function remember(provider: string, key: string, entry: CacheEntry) {
  rowMemory.set(cacheId(provider, key), { entry, readAt: Date.now() });
}

function getRemembered(provider: string, key: string): CacheEntry | null {
  const hit = rowMemory.get(cacheId(provider, key));
  if (!hit) return null;
  if (Date.now() - hit.readAt > MEMORY_TTL_MS) {
    rowMemory.delete(cacheId(provider, key));
    return null;
  }
  return hit.entry;
}

/** Fetch one cache entry instead of downloading the whole cache table. */
export async function readCache(provider: string, key: string): Promise<CacheEntry | null> {
  const remembered = getRemembered(provider, key);
  if (remembered) return remembered;

  try {
    const { data, error } = await (requestClient() as any)
      .from("data_cache")
      .select("payload, fetched_at")
      .eq("provider", provider)
      .eq("cache_key", key)
      .maybeSingle();
    if (error) {
      console.error(`readCache ${provider}/${key} error:`, error.message);
      return null;
    }
    if (!data) return null;
    const entry = { payload: data.payload, fetchedAt: data.fetched_at };
    remember(provider, key, entry);
    return entry;
  } catch (err: any) {
    console.error(`readCache ${provider}/${key} exception:`, err?.message);
    return null;
  }
}

/** Fetch only selected cache entries, used by the overview dashboard. */
export async function readCacheKeys(keys: Array<[string, string]>): Promise<CacheMap> {
  if (keys.length === 0) return {};

  const out: CacheMap = {};
  const missing: Array<[string, string]> = [];
  for (const [provider, key] of keys) {
    const remembered = getRemembered(provider, key);
    if (remembered) out[cacheId(provider, key)] = remembered;
    else missing.push([provider, key]);
  }
  if (missing.length === 0) return out;

  const providers = [...new Set(missing.map(([provider]) => provider))];
  const cacheKeys = [...new Set(missing.map(([, key]) => key))];
  const wanted = new Set(missing.map(([provider, key]) => cacheId(provider, key)));

  try {
    const { data, error } = await (requestClient() as any)
      .from("data_cache")
      .select("provider, cache_key, payload, fetched_at")
      .in("provider", providers)
      .in("cache_key", cacheKeys);
    if (error) {
      console.error("readCacheKeys error:", error.message);
      return out;
    }
    for (const row of (data ?? []) as any[]) {
      const id = cacheId(row.provider, row.cache_key);
      if (!wanted.has(id)) continue;
      const entry = { payload: row.payload, fetchedAt: row.fetched_at };
      out[id] = entry;
      remember(row.provider, row.cache_key, entry);
    }
    return out;
  } catch (err: any) {
    console.error("readCacheKeys exception:", err?.message);
    return out;
  }
}

/**
 * Fetch all dashboard cache rows in ONE query.
 * Returns a map keyed by "provider/cache_key".
 */
export async function readAllCache(): Promise<CacheMap> {
  try {
    const { data, error } = await (requestClient() as any)
      .from("data_cache")
      .select("provider, cache_key, payload, fetched_at");
    if (error) {
      console.error("readAllCache error:", error.message);
      return {};
    }
    if (!data) return {};
    const map: CacheMap = {};
    for (const row of data as any[]) {
      map[`${row.provider}/${row.cache_key}`] = {
        payload: row.payload,
        fetchedAt: row.fetched_at,
      };
      remember(row.provider, row.cache_key, map[`${row.provider}/${row.cache_key}`]!);
    }
    return map;
  } catch (err: any) {
    console.error("readAllCache exception:", err?.message);
    return {};
  }
}

/**
 * In-memory log of the most recent write error per "provider/key".
 * Cleared automatically on the next successful write. Read by the
 * sync debug endpoint to surface what's actually breaking.
 */
const lastWriteErrors = new Map<string, { message: string; at: string }>();

export function getWriteErrors(): Record<string, { message: string; at: string }> {
  const out: Record<string, { message: string; at: string }> = {};
  for (const [k, v] of lastWriteErrors.entries()) out[k] = v;
  return out;
}

/** Write one cache entry. Skips writes when payload is null/undefined. */
export async function writeCache(provider: string, key: string, payload: any): Promise<void> {
  const id = `${provider}/${key}`;
  if (payload === null || payload === undefined) {
    // Don't try to persist a null payload — the column is NOT NULL and the
    // upstream fetcher just signalled "no data". Record the reason instead.
    const msg = "fetcher returned null (no data / upstream error)";
    console.warn(`writeCache ${id} skipped:`, msg);
    lastWriteErrors.set(id, { message: msg, at: new Date().toISOString() });
    return;
  }
  const fetchedAt = new Date().toISOString();
  remember(provider, key, { payload, fetchedAt });
  try {
    const { error } = await (requestClient() as any)
      .from("data_cache")
      .upsert(
        { provider, cache_key: key, payload, fetched_at: fetchedAt },
        { onConflict: "provider,cache_key" }
      );
    if (error) {
      const msg = error.message || String(error);
      console.error(`writeCache ${id} db error:`, msg);
      lastWriteErrors.set(id, { message: msg, at: new Date().toISOString() });
    } else {
      // Clear any previous error after a successful write.
      lastWriteErrors.delete(id);
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`writeCache ${id}:`, msg);
    lastWriteErrors.set(id, { message: msg, at: new Date().toISOString() });
  }
}

/** Age of a cache entry in minutes. Returns Infinity if null/missing. */
export function ageMinutes(fetchedAt: string | null | undefined): number {
  if (!fetchedAt) return Infinity;
  return (Date.now() - new Date(fetchedAt).getTime()) / 60_000;
}

