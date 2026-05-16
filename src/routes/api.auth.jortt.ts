import { createFileRoute } from "@tanstack/react-router";

// Jortt credentials in this app are for client_credentials, not browser OAuth.
// Keep this legacy URL safe by sending users back to the in-app connection flow.

export const Route = createFileRoute("/api/auth/jortt")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;

        return Response.redirect(`${origin}/api/jortt/connect`, 302);
      },
    },
  },
});
