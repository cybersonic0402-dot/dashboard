// Verifies that requests to public sync endpoints carry a valid shared secret
// in the X-Sync-Token header. Without it the endpoint refuses the request.
// The secret is set via the SYNC_SECRET env var (configure in Lovable Cloud
// secrets and on any external scheduler that calls these endpoints).
export function verifySyncSecret(request: Request): Response | null {
  const expected = process.env.SYNC_SECRET;
  if (!expected) {
    // Fail closed if the secret hasn't been configured.
    return new Response(
      JSON.stringify({ error: "SYNC_SECRET not configured on server" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
  const provided =
    request.headers.get("x-sync-token") ??
    request.headers.get("X-Sync-Token") ??
    "";
  // Constant-time compare
  if (provided.length !== expected.length) {
    return new Response("Unauthorized", { status: 401 });
  }
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) return new Response("Unauthorized", { status: 401 });
  return null;
}
