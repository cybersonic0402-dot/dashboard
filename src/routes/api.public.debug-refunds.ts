import { createFileRoute } from "@tanstack/react-router";
import { fetchShopifyRefundsBreakdown } from "@/server/fetchers.server";

// GET /api/public/debug-refunds?from=YYYY-MM-DD&to=YYYY-MM-DD
// Runs the ShopifyQL Analytics query
//   FROM payments SHOW refunded_payments SINCE {from} UNTIL {to}
// against every Shopify store and returns the raw native amount, EUR-converted
// amount, currency, and any parse / HTTP errors per market.
export const Route = createFileRoute("/api/public/debug-refunds")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const today = new Date();
        const ymd = (d: Date) =>
          `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
        const from = url.searchParams.get("from") ?? ymd(firstOfMonth);
        const to = url.searchParams.get("to") ?? ymd(today);

        const breakdown = await fetchShopifyRefundsBreakdown(from, to);
        const totalEur = Object.values(breakdown).reduce(
          (s: number, r: any) => s + (typeof r?.refunds === "number" ? r.refunds : 0),
          0,
        );
        return Response.json(
          {
            from,
            to,
            totalRefundsEUR: +totalEur.toFixed(2),
            byMarket: breakdown,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
