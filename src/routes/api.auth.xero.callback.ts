import { createFileRoute } from "@tanstack/react-router";
import { createClient as createSupabaseJS } from "@supabase/supabase-js";
import { resolveSupabaseServiceKey, resolveSupabaseUrl } from "@/server/supabase-env.server";

const FALLBACK_SUPABASE_URL = "https://coktedrgtpecruympsvv.supabase.co";

function serviceClient() {
  const url = resolveSupabaseUrl(FALLBACK_SUPABASE_URL);
  const key = resolveSupabaseServiceKey();
  if (!url || !key) {
    throw new Error(
      `Supabase creds missing (url=${!!url}, key=${!!key})`,
    );
  }
  return createSupabaseJS(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const Route = createFileRoute("/api/auth/xero/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const stateParam = url.searchParams.get("state");

        const appUrl =
          process.env.NEXT_PUBLIC_APP_URL ??
          process.env.APP_URL ??
          url.origin;
        const redirectUri = `${appUrl}/api/auth/xero/callback`;

        // CSRF: validate state against signed cookie
        const cookieHeader = request.headers.get("cookie") ?? "";
        const stateCookie = cookieHeader
          .split(";")
          .map((c) => c.trim())
          .find((c) => c.startsWith("xero_state="))
          ?.slice("xero_state=".length);

        const clearStateCookie =
          "xero_state=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax";

        if (!stateParam || !stateCookie || stateParam !== stateCookie) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${appUrl}/?xero_error=invalid_state`,
              "Set-Cookie": clearStateCookie,
            },
          });
        }

        if (error) {
          console.error("Xero OAuth error:", error);
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${appUrl}/?xero_error=${encodeURIComponent(error)}`,
              "Set-Cookie": clearStateCookie,
            },
          });
        }
        if (!code) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${appUrl}/?xero_error=no_code`,
              "Set-Cookie": clearStateCookie,
            },
          });
        }

        const clientId = process.env.XERO_CLIENT_ID;
        const clientSecret = process.env.XERO_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return Response.json(
            { error: "Xero credentials not set" },
            { status: 500 },
          );
        }

        try {
          // Use btoa instead of Buffer for Worker runtime compatibility
          const basicAuth =
            typeof Buffer !== "undefined"
              ? Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
              : btoa(`${clientId}:${clientSecret}`);

          console.log("[Xero callback] exchanging code for token, redirect_uri:", redirectUri);

          const tokenRes = await fetch(
            "https://identity.xero.com/connect/token",
            {
              method: "POST",
              headers: {
                Authorization: `Basic ${basicAuth}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: redirectUri,
              }).toString(),
              cache: "no-store",
            },
          );

          if (!tokenRes.ok) {
            const body = await tokenRes.text();
            console.error("[Xero callback] token exchange failed:", tokenRes.status, body);
            return Response.redirect(
              `${appUrl}/?xero_error=token_exchange_failed&detail=${encodeURIComponent(body.slice(0, 200))}`,
              302,
            );
          }

          const tokenJson = await tokenRes.json();
          const { access_token, refresh_token, expires_in } = tokenJson;
          console.log("[Xero callback] token received, expires_in:", expires_in);

          const connRes = await fetch("https://api.xero.com/connections", {
            headers: {
              Authorization: `Bearer ${access_token}`,
              Accept: "application/json",
            },
            cache: "no-store",
          });
          const connections = connRes.ok ? await connRes.json() : [];
          console.log("[Xero callback] connections count:", Array.isArray(connections) ? connections.length : 0);

          const zapplyOrg =
            (connections as any[]).find((c) =>
              (c.tenantName ?? "").toLowerCase().includes("zapply"),
            ) ??
            (connections as any[])[0] ??
            null;

          const tenantId = zapplyOrg?.tenantId ?? null;
          const tenantName = zapplyOrg?.tenantName ?? "Unknown";

          const expiresAt = new Date(
            Date.now() + ((expires_in ?? 1800) - 60) * 1000,
          ).toISOString();

          const sb = serviceClient();
          const { data: existingTokenRow } = await (sb as any)
            .from("integrations")
            .select("refresh_token, metadata")
            .eq("provider", "xero")
            .maybeSingle();
          const finalRefreshToken =
            refresh_token ?? existingTokenRow?.refresh_token ?? existingTokenRow?.metadata?.refresh_token ?? null;
          const { error: upsertError } = await (sb as any).from("integrations").upsert(
            {
              provider: "xero",
              access_token,
              refresh_token: finalRefreshToken,
              expires_at: expiresAt,
              updated_at: new Date().toISOString(),
              metadata: {
                ...(existingTokenRow?.metadata ?? {}),
                refresh_token: finalRefreshToken,
                tenant_id: tenantId,
                tenant_name: tenantName,
                source: "oauth2_authorization_code",
                connections: (connections as any[]).map((c) => ({
                  id: c.tenantId,
                  name: c.tenantName,
                })),
              },
            },
            { onConflict: "provider" },
          );

          if (upsertError) {
            console.error("[Xero callback] DB upsert error:", upsertError);
            return Response.redirect(
              `${appUrl}/?xero_error=db_upsert_failed&detail=${encodeURIComponent(upsertError.message)}`,
              302,
            );
          }

          // Invalidate stale empty cache so next dashboard load fetches live
          try {
            await (sb as any).from("data_cache").delete().eq("provider", "xero").eq("cache_key", "accounting");
          } catch (e) {
            console.warn("[Xero callback] cache invalidate skipped:", e);
          }

          console.log(`[Xero callback] connected: ${tenantName} (${tenantId})`);
          return Response.redirect(`${appUrl}/?xero_connected=1`, 302);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : "";
          console.error("[Xero callback] unhandled error:", msg, stack);
          return Response.redirect(
            `${appUrl}/?xero_error=callback_error&detail=${encodeURIComponent(msg.slice(0, 200))}`,
            302,
          );
        }
      },
    },
  },
});
