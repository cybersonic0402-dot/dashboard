// Verifies that an incoming HTTP request carries a valid Supabase session
// bearer token from a user with an allowed email domain. Used to protect
// /api/sync (called by the in-app dashboard "Sync" button).
//
// Preview/dev hosts bypass auth so the in-editor preview keeps working.
import { createClient } from "@supabase/supabase-js";
import { resolveSupabasePublishableKey, resolveSupabaseUrl } from "./supabase-env.server";

const ALLOWED_DOMAINS = ["zapply.nl", "codestrokes.com"];

function isPreviewHost(host: string): boolean {
  return (
    host.includes("id-preview--") ||
    host.includes("lovableproject.com") ||
    host.includes("lovable.dev") ||
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1")
  );
}

export async function verifyAllowedUser(
  request: Request,
  opts: { requireAdmin?: boolean } = {},
): Promise<Response | null> {
  const host = request.headers.get("host") ?? "";
  const origin = request.headers.get("origin") ?? "";
  if (isPreviewHost(host) || isPreviewHost(origin)) return null;

  const url = resolveSupabaseUrl();
  const key = resolveSupabasePublishableKey();
  if (!url || !key) {
    return new Response("Server misconfigured", { status: 500 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }
  const token = auth.slice("Bearer ".length);
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims) {
    return new Response("Unauthorized", { status: 401 });
  }
  const email = String((data.claims as any).email ?? "").toLowerCase();
  const userId = String((data.claims as any).sub ?? "");
  const ok =
    email && ALLOWED_DOMAINS.some((d) => email.endsWith(`@${d}`));
  if (!ok) return new Response("Forbidden", { status: 403 });
  if (opts.requireAdmin) {
    const { data: isAdmin, error: roleError } = await (supabase as any).rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (roleError || !isAdmin) return new Response("Admin access required", { status: 403 });
  }
  return null;
}
