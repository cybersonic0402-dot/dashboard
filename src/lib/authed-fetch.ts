import { supabase } from "@/integrations/supabase/client";

// Fetch wrapper that automatically attaches the current Supabase session
// access token as a Bearer header. Use this for any same-origin /api/* call
// that should be limited to authenticated users.
export async function authedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  let token: string | undefined;
  try {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token;
  } catch {
    token = undefined;
  }
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
