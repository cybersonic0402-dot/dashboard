import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/jortt/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { searchParams, origin } = new URL(request.url);
        const code = searchParams.get("code");
        const error = searchParams.get("error");
        if (error || !code) {
          return Response.redirect(`${origin}/?view=sync&error=jortt_denied`, 302);
        }

        try {
          const tokenRes = await fetch("https://app.jortt.nl/oauth-provider/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              client_id: process.env.JORTT_CLIENT_ID ?? "",
              client_secret: process.env.JORTT_CLIENT_SECRET ?? "",
              redirect_uri: `${origin}/api/jortt/callback`,
            }),
          });

          if (!tokenRes.ok) {
            return Response.redirect(`${origin}/?view=sync&error=jortt_token`, 302);
          }

          const token = await tokenRes.json();
          const expiresAt = token.expires_in
            ? new Date(Date.now() + token.expires_in * 1000).toISOString()
            : null;

          await supabaseAdmin.from("integrations").upsert(
            {
              provider: "jortt",
              access_token: token.access_token,
              refresh_token: token.refresh_token ?? null,
              expires_at: expiresAt,
              metadata: {},
              updated_at: new Date().toISOString(),
            },
            { onConflict: "provider" },
          );

          return Response.redirect(`${origin}/?view=sync&connected=jortt`, 302);
        } catch (err) {
          console.error("Jortt callback error:", err);
          return Response.redirect(`${origin}/?view=sync&error=jortt_callback`, 302);
        }
      },
    },
  },
});
