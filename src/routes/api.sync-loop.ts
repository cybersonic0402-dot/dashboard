import { createFileRoute } from "@tanstack/react-router";
import { verifyAllowedUser } from "@/server/user-auth.server";
import { triggerRemoteLoopSync, isRemoteLoopSyncConfigured } from "@/server/loop-remote.server";

// POST /api/sync-loop          → delegate full sync (UK + US) to Railway microservice
// POST /api/sync-loop?market=UK → delegate UK sync only
//
// The actual pagination + Supabase writes now run on the standalone
// loop-sync-service (c:\DivyCode\loop-sync-service, deployed at
// LOOP_SYNC_SERVICE_URL). This route just forwards the trigger.
export const Route = createFileRoute("/api/sync-loop")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await verifyAllowedUser(request, { requireAdmin: true });
        if (denied) return denied;
        if (!isRemoteLoopSyncConfigured()) {
          return Response.json(
            { ok: false, error: "LOOP_SYNC_SERVICE_URL is not set" },
            { status: 500 },
          );
        }
        const { searchParams } = new URL(request.url);
        const market = searchParams.get("market");
        const target = market === "UK" || market === "US" ? market : undefined;
        const startedAt = new Date().toISOString();
        try {
          const remote = await triggerRemoteLoopSync(target);
          return Response.json({
            ok: remote.ok,
            remote: true,
            startedAt,
            status: remote.status,
            body: remote.body,
            url: remote.url,
            market: remote.market,
          }, { status: remote.ok ? 202 : 502 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, error: msg }, { status: 500 });
        }
      },
    },
  },
});
