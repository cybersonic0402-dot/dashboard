import { createServerFn } from "@tanstack/react-start";
import { requireAllowedUser } from "./auth.middleware";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Manual cash_positions / inventory_positions were retired — the dashboard
// now sources cash from Xero + bank platforms and inventory from Picqer. The
// /admin/manual-data page that fed those tables was removed in the same
// change. Only app_settings remains here (min_cash_buffer_eur, market_costs)
// because nothing else owns user-editable configuration yet.

// ───────── App settings ─────────
export const getAppSettings = createServerFn({ method: "GET" }).middleware([requireAllowedUser]).handler(async () => {
  const { data, error } = await supabaseAdmin.from("app_settings").select("*");
  if (error) throw new Error(error.message);
  const map: Record<string, any> = {};
  for (const r of data ?? []) map[r.key] = r.value;
  return map;
});

export const setAppSetting = createServerFn({ method: "POST" }).middleware([requireAllowedUser])
  .inputValidator((d: unknown) =>
    z.object({ key: z.string().min(1).max(80), value: z.any() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert({ key: data.key, value: data.value });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ───────── Combined snapshot for dashboards ─────────
// Returns only app_settings now. Existing consumers read `settings.*` from
// this; the empty cashPositions / inventoryPositions arrays keep older
// destructuring sites safe until they're cleaned up.
export const getManualDataSnapshot = createServerFn({ method: "GET" }).middleware([requireAllowedUser]).handler(async () => {
  const { data: settings } = await supabaseAdmin.from("app_settings").select("*");
  const settingsMap: Record<string, any> = {};
  for (const r of settings ?? []) settingsMap[r.key] = r.value;
  return {
    cashPositions: [] as any[],
    inventoryPositions: [] as any[],
    settings: settingsMap,
  };
});
