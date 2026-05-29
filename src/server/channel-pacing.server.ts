/**
 * Channel pacing — per (market, channel, month).
 *
 * Compares month-to-date actual spend and ROAS (from Triple Whale) against
 * monthly targets stored in `channel_targets`. Computes the run-rate that
 * would land the month on target, the % deviation, and traffic-light flags
 * (±10% yellow, ±15% red — matches the spec in the Finance Forecasting
 * Dashboard scope doc).
 *
 * Channels covered in V1: meta, google, tiktok. Each maps to a specific
 * spend + ROAS field on the Triple Whale row.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchTripleWhale } from "./fetchers.server";

// 5-minute in-memory cache for the month-to-date TW range fetch. Same TTL as
// the dashboard's rangeCache. Pacing reloads (Refresh button, month switch)
// hit cache after the first fetch instead of re-paying the 30–60s round trip.
const TW_CACHE_TTL_MS = 5 * 60 * 1000;
const twCache = new Map<string, { rows: any[]; fetchedAt: number }>();
const twInflight = new Map<string, Promise<any[]>>();

// Hard outer timeout for the whole TW fetch. `fetchTripleWhale` has 60s
// per-store timeouts internally, but does shipping/refunds enrichment and FX
// lookups after the main call — without an outer cap the request can hang
// indefinitely if any of those stalls. 90s is generous enough for cold paths.
const TW_OUTER_TIMEOUT_MS = 90_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function fetchTripleWhaleCached(
  from: string,
  to: string,
): Promise<{ rows: any[]; cached: boolean; error: string | null }> {
  const key = `${from}|${to}`;
  const now = Date.now();
  const hit = twCache.get(key);
  if (hit && now - hit.fetchedAt < TW_CACHE_TTL_MS) {
    return { rows: hit.rows, cached: true, error: null };
  }
  const pending = twInflight.get(key);
  if (pending) {
    try {
      const rows = await pending;
      return { rows, cached: true, error: null };
    } catch (err: any) {
      return { rows: [], cached: false, error: err?.message ?? "fetch failed" };
    }
  }
  const task = (async () => {
    const rows = (await withTimeout(
      fetchTripleWhale(from, to),
      TW_OUTER_TIMEOUT_MS,
      "Triple Whale (pacing)",
    )) as any[] | null;
    return Array.isArray(rows) ? rows : [];
  })();
  twInflight.set(key, task);
  try {
    const rows = await task;
    twCache.set(key, { rows, fetchedAt: Date.now() });
    return { rows, cached: false, error: null };
  } catch (err: any) {
    return { rows: [], cached: false, error: err?.message ?? "fetch failed" };
  } finally {
    twInflight.delete(key);
  }
}

export const PACING_CHANNELS = ["meta", "google", "tiktok"] as const;
export type Channel = (typeof PACING_CHANNELS)[number];

export const PACING_MARKETS = ["NL", "UK", "US"] as const;
export type Market = (typeof PACING_MARKETS)[number];

export type ChannelTargetRow = {
  id: string;
  market: Market;
  channel: Channel;
  month: string; // YYYY-MM-DD (first day of month)
  spend_target: number;
  roas_target: number;
  notes: string | null;
  updated_at: string;
};

export type PacingFlag = "green" | "yellow" | "red";

export type PacingRow = {
  market: Market;
  channel: Channel;
  monthStart: string; // YYYY-MM-01
  daysInMonth: number;
  daysElapsed: number;
  spendTarget: number | null;
  roasTarget: number | null;
  spendActual: number; // MTD, EUR
  roasActual: number | null;
  expectedSpendToDate: number | null;
  spendPacingPct: number | null;
  roasPacingPct: number | null;
  projectedMonthEndSpend: number | null;
  spendFlag: PacingFlag | null;
  roasFlag: PacingFlag | null;
  notes: string | null;
  targetId: string | null;
};

const SPEND_FIELD: Record<Channel, string> = {
  meta: "facebookSpend",
  google: "googleSpend",
  tiktok: "tiktokSpend",
};

const ROAS_FIELD: Record<Channel, string> = {
  meta: "fbRoas",
  google: "googleRoas",
  tiktok: "tiktokRoas",
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function startOfMonth(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
}

function todayIso(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function daysInMonth(monthIso: string) {
  const [y, m] = monthIso.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

function flagFor(pct: number | null, mode: "spend" | "roas"): PacingFlag | null {
  if (pct == null || !isFinite(pct)) return null;
  // Spend: a value over 100 means we're spending FASTER than planned (over-pacing).
  //        Both directions are tracked symmetrically against ±10%/±15% thresholds.
  // ROAS:  a value over 100 means we're BEATING the ROAS target. Falling below
  //        target is the bad case — the thresholds are interpreted symmetrically
  //        and the UI labels the direction.
  const deviation = Math.abs(pct - 100);
  if (deviation < 10) return "green";
  if (deviation < 15) return "yellow";
  return "red";
}

export async function readChannelTargets(
  monthIso: string,
): Promise<ChannelTargetRow[]> {
  const { data, error } = await (supabaseAdmin as any)
    .from("channel_targets")
    .select("id, market, channel, month, spend_target, roas_target, notes, updated_at")
    .eq("month", monthIso);
  if (error) {
    console.warn("[pacing] read targets:", error.message);
    return [];
  }
  return (data ?? []) as ChannelTargetRow[];
}

export async function upsertChannelTarget(input: {
  market: Market;
  channel: Channel;
  month: string;
  spend_target: number;
  roas_target: number;
  notes?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const { error } = await (supabaseAdmin as any)
    .from("channel_targets")
    .upsert(
      {
        market: input.market,
        channel: input.channel,
        month: input.month,
        spend_target: input.spend_target,
        roas_target: input.roas_target,
        notes: input.notes ?? null,
      },
      { onConflict: "market,channel,month" },
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deleteChannelTarget(id: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await (supabaseAdmin as any)
    .from("channel_targets")
    .delete()
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Build the pacing grid for a given month. Pulls MTD ad data from Triple Whale
 * (one aggregated call covering the month-to-date range) and joins it against
 * the stored monthly targets.
 *
 * `today` lets callers override the "as-of" date for testing; defaults to
 * the actual current date.
 */
