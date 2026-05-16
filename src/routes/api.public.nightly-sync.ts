import { createFileRoute } from "@tanstack/react-router";
import { syncAllShopifyOrders, snapshotSubscriptions } from "@/server/order-sync.server";
import { runAll } from "@/server/sync.server";
import { syncAllLoop } from "@/server/loop-sync.server";

// POST /api/public/nightly-sync
//   Public endpoint called by pg_cron every night. Does three things:
//     1. Pulls all NEW / updated Shopify orders into `shopify_orders`
//        (paginates by updated_at; first run backfills history).
//     2. Snapshots Loop + Juo subscription state into
//        `subscription_snapshots` so we keep a daily history.
//     3. Refreshes the rolled-up `data_cache` rows the dashboards read
//        from (Shopify markets, monthly, repeat funnel, Triple Whale, …).
//
//   Returns a short JSON summary so we can eyeball the cron history.
export const Route = createFileRoute("/api/public/nightly-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const startedAt = new Date().toISOString();
        const { searchParams } = new URL(request.url);
        const pages = Number(searchParams.get("pages") ?? "1");
        const orders = await syncAllShopifyOrders(pages);
        const hasMore = orders.some((store) => store.hasMore);
        const subs = hasMore ? [] : await snapshotSubscriptions();
        const loop = hasMore ? [] : await syncAllLoop().catch((e) => {
          console.error("[nightly-sync] syncAllLoop:", e);
          return [{ error: e instanceof Error ? e.message : String(e) }];
        });
        // Refresh expensive dashboard caches only after the order backfill is caught up.
        if (!hasMore) runAll().catch((e) => console.error("[nightly-sync] runAll:", e));
        return Response.json({
          ok: true,
          startedAt,
          finishedAt: new Date().toISOString(),
          orders,
          subscriptions: subs,
          loop,
          message: hasMore
            ? "Stored this chunk. Run the endpoint again until hasMore is false for every store."
            : "Order sync is caught up; subscription snapshots and dashboard cache refresh started.",
        });
      },
      GET: async ({ request }) => {
        // Allow GET for easy manual smoke-test from a browser.
        return Response.json({
          hint: "POST to this URL to trigger the nightly sync.",
          url: new URL(request.url).toString(),
        });
      },
    },
  },
});
