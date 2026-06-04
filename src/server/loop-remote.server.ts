// Thin client for the standalone Loop → Supabase sync microservice.
//
// Source: c:\DivyCode\loop-sync-service (deployed on Railway).
// When LOOP_SYNC_SERVICE_URL is set, the dashboard's "Sync Loop" triggers
// delegate the actual pagination work to that hosted service instead of
// running it inside the Worker. The microservice writes directly to
// public."UK_loop" / "US_loop", and the dashboard re-reads those tables via
// fetchLoopFromDb on the next page load — so there's nothing to await here
// beyond confirming the remote sync was accepted.

type Market = "UK" | "US";

// The Loop microservice is now the same Railway backend that runs all the
// other heavy jobs, so accept BACKEND_SYNC_URL / SYNC_SECRET (the unified env)
// first and fall back to the legacy LOOP_SYNC_SERVICE_* names.
function remoteBaseUrl(): string | null {
  return (
    process.env.BACKEND_SYNC_URL ||
    process.env.LOOP_SYNC_SERVICE_URL ||
    process.env.VITE_BACKEND_SYNC_URL ||
    (import.meta as any).env?.VITE_BACKEND_SYNC_URL ||
    null
  );
}

function remoteSecret(): string | null {
  return (
    process.env.SYNC_SECRET ||
    process.env.LOOP_SYNC_SERVICE_SECRET ||
    process.env.BACKEND_SYNC_SECRET ||
    null
  );
}

export function isRemoteLoopSyncConfigured(): boolean {
  return !!remoteBaseUrl();
}

export async function triggerRemoteLoopSync(
  market?: Market,
): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
  url: string;
  market: Market | "all";
}> {
  const base = remoteBaseUrl();
  if (!base) throw new Error("No backend sync URL set (BACKEND_SYNC_URL / LOOP_SYNC_SERVICE_URL)");
  const secret = remoteSecret();

  const url = new URL("/sync", base);
  if (market) url.searchParams.set("market", market);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (secret) headers["X-Sync-Secret"] = secret;

  const res = await fetch(url.toString(), { method: "POST", headers });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { ok: res.ok, status: res.status, body, url: url.toString(), market: market ?? "all" };
}
