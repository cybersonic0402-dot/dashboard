import { createFileRoute } from "@tanstack/react-router";

// Jortt uses client_credentials — no user-facing OAuth flow needed.
// This endpoint validates the server-side credentials by requesting a token,
// then redirects back to the Sync view with success or error info.
export const Route = createFileRoute("/api/jortt/connect")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        const clientId = process.env.JORTT_CLIENT_ID;
        const clientSecret = process.env.JORTT_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
          return Response.redirect(
            `${origin}/?view=sync&error=jortt_missing_credentials`,
            302,
          );
        }

        try {
          const body = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
          });

          const tokenRes = await fetch(
            "https://app.jortt.nl/oauth-provider/oauth/token",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
              },
              body,
            },
          );

          const text = await tokenRes.text();
          if (!tokenRes.ok) {
            console.error("[jortt connect] token error", tokenRes.status, text);
            const msg = encodeURIComponent(
              `jortt_token_${tokenRes.status}:${text.slice(0, 200)}`,
            );
            return Response.redirect(
              `${origin}/?view=sync&error=${msg}`,
              302,
            );
          }

          // Success — credentials are valid.
          return Response.redirect(
            `${origin}/?view=sync&connected=jortt`,
            302,
          );
        } catch (err) {
          console.error("[jortt connect] exception", err);
          const msg = encodeURIComponent(
            `jortt_exception:${(err as Error).message}`,
          );
          return Response.redirect(
            `${origin}/?view=sync&error=${msg}`,
            302,
          );
        }
      },
    },
  },
});