export async function getChannelPacing(opts?: {
  monthStart?: string;
  today?: string;
}): Promise<{
  monthStart: string;
  today: string;
  rows: PacingRow[];
  fetchedAt: string;
  liveData: boolean;
  warning: string | null;
}> {
  const now = new Date();
  const monthStart = opts?.monthStart ?? startOfMonth(now);
  const today = opts?.today ?? todayIso(now);
  const dim = daysInMonth(monthStart);
  // daysElapsed: number of days from monthStart through `today` inclusive,
  // clamped into [1, dim]. Clamping prevents a future-dated "today" from
  // producing nonsensical >100% expected-to-date numbers.
  const startD = new Date(`${monthStart}T00:00:00Z`);
  const todayD = new Date(`${today}T00:00:00Z`);
  const dayDiff = Math.floor(
    (todayD.getTime() - startD.getTime()) / 86_400_000,
  );
  const daysElapsed = Math.max(1, Math.min(dim, dayDiff + 1));

  // Targets and live TW data run in parallel. TW is hard-capped via
  // fetchTripleWhaleCached so the page never hangs; on timeout/failure we
  // still return rows (with empty actuals) so targets and flags are visible.
  const [targets, twResult] = await Promise.all([
    readChannelTargets(monthStart),
    fetchTripleWhaleCached(monthStart, today),
  ]);

  if (twResult.error) {
    console.warn("[pacing] TW fetch failed:", twResult.error);
  }

  const targetByKey = new Map<string, ChannelTargetRow>();
  for (const t of targets) {
    targetByKey.set(`${t.market}|${t.channel}`, t);
  }

  const twByMarket = new Map<string, any>();
  for (const r of twResult.rows ?? []) {
    if (r?.market) twByMarket.set(r.market, r);
  }
  const liveData = twByMarket.size > 0;

  const rows: PacingRow[] = [];
  for (const market of PACING_MARKETS) {
    for (const channel of PACING_CHANNELS) {
      const tw = twByMarket.get(market) ?? null;
      const spendActualRaw = tw ? (tw[SPEND_FIELD[channel]] as number | null) : null;
      const roasActualRaw = tw ? (tw[ROAS_FIELD[channel]] as number | null) : null;
      const spendActual =
        typeof spendActualRaw === "number" && isFinite(spendActualRaw)
          ? +spendActualRaw.toFixed(2)
          : 0;
      const roasActual =
        typeof roasActualRaw === "number" && isFinite(roasActualRaw)
          ? +roasActualRaw.toFixed(3)
          : null;

      const target = targetByKey.get(`${market}|${channel}`) ?? null;
      const spendTarget = target ? Number(target.spend_target) : null;
      const roasTarget = target ? Number(target.roas_target) : null;

      const expectedToDate =
        spendTarget != null ? +(spendTarget * (daysElapsed / dim)).toFixed(2) : null;
      const spendPacingPct =
        expectedToDate != null && expectedToDate > 0
          ? +((spendActual / expectedToDate) * 100).toFixed(1)
          : null;
      const projectedMonthEnd =
        +((spendActual / daysElapsed) * dim).toFixed(2);
      const roasPacingPct =
        roasTarget != null && roasTarget > 0 && roasActual != null
          ? +((roasActual / roasTarget) * 100).toFixed(1)
          : null;

      rows.push({
        market,
        channel,
        monthStart,
        daysInMonth: dim,
        daysElapsed,
        spendTarget,
        roasTarget,
        spendActual,
        roasActual,
        expectedSpendToDate: expectedToDate,
        spendPacingPct,
        roasPacingPct,
        projectedMonthEndSpend: projectedMonthEnd,
        spendFlag: flagFor(spendPacingPct, "spend"),
        roasFlag: flagFor(roasPacingPct, "roas"),
        notes: target?.notes ?? null,
        targetId: target?.id ?? null,
      });
    }
  }

  return {
    monthStart,
    today,
    rows,
    fetchedAt: new Date().toISOString(),
    liveData,
    warning: twResult.error
      ? `Triple Whale unreachable (${twResult.error}). Showing targets only.`
      : liveData
        ? null
        : "Triple Whale returned no data for this period.",
  };
}
