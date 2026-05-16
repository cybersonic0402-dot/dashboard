// Supabase Edge Function: scheduled-sync
//
// Triggered by pg_cron every 30 minutes. Calls the TanStack /api/sync
// endpoint which fetches Shopify, Triple Whale, Jortt, Juo, Loop, Xero
// in the background and writes fresh data to the shared `data_cache` table.
//
// All dashboard users read from the same `data_cache` rows, so when this
// finishes the next page render shows fresh data — no per-user caching,
// no client-side fetch waits.
//
// Manual trigger:
//   curl -X POST https://<project>.supabase.co/functions/v1/scheduled-sync \
//        -H "Authorization: Bearer <anon-key>"

const APP_URL =
  Deno.env.get("APP_SYNC_URL") ??
  "https://zapply.codestrokes.com/api/public/sync?async=1";

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  console.log(`[scheduled-sync] tick ${startedAt} -> ${APP_URL}`);

  const SYNC_SECRET = Deno.env.get("SYNC_SECRET") ?? "";
  if (!SYNC_SECRET) {
    console.error("[scheduled-sync] SYNC_SECRET env var not set — request will be rejected by /api/public/sync");
  }

  try {
    const res = await fetch(APP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sync-Token": SYNC_SECRET,
      },
      // Fire-and-return: the app endpoint kicks the sync in the background
      // and responds immediately. We don't need to wait for completion.
      body: JSON.stringify({ source: "supabase-cron", at: startedAt }),
    });

    const text = await res.text();
    console.log(`[scheduled-sync] app responded ${res.status}: ${text.slice(0, 200)}`);

    return new Response(
      JSON.stringify({
        ok: res.ok,
        status: res.status,
        startedAt,
        appResponse: text.slice(0, 500),
      }),
      {
        status: res.ok ? 200 : 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduled-sync] failed:`, msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg, startedAt }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
