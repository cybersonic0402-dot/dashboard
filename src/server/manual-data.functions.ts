import { createServerFn } from "@tanstack/react-start";
import { requireAllowedUser } from "./auth.middleware";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// ───────── Cash positions ─────────
export const listCashPositions = createServerFn({ method: "GET" }).middleware([requireAllowedUser]).handler(async () => {
  const { data, error } = await supabaseAdmin
    .from("cash_positions")
    .select("*")
    .order("account_name", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
});

const cashSchema = z.object({
  id: z.string().uuid().optional(),
  account_name: z.string().min(1).max(120),
  account_type: z.string().min(1).max(40),
  currency: z.string().min(3).max(3),
  balance_eur: z.number(),
  notes: z.string().max(500).nullable().optional(),
});

export const upsertCashPosition = createServerFn({ method: "POST" }).middleware([requireAllowedUser])
  .inputValidator((d: unknown) => cashSchema.parse(d))
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin.from("cash_positions").upsert(data);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteCashPosition = createServerFn({ method: "POST" }).middleware([requireAllowedUser])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin.from("cash_positions").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ───────── Inventory positions ─────────
export const listInventoryPositions = createServerFn({ method: "GET" }).middleware([requireAllowedUser]).handler(async () => {
  const { data, error } = await supabaseAdmin
    .from("inventory_positions")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
});

const invSchema = z.object({
  id: z.string().uuid().optional(),
  sku: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  location: z.string().min(1).max(20),
  pieces: z.number(),
  unit_cost_eur: z.number(),
  notes: z.string().max(500).nullable().optional(),
});

export const upsertInventoryPosition = createServerFn({ method: "POST" }).middleware([requireAllowedUser])
  .inputValidator((d: unknown) => invSchema.parse(d))
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin.from("inventory_positions").upsert(data);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteInventoryPosition = createServerFn({ method: "POST" }).middleware([requireAllowedUser])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin.from("inventory_positions").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

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
export const getManualDataSnapshot = createServerFn({ method: "GET" }).middleware([requireAllowedUser]).handler(async () => {
  const [cash, inv, settings] = await Promise.all([
    supabaseAdmin.from("cash_positions").select("*"),
    supabaseAdmin.from("inventory_positions").select("*"),
    supabaseAdmin.from("app_settings").select("*"),
  ]);
  const settingsMap: Record<string, any> = {};
  for (const r of settings.data ?? []) settingsMap[r.key] = r.value;
  return {
    cashPositions: cash.data ?? [],
    inventoryPositions: inv.data ?? [],
    settings: settingsMap,
  };
});
