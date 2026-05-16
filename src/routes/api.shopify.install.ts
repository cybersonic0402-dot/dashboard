import { createFileRoute } from "@tanstack/react-router";

// Shopify OAuth install — redirects user to Shopify's OAuth authorize page.
// Uses HTTP-only cookie to store CSRF state. The session check is done at the
// callback step against the integrations table (admin client).
export const Route = createFileRoute("/api/shopify/install")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { searchParams, origin } = new URL(request.url);
        const shop = searchParams.get("shop");

        if (!shop || !shop.endsWith(".myshopify.com")) {
          return Response.redirect(
            `${origin}/?view=sync&error=shopify_invalid_shop`,
            302,
          );
        }

        const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
        if (!clientId) {
          return Response.redirect(
            `${origin}/?view=sync&error=shopify_not_configured`,
            302,
          );
        }

        const stateBytes = new Uint8Array(16);
        crypto.getRandomValues(stateBytes);
        const state = Array.from(stateBytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        const scopes =
          "read_orders,read_all_orders,read_customers,read_products,read_inventory,read_analytics";

        const params = new URLSearchParams({
          client_id: clientId,
          scope: scopes,
          redirect_uri: `${origin}/api/shopify/callback`,
          state,
        });

        const headers = new Headers({
          Location: `https://${shop}/admin/oauth/authorize?${params.toString()}`,
          "Set-Cookie": `shopify_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
        });
        return new Response(null, { status: 302, headers });
      },
    },
  },
});
