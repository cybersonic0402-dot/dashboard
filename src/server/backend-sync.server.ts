// Bridge to the Railway backend (zapply-dash-backend).
//
// The heavy sync jobs — Shopify order backfill, the full data_cache refresh,
// subscription snapshots — were migrated off Vercel because they routinely
// blew past the 300s `maxDuration` ceiling (and Cloudflare/Vercel kill
// background promises once the response is sent). They now run on Railway,
// which has no request timeout.
//
// These trigger routes forward to the backend when VITE_BACKEND_HOST is set,
// and otherwise fall back to running the work inline (legacy behaviour) so the
// app still functions in environments where the backend isn't configured.

import { resolveBackendHost } from "@/lib/backend-host";

export function backendSyncBaseUrl(): string | null {
  return resolveBackendHost();
}

export interface BackendTriggerResult {
  /** Whether a backend was configured and we attempted to forward. */
  forwarded: boolean;
  /** Whether the backend accepted the job (HTTP 2xx). */
  ok: boolean;
  status: number;
  body?: any;
  error?: string;
}

/**
 * Fire a backend sync job (fire-and-forget on the backend side — it returns
 * 202 immediately and runs to completion in the background on Railway).
 *
 * @param path e.g. "/sync/nightly", "/sync/dashboard", "/sync/shopify-orders"
 */
export async function triggerBackendSync(path: string): Promise<BackendTriggerResult> {
  const base = backendSyncBaseUrl();
  if (!base) return { forwarded: false, ok: false, status: 0, error: "BACKEND_SYNC_URL not set" };

  const secret =
    process.env.SYNC_SECRET ||
    process.env.BACKEND_SYNC_SECRET ||
    (import.meta as any).env?.VITE_BACKEND_SYNC_SECRET ||
    null;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["X-Sync-Secret"] = String(secret);

  try {
    const res = await fetch(`${base}${path}`, { method: "POST", headers });
    const body = await res.json().catch(() => null);
    return { forwarded: true, ok: res.ok, status: res.status, body };
  } catch (err: any) {
    return { forwarded: true, ok: false, status: 0, error: err?.message ?? String(err) };
  }
}

/**
 * GET the Redis-backed dashboard cache from the backend (~2ms HGETALL).
 * Returns null when no backend is configured, on any error, or on a non-2xx —
 * the caller then falls back to reading Supabase directly. `timeoutMs` keeps a
 * slow/unreachable backend from blocking the dashboard render.
 */
export async function fetchBackendCache<T = any>(
  path = "/cache",
  timeoutMs = 1500,
): Promise<T | null> {
  const base = backendSyncBaseUrl();
  if (!base) return null;

  const secret =
    process.env.SYNC_SECRET ||
    process.env.BACKEND_SYNC_SECRET ||
    (import.meta as any).env?.VITE_BACKEND_SYNC_SECRET ||
    null;
  const headers: Record<string, string> = {};
  if (secret) headers["X-Sync-Secret"] = String(secret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
