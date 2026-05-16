import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/shopify/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { searchParams, origin } = new URL(request.url);
        const code = searchParams.get("code");
        const shop = searchParams.get("shop");
        const state = searchParams.get("state");

        const cookieHeader = request.headers.get("cookie") ?? "";
        const cookieMap = Object.fromEntries(
          cookieHeader.split(";").map((c) => {
            const [k, ...v] = c.trim().split("=");
            return [k, v.join("=")];
          }),
        );
        const storedState = cookieMap["shopify_oauth_state"];

        if (!code || !shop || !state || state !== storedState) {
          return Response.redirect(
            `${origin}/?view=sync&error=shopify_invalid_state`,
            302,
          );
        }

        try {
          const tokenRes = await fetch(
            `https://${shop}/admin/oauth/access_token`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                client_id: process.env.SHOPIFY_APP_CLIENT_ID,
                client_secret: process.env.SHOPIFY_APP_CLIENT_SECRET,
                code,
              }),
            },
          );

          if (!tokenRes.ok) {
            return Response.redirect(
              `${origin}/?view=sync&error=shopify_token`,
              302,
            );
          }

          const { access_token } = await tokenRes.json();

          const shopRes = await fetch(
            `https://${shop}/admin/api/2026-01/shop.json`,
            { headers: { "X-Shopify-Access-Token": access_token } },
          );
          const shopData: any = shopRes.ok ? await shopRes.json() : {};

          await supabaseAdmin.from("integrations").upsert(
            {
              provider: `shopify_${shop.replace(".myshopify.com", "")}`,
              access_token,
              refresh_token: null,
              expires_at: null,
              metadata: {
                shop_domain: shop,
                shop_name: shopData.shop?.name ?? shop,
                shop_currency: shopData.shop?.currency ?? "EUR",
                shop_country: shopData.shop?.country_code ?? null,
              },
              updated_at: new Date().toISOString(),
            },
            { onConflict: "provider" },
          );

          return new Response(null, {
            status: 302,
            headers: new Headers({
              Location: `${origin}/?view=sync&connected=shopify`,
              "Set-Cookie":
                "shopify_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
            }),
          });
        } catch (err) {
          console.error("Shopify callback error:", err);
          return Response.redirect(
            `${origin}/?view=sync&error=shopify_callback`,
            302,
          );
        }
      },
    },
  },
});
