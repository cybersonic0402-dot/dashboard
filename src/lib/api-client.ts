// Client for the Railway backend read API (Phase 3).
//
// The pure-SPA frontend calls the backend over HTTPS, attaching the user's
// Supabase access token as a Bearer JWT (the backend's requireUser middleware
// verifies it + checks the allowlist). Point VITE_API_URL at the backend, e.g.
//   VITE_API_URL=https://zapplysyncmicro.up.railway.app
import { supabase } from "@/integrations/supabase/client";
import { resolveBackendHost } from "@/lib/backend-host";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function apiBaseUrl(): string {
  const u = resolveBackendHost();
  if (!u) {
    throw new ApiError(0, "VITE_BACKEND_HOST is not set — point it at the Railway backend host.");
  }
  return u;
}

type QueryParams = Record<string, string | number | boolean | null | undefined>;

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** GET a JSON resource from the backend read API. */
export async function apiGet<T = unknown>(path: string, params?: QueryParams): Promise<T> {
  const url = new URL(apiBaseUrl() + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { headers: await authHeaders() });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const msg = (body as any)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, body);
  }
  return (await res.json()) as T;
}

/** POST a JSON action to the backend (JWT-gated). */
export async function apiPost<T = unknown>(path: string, payload?: unknown): Promise<T> {
  return apiSend<T>("POST", path, payload);
}

/** DELETE a resource on the backend (JWT-gated). */
export async function apiDelete<T = unknown>(path: string): Promise<T> {
  return apiSend<T>("DELETE", path);
}

async function apiSend<T>(method: "POST" | "DELETE" | "PUT", path: string, payload?: unknown): Promise<T> {
  const res = await fetch(apiBaseUrl() + path, {
    method,
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, (body as any)?.error ?? `Request failed (${res.status})`, body);
  }
  return (await res.json()) as T;
}
