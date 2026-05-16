import { createFileRoute } from "@tanstack/react-router";
import {
  fetchShopifyMarkets,
  fetchTripleWhale,
  fetchJuoForRange,
  fetchLoopForRange,
} from "@/server/fetchers.server";
import { runAllInBackground } from "@/server/sync.server";
import { verifyAllowedUser } from "@/server/user-auth.server";

// POST /api/sync
//   Fires the full sync in the background and returns immediately (~50ms).
//   The dashboard reads from data_cache and shows stale data while the
//   background sync repopulates it. Add ?wait=1 to wait for completion
//   (only useful for debugging).
//
// POST /api/sync?from=YYYY-MM-DD&to=YYYY-MM-DD
//   Custom date range — fetches Shopify + Triple Whale for the period only,
//   returns the data inline without touching the cache.
export const Route = createFileRoute("/api/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await verifyAllowedUser(request);
        if (denied) return denied;
        const { searchParams } = new URL(request.url);
        const fromDate = searchParams.get("from") ?? undefined;
        const toDate = searchParams.get("to") ?? undefined;
        const isCustomRange = !!(fromDate && toDate);

        if (isCustomRange) {
          const [shopifyMarkets, tripleWhale, juo, loop] = await Promise.allSettled([
            fetchShopifyMarkets(fromDate, toDate),
            fetchTripleWhale(fromDate, toDate),
            fetchJuoForRange(fromDate!, toDate!),
            fetchLoopForRange(fromDate!, toDate!),
          ]);
          return Response.json({
            ok: true,
            from: fromDate,
            to: toDate,
            rangeData: {
              shopifyMarkets:
                shopifyMarkets.status === "fulfilled" ? shopifyMarkets.value : null,
              tripleWhale:
                tripleWhale.status === "fulfilled" ? tripleWhale.value : null,
              juo: juo.status === "fulfilled" ? juo.value : null,
              loop: loop.status === "fulfilled" ? loop.value : null,
            },
          });
        }

        // Fire-and-forget — runAllInBackground returns void synchronously.
        runAllInBackground();
        return Response.json({
          ok: true,
          started: true,
          message:
            "Sync started in background. Refresh the dashboard in a moment to see new data.",
          startedAt: new Date().toISOString(),
        });
      },
    },
  },
});
