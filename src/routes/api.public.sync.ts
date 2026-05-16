import { createFileRoute } from "@tanstack/react-router";
import { runAll, runAllInBackground } from "@/server/sync.server";
import { verifySyncSecret } from "@/server/sync-auth.server";

// POST /api/public/sync
//   Public-prefixed sync trigger. Bypasses auth on published deployments
//   so the dashboard's Sync button (and external schedulers like the
//   Supabase scheduled-sync Edge Function + pg_cron) can call it.
//
//   By default we AWAIT the full sync — Cloudflare Workers terminate
//   background promises after the response is sent, so fire-and-forget
//   silently drops the work. Pass ?async=1 if you want immediate return
//   and don't care about completion (e.g. user-facing button).
export const Route = createFileRoute("/api/public/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = verifySyncSecret(request);
        if (denied) return denied;
        const { searchParams } = new URL(request.url);
        const isAsync = searchParams.get("async") === "1";
        const startedAt = new Date().toISOString();

        if (isAsync) {
          runAllInBackground();
          return Response.json({
            ok: true,
            started: true,
            mode: "async",
            message: "Sync started in background.",
            startedAt,
          });
        }

        const results = await runAll();
        return Response.json({
          ok: true,
          completed: true,
          mode: "sync",
          startedAt,
          finishedAt: new Date().toISOString(),
          results,
        });
      },
      GET: async ({ request }) => {
        const denied = verifySyncSecret(request);
        if (denied) return denied;
        const { searchParams } = new URL(request.url);
        const isSync = searchParams.get("async") === "0" || searchParams.get("wait") === "1";
        const startedAt = new Date().toISOString();

        if (isSync) {
          const results = await runAll();
          return Response.json({
            ok: true,
            completed: true,
            mode: "sync",
            startedAt,
            finishedAt: new Date().toISOString(),
            results,
          });
        }

        runAllInBackground();
        return Response.json({
          ok: true,
          started: true,
          mode: "async",
          message: "Sync started in background. Add ?wait=1 to wait for completion.",
          startedAt,
        });
      },
    },
  },
});

