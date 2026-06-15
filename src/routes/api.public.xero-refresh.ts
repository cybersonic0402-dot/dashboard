import { createFileRoute } from "@tanstack/react-router";
import { refreshXeroToken } from "@/server/fetchers.server";
import { verifySyncSecret } from "@/server/sync-auth.server";

// POST/GET /api/public/xero-refresh
//   Dedicated, lightweight Xero token keep-alive. Refreshes the access token
//   (rotating the refresh token) and returns immediately — completes inside the
//   request (<2s), unlike the heavy multi-provider /api/public/sync which is
//   fire-and-forget and gets killed on Vercel/Workers before the Xero refresh
//   runs. A frequent cron pings this so the 60-day refresh-token TTL never
//   lapses and the connection never needs a manual reconnect.
//
//   Auth: shared SYNC_SECRET via the X-Sync-Token header (same as /api/public/sync).
async function handle(request: Request) {
  const denied = verifySyncSecret(request);
  if (denied) return denied;

  const startedAt = new Date().toISOString();
  const result = await refreshXeroToken();

  return Response.json(
    {
      ok: result.ok,
      provider: "xero",
      tenant: result.tenant,
      expiresAt: result.expiresAt,
      refreshTokenAgeDays: result.refreshTokenAgeDays,
      error: result.error,
      startedAt,
      finishedAt: new Date().toISOString(),
      message: result.ok
        ? "Xero access token is fresh; refresh token rotated/kept alive."
        : "Xero token refresh failed — reconnect at /api/auth/xero if this persists.",
    },
    { status: result.ok ? 200 : 502 },
  );
}

export const Route = createFileRoute("/api/public/xero-refresh")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
    },
  },
});
