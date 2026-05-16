import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// POST /auth/logout — signs the current user out (no-op server side; the actual
// session is in the browser's localStorage. We simply redirect to /login.)
export const Route = createFileRoute("/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Best-effort: invalidate via admin if we have a bearer header.
        const auth = request.headers.get("authorization");
        if (auth?.toLowerCase().startsWith("bearer ")) {
          const token = auth.slice(7);
          try {
            await supabaseAdmin.auth.admin.signOut(token);
          } catch {
            // ignored
          }
        }
        const origin = new URL(request.url).origin;
        return Response.redirect(`${origin}/login`, 302);
      },
    },
  },
});
