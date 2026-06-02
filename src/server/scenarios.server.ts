/**
 * Forecast scenarios — saved named what-if forecasts.
 *
 * Stored in public.forecast_scenarios. Each scenario captures a name, an
 * optional description, the assumption set used (growth rate, churn,
 * subscriber rate, optional events), and a snapshot of the computed totals
 * at save time so we can render comparisons quickly.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const SCENARIOS_CACHE_TTL_MS = 60_000;
let scenariosCache: { value: ScenarioRow[]; fetchedAt: number } | null = null;
let scenariosInflight: Promise<ScenarioRow[]> | null = null;

export type ScenarioAssumptions = {
  monthlyGrowthRate?: number;
  churnRateOverride?: number | null;
  subscriberRateOverride?: number | null;
  horizonMonths?: number;
  startMonth?: string;
};

export type ScenarioEvent = {
  kind: "partner_launch" | "campaign_boost" | "other";
  date: string; // YYYY-MM-DD
  description?: string;
  // Free-form payload — interpretation depends on the kind.
  payload?: Record<string, unknown>;
};

export type ScenarioSnapshot = {
  // P50/P90 totals per market and aggregate, at save time.
  capturedAt: string;
  totalsByMarket: Record<
    string,
    {
      newCustomerRevenue: number;
      oneTimeRepeatRevenue: number;
      subscriberTailRevenue: number;
      totalP50: number;
      totalP90: number;
    }
  >;
  grand: {
    totalP50: number;
    totalP90: number;
  };
};

export type ScenarioRow = {
  id: string;
  name: string;
  description: string | null;
  assumptions: ScenarioAssumptions;
  events: ScenarioEvent[];
  snapshot: ScenarioSnapshot | null;
  created_at: string;
  updated_at: string;
};

function rowToScenario(r: any): ScenarioRow {
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    description: r.description ?? null,
    assumptions: (r.assumptions ?? {}) as ScenarioAssumptions,
    events: Array.isArray(r.events) ? (r.events as ScenarioEvent[]) : [],
    snapshot: (r.snapshot ?? null) as ScenarioSnapshot | null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export async function listScenarios(): Promise<ScenarioRow[]> {
  if (scenariosCache && Date.now() - scenariosCache.fetchedAt < SCENARIOS_CACHE_TTL_MS) {
    return scenariosCache.value;
  }
  if (scenariosInflight) return await scenariosInflight;

  const task = (async () => {
  const { data, error } = await (supabaseAdmin as any)
    .from("forecast_scenarios")
    .select("id, name, description, assumptions, events, snapshot, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) {
    console.warn("[scenarios] list:", error.message);
    return [];
  }
    return (data ?? []).map(rowToScenario);
  })();

  scenariosInflight = task;
  try {
    const rows = await task;
    scenariosCache = { value: rows, fetchedAt: Date.now() };
    return rows;
  } finally {
    scenariosInflight = null;
  }
}

export async function getScenario(id: string): Promise<ScenarioRow | null> {
  const { data, error } = await (supabaseAdmin as any)
    .from("forecast_scenarios")
    .select("id, name, description, assumptions, events, snapshot, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.warn("[scenarios] get:", error.message);
    return null;
  }
  return data ? rowToScenario(data) : null;
}

export async function getScenarioByName(name: string): Promise<ScenarioRow | null> {
  const { data, error } = await (supabaseAdmin as any)
    .from("forecast_scenarios")
    .select("id, name, description, assumptions, events, snapshot, created_at, updated_at")
    .eq("name", name)
    .maybeSingle();
  if (error) {
    console.warn("[scenarios] getByName:", error.message);
    return null;
  }
  return data ? rowToScenario(data) : null;
}

export async function upsertScenario(input: {
  name: string;
  description?: string | null;
  assumptions: ScenarioAssumptions;
  events?: ScenarioEvent[];
  snapshot?: ScenarioSnapshot | null;
}): Promise<{ ok: boolean; scenario?: ScenarioRow; error?: string }> {
  const payload = {
    name: input.name,
    description: input.description ?? null,
    assumptions: input.assumptions ?? {},
    events: input.events ?? [],
    snapshot: input.snapshot ?? null,
  };
  const { data, error } = await (supabaseAdmin as any)
    .from("forecast_scenarios")
    .upsert(payload, { onConflict: "name" })
    .select("id, name, description, assumptions, events, snapshot, created_at, updated_at")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  scenariosCache = null;
  return { ok: true, scenario: data ? rowToScenario(data) : undefined };
}

export async function deleteScenario(id: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await (supabaseAdmin as any)
    .from("forecast_scenarios")
    .delete()
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  scenariosCache = null;
  return { ok: true };
}
