import { createMiddleware, createStart } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";

// Client middleware: attach the current Supabase access token as a Bearer
// header to every server function call so that requireSupabaseAuth (server
// side) can validate the user.
const attachAuthHeader = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    let token: string | undefined;
    if (typeof window !== "undefined") {
      try {
        const { data } = await supabase.auth.getSession();
        token = data.session?.access_token;
      } catch {
        token = undefined;
      }
    }
    if (token) {
      return next({ headers: { Authorization: `Bearer ${token}` } });
    }
    return next();
  },
);

export const startInstance = createStart(() => ({
  functionMiddleware: [attachAuthHeader],
}));
