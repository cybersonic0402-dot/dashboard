import { createFileRoute } from "@tanstack/react-router";
import { fetchJortt } from "@/server/fetchers.server";
import { writeCache } from "@/server/cache.server";
import { verifySyncSecret } from "@/server/sync-auth.server";

// On-demand Jortt fetch — also writes to cache so the dashboard reflects it next load.
export const Route = createFileRoute("/api/jortt")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = verifySyncSecret(request);
        if (denied) return denied;
        try {
          const data = await fetchJortt();
          if (!data) {
            return Response.json(
              { error: "Jortt fetch returned no data" },
              { status: 503 },
            );
          }
          await writeCache("jortt", "invoices", data);
          return Response.json({ ...data, source: "jortt_live" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json(
            { error: "Jortt API error", detail: msg },
            { status: 500 },
          );
        }
      },
    },
  },
});
