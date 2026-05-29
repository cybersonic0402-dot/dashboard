import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import {
  getRevenueForecastFn,
  listScenariosFn,
  loadScenarioFn,
  deleteScenarioFn,
} from "@/server/dashboard.functions";

export const Route = createFileRoute("/pillars/revenue-forecast")({
  head: () => ({ meta: [{ title: "Revenue forecast — Zapply" }] }),
  component: RevenueForecastPage,
});

type Market = "NL" | "UK" | "US";
const MARKETS: Market[] = ["NL", "UK", "US"];
const MARKET_FLAG: Record<Market, string> = {
  NL: "🇳🇱",
  UK: "🇬🇧",
  US: "🇺🇸",
};

type ForecastMonthRow = {
  monthIso: string;
  monthLabel: string;
  newCustomerRevenue: number;
  oneTimeRepeatRevenue: number;
  subscriberTailRevenue: number;
  totalP50: number;
  totalP90: number;
  newCustomers: number;
};

type MarketForecast = {
  market: Market;
  currency: string;
  aov: number | null;
  baselineNewCustomersPerMonth: number | null;
  historicalGrowthRate: number | null;
  historicalMonthsUsed: number;
  seasonalIndex: Record<number, number> | null;
  monthlyChurnRate: number | null;
  subscriberRate: number | null;
  startingMrr: number | null;
  arpuPerSubscriber: number | null;
  ltvWindows: {
    day60: number | null;
    day90: number | null;
    day180: number | null;
    day365: number | null;
  };
  matureCustomers: {
    day60: number;
    day90: number;
    day180: number;
    day365: number;
  };
  monthlyIncrementalLTV: number[];
  confidenceFactor: number;
  months: ForecastMonthRow[];
  totals: {
    newCustomerRevenue: number;
    oneTimeRepeatRevenue: number;
    subscriberTailRevenue: number;
    totalP50: number;
    totalP90: number;
  };
  warnings: string[];
};

function fmtMoney(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(n);
}
function fmtMoneyK(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `€${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `€${(n / 1_000).toFixed(0)}K`;
  return `€${n.toFixed(0)}`;
}
function fmtPct(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}
function fmtNum(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-GB");
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function defaultStartMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
}

type ScenarioListItem = {
  id: string;
  name: string;
  description: string | null;
  assumptions: {
    monthlyGrowthRate?: number;
    churnRateOverride?: number | null;
    subscriberRateOverride?: number | null;
    horizonMonths?: number;
  };
  snapshot: {
    capturedAt: string;
    grand: { totalP50: number; totalP90: number };
  } | null;
  events: unknown[];
  updated_at: string;
};

function RevenueForecastPage() {
  const { user } = useDashboardSession();
  const [startMonth, setStartMonth] = useState<string>(defaultStartMonth());
  const [horizon, setHorizon] = useState<number>(12);
  const [growthPct, setGrowthPct] = useState<string>("0");
  const [churnPctOverride, setChurnPctOverride] = useState<string>("");
  const [subRateOverride, setSubRateOverride] = useState<string>("");
  const [scenarios, setScenarios] = useState<ScenarioListItem[]>([]);
  const [scenariosError, setScenariosError] = useState<string | null>(null);

  const [data, setData] = useState<{
    markets: MarketForecast[];
    twWarning: string | null;
    fetchedAt: string;
    diagnostics: Array<{ name: string; ok: boolean; cached: boolean; error: string | null }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<Market | "ALL">("ALL");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const growth = Number(growthPct);
      const churn = churnPctOverride === "" ? null : Number(churnPctOverride);
      const sub = subRateOverride === "" ? null : Number(subRateOverride);
      const res = (await getRevenueForecastFn({
        data: {
          startMonth,
          horizonMonths: horizon,
          monthlyGrowthRate: isFinite(growth) ? growth / 100 : 0,
          churnRateOverride:
            churn == null ? null : isFinite(churn) ? churn / 100 : null,
          subscriberRateOverride:
            sub == null ? null : isFinite(sub) ? sub / 100 : null,
        },
      })) as any;
      if (!res?.ok) {
        setError(res?.error ?? "Failed to compute forecast");
        setData(null);
        return;
      }
      setData({
        markets: res.markets as MarketForecast[],
        twWarning: res.twWarning ?? null,
        fetchedAt: res.fetchedAt,
        diagnostics: res.diagnostics ?? [],
      });
    } catch (err: any) {
      setError(err?.message ?? "Failed to compute forecast");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [startMonth, horizon, growthPct, churnPctOverride, subRateOverride]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadScenarios = useCallback(async () => {
    try {
      const res = (await listScenariosFn({ data: undefined as any })) as any;
      if (res?.ok) {
        setScenarios((res.scenarios ?? []) as ScenarioListItem[]);
        setScenariosError(null);
      } else {
        setScenariosError(res?.error ?? "Failed to load scenarios");
      }
    } catch (err: any) {
      setScenariosError(err?.message ?? "Failed to load scenarios");
    }
  }, []);

  useEffect(() => {
    void loadScenarios();
  }, [loadScenarios]);

  const applyScenario = useCallback(
    async (id: string) => {
      try {
        const res = (await loadScenarioFn({ data: { id } })) as any;
        if (!res?.ok) {
          setScenariosError(res?.error ?? "Failed to load scenario");
          return;
        }
        const a = (res.scenario?.assumptions ?? {}) as ScenarioListItem["assumptions"];
        if (typeof a.monthlyGrowthRate === "number") {
          setGrowthPct(String(a.monthlyGrowthRate * 100));
        }
        if (a.churnRateOverride == null) {
          setChurnPctOverride("");
        } else if (typeof a.churnRateOverride === "number") {
          setChurnPctOverride(String(a.churnRateOverride * 100));
        }
        if (a.subscriberRateOverride == null) {
          setSubRateOverride("");
        } else if (typeof a.subscriberRateOverride === "number") {
          setSubRateOverride(String(a.subscriberRateOverride * 100));
        }
        if (typeof a.horizonMonths === "number") setHorizon(a.horizonMonths);
        setScenariosError(null);
      } catch (err: any) {
        setScenariosError(err?.message ?? "Failed to load scenario");
      }
    },
    [],
  );

  const removeScenario = useCallback(
    async (id: string, name: string) => {
      if (!confirm(`Delete scenario "${name}"?`)) return;
      try {
        const res = (await deleteScenarioFn({ data: { id } })) as any;
        if (!res?.ok) {
          setScenariosError(res?.error ?? "Failed to delete scenario");
          return;
        }
        await loadScenarios();
      } catch (err: any) {
        setScenariosError(err?.message ?? "Failed to delete scenario");
      }
    },
    [loadScenarios],
  );

  const aggregate = useMemo(() => {
    if (!data) return null;
    if (selectedMarket !== "ALL") {
      return data.markets.find((m) => m.market === selectedMarket) ?? null;
    }
    // Sum across markets
    const months: ForecastMonthRow[] = [];
    const first = data.markets[0]?.months ?? [];
    for (let i = 0; i < first.length; i++) {
      let nc = 0,
        ot = 0,
        st = 0,
        p50 = 0,
        p90 = 0,
        ncust = 0;
      for (const m of data.markets) {
        const row = m.months[i];
        if (!row) continue;
        nc += row.newCustomerRevenue;
        ot += row.oneTimeRepeatRevenue;
        st += row.subscriberTailRevenue;
        p50 += row.totalP50;
        p90 += row.totalP90;
        ncust += row.newCustomers;
      }
      months.push({
        monthIso: first[i].monthIso,
        monthLabel: first[i].monthLabel,
        newCustomerRevenue: +nc.toFixed(2),
        oneTimeRepeatRevenue: +ot.toFixed(2),
        subscriberTailRevenue: +st.toFixed(2),
        totalP50: +p50.toFixed(2),
        totalP90: +p90.toFixed(2),
        newCustomers: +ncust.toFixed(1),
      });
    }
    const totals = months.reduce(
      (acc, r) => ({
        newCustomerRevenue: acc.newCustomerRevenue + r.newCustomerRevenue,
        oneTimeRepeatRevenue: acc.oneTimeRepeatRevenue + r.oneTimeRepeatRevenue,
        subscriberTailRevenue: acc.subscriberTailRevenue + r.subscriberTailRevenue,
        totalP50: acc.totalP50 + r.totalP50,
        totalP90: acc.totalP90 + r.totalP90,
      }),
      {
        newCustomerRevenue: 0,
        oneTimeRepeatRevenue: 0,
        subscriberTailRevenue: 0,
        totalP50: 0,
        totalP90: 0,
      },
    );
    return { months, totals };
  }, [data, selectedMarket]);

  const chartData = useMemo(() => {
    if (!aggregate) return [];
    return aggregate.months.map((m) => ({
      label: m.monthLabel,
      newCust: Math.round(m.newCustomerRevenue),
      oneTime: Math.round(m.oneTimeRepeatRevenue),
      subTail: Math.round(m.subscriberTailRevenue),
      p50: Math.round(m.totalP50),
      p90: Math.round(m.totalP90),
    }));
  }, [aggregate]);

  return (
    <DashboardShell user={user}>
      <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">
              Revenue forecast
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Cohort-based LTV projection. Three streams: new customer
              acquisition, one-time repeat, subscriber tail. P50 = central
              estimate, P90 = conservative cap derived from cohort sample
              size.{" "}
              {data?.fetchedAt ? (
                <span className="text-muted-foreground/80">
                  · refreshed {new Date(data.fetchedAt).toLocaleTimeString()}
                </span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </header>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {data?.twWarning ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {data.twWarning}
          </div>
        ) : null}
        {data?.diagnostics && data.diagnostics.length > 0 ? (
          <DiagnosticsStrip diagnostics={data.diagnostics} />
        ) : null}

        <AssumptionsBar
          startMonth={startMonth}
          setStartMonth={setStartMonth}
          horizon={horizon}
          setHorizon={setHorizon}
          growthPct={growthPct}
          setGrowthPct={setGrowthPct}
          churnPctOverride={churnPctOverride}
          setChurnPctOverride={setChurnPctOverride}
          subRateOverride={subRateOverride}
          setSubRateOverride={setSubRateOverride}
        />

        <ScenariosPanel
          scenarios={scenarios}
          error={scenariosError}
          onRefresh={() => void loadScenarios()}
          onApply={(id) => void applyScenario(id)}
          onDelete={(id, name) => void removeScenario(id, name)}
        />

        <MarketSelector
          selected={selectedMarket}
          onSelect={setSelectedMarket}
        />

        {data && aggregate ? (
          <>
            <TotalsStrip
              totals={aggregate.totals}
              horizon={horizon}
              market={selectedMarket}
            />
            <ChartCard chartData={chartData} />
            <MonthlyTable months={aggregate.months} />
            {selectedMarket !== "ALL" ? (
              <MarketAssumptionsCard
                market={
                  data.markets.find((m) => m.market === selectedMarket) ?? null
                }
              />
            ) : (
              <PerMarketSummaryCard markets={data.markets} />
            )}
          </>
        ) : null}
      </div>
    </DashboardShell>
  );
}

function AssumptionsBar(props: {
  startMonth: string;
  setStartMonth: (s: string) => void;
  horizon: number;
  setHorizon: (n: number) => void;
  growthPct: string;
  setGrowthPct: (s: string) => void;
  churnPctOverride: string;
  setChurnPctOverride: (s: string) => void;
  subRateOverride: string;
  setSubRateOverride: (s: string) => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 text-sm font-medium text-foreground">Assumptions</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Field label="Start month">
          <input
            type="month"
            value={props.startMonth.slice(0, 7)}
            onChange={(e) =>
              /^\d{4}-\d{2}$/.test(e.target.value) &&
              props.setStartMonth(`${e.target.value}-01`)
            }
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
          />
        </Field>
        <Field label="Horizon (months)">
          <input
            type="number"
            min={1}
            max={24}
            value={props.horizon}
            onChange={(e) => props.setHorizon(Number(e.target.value) || 12)}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm tabular-nums"
          />
        </Field>
        <Field
          label="Monthly growth %"
          hint="0 = use each market's historical trend automatically. Any non-zero value overrides history."
        >
          <input
            type="number"
            step="0.5"
            value={props.growthPct}
            onChange={(e) => props.setGrowthPct(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm tabular-nums"
          />
        </Field>
        <Field
          label="Churn % (override)"
          hint="Leave blank to use Triple Whale churn rate."
        >
          <input
            type="number"
            step="0.1"
            placeholder="auto"
            value={props.churnPctOverride}
            onChange={(e) => props.setChurnPctOverride(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm tabular-nums"
          />
        </Field>
        <Field
          label="Subscriber % (override)"
          hint="% of new customers who subscribe. Blank = derived."
        >
          <input
            type="number"
            step="1"
            placeholder="auto"
            value={props.subRateOverride}
            onChange={(e) => props.setSubRateOverride(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm tabular-nums"
          />
        </Field>
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[10px] text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

function MarketSelector({
  selected,
  onSelect,
}: {
  selected: Market | "ALL";
  onSelect: (m: Market | "ALL") => void;
}) {
  const opts: Array<{ key: Market | "ALL"; label: string }> = [
    { key: "ALL", label: "All markets" },
    ...MARKETS.map((m) => ({ key: m, label: `${MARKET_FLAG[m]} ${m}` })),
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onSelect(o.key)}
          className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
            selected === o.key
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input bg-background text-foreground hover:bg-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function TotalsStrip({
  totals,
  horizon,
  market,
}: {
  totals: MarketForecast["totals"];
  horizon: number;
  market: Market | "ALL";
}) {
  const items = [
    { label: `${horizon}-mo P50 total`, value: fmtMoneyK(totals.totalP50), strong: true },
    { label: `${horizon}-mo P90 (conservative)`, value: fmtMoneyK(totals.totalP90) },
    { label: "New customer rev", value: fmtMoneyK(totals.newCustomerRevenue) },
    { label: "One-time repeat", value: fmtMoneyK(totals.oneTimeRepeatRevenue) },
    { label: "Subscriber tail", value: fmtMoneyK(totals.subscriberTailRevenue) },
  ];
  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-xl border border-border bg-card p-3"
        >
          <div className="text-xs text-muted-foreground">
            {it.label}
            {market !== "ALL" ? <span className="ml-1">· {market}</span> : null}
          </div>
          <div
            className={`mt-1 tabular-nums ${it.strong ? "text-2xl font-semibold text-foreground" : "text-lg font-medium text-foreground"}`}
          >
            {it.value}
          </div>
        </div>
      ))}
    </section>
  );
}

function ChartCard({
  chartData,
}: {
  chartData: Array<{
    label: string;
    newCust: number;
    oneTime: number;
    subTail: number;
    p50: number;
    p90: number;
  }>;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 text-sm font-medium text-foreground">
        Forecast — stacked revenue + P90 floor
      </div>
      <div className="h-80 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis
              tick={{ fontSize: 11 }}
              tickFormatter={(v) => fmtMoneyK(v)}
            />
            <Tooltip
              formatter={(v: any) => fmtMoney(Number(v))}
              labelStyle={{ fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area
              type="monotone"
              dataKey="newCust"
              name="New customer"
              stackId="rev"
              stroke="#10b981"
              fill="#10b981"
              fillOpacity={0.65}
            />
            <Area
              type="monotone"
              dataKey="oneTime"
              name="One-time repeat"
              stackId="rev"
              stroke="#3b82f6"
              fill="#3b82f6"
              fillOpacity={0.65}
            />
            <Area
              type="monotone"
              dataKey="subTail"
              name="Subscriber tail"
              stackId="rev"
              stroke="#8b5cf6"
              fill="#8b5cf6"
              fillOpacity={0.65}
            />
            <Line
              type="monotone"
              dataKey="p90"
              name="P90 (conservative)"
              stroke="#dc2626"
              strokeDasharray="5 5"
              dot={false}
              strokeWidth={2}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function MonthlyTable({ months }: { months: ForecastMonthRow[] }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">
          Month-by-month forecast
        </h2>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left">Month</th>
              <th className="px-4 py-2 text-right">New cust.</th>
              <th className="px-4 py-2 text-right">New customer rev</th>
              <th className="px-4 py-2 text-right">One-time repeat</th>
              <th className="px-4 py-2 text-right">Subscriber tail</th>
              <th className="px-4 py-2 text-right">Total P50</th>
              <th className="px-4 py-2 text-right">Total P90</th>
            </tr>
          </thead>
          <tbody>
            {months.map((r) => (
              <tr key={r.monthIso} className="border-t border-border">
                <td className="px-4 py-2 font-medium text-foreground">
                  {r.monthLabel}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtNum(r.newCustomers)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtMoney(r.newCustomerRevenue)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtMoney(r.oneTimeRepeatRevenue)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtMoney(r.subscriberTailRevenue)}
                </td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums">
                  {fmtMoney(r.totalP50)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                  {fmtMoney(r.totalP90)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MarketAssumptionsCard({ market }: { market: MarketForecast | null }) {
  if (!market) return null;
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <span>{MARKET_FLAG[market.market]}</span>
        <span>{market.market} — inputs used</span>
        <span className="ml-2 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
          Confidence factor: {(market.confidenceFactor * 100).toFixed(0)}%
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Mini label="AOV" value={fmtMoney(market.aov)} />
        <Mini
          label="Baseline new cust / mo"
          value={fmtNum(market.baselineNewCustomersPerMonth)}
        />
        <Mini label="Monthly churn" value={fmtPct(market.monthlyChurnRate)} />
        <Mini label="Subscriber rate" value={fmtPct(market.subscriberRate)} />
        <Mini label="Starting MRR" value={fmtMoney(market.startingMrr)} />
        <Mini label="ARPU / subscriber" value={fmtMoney(market.arpuPerSubscriber)} />
        <Mini
          label={`Historical growth (${market.historicalMonthsUsed} mo)`}
          value={
            market.historicalGrowthRate != null
              ? `${(market.historicalGrowthRate * 100).toFixed(1)}%/mo`
              : "—"
          }
        />
        <Mini
          label="Seasonal peak"
          value={
            market.seasonalIndex
              ? (() => {
                  const entries = Object.entries(market.seasonalIndex);
                  if (entries.length === 0) return "—";
                  let bestMo = 1;
                  let bestMul = 1;
                  for (const [mo, mul] of entries) {
                    if (Number(mul) > bestMul) {
                      bestMul = Number(mul);
                      bestMo = Number(mo);
                    }
                  }
                  const monthName = new Date(2020, bestMo - 1, 1).toLocaleString("en-GB", {
                    month: "short",
                  });
                  return `${monthName} (${bestMul.toFixed(2)}×)`;
                })()
              : "—"
          }
        />
        <Mini label="LTV 90d" value={fmtMoney(market.ltvWindows.day90)} />
        <Mini label="LTV 365d" value={fmtMoney(market.ltvWindows.day365)} />
      </div>
      {market.warnings.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-700">
          {market.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function PerMarketSummaryCard({ markets }: { markets: MarketForecast[] }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">
          Per-market summary
        </h2>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left">Market</th>
              <th className="px-4 py-2 text-right">AOV</th>
              <th className="px-4 py-2 text-right">New cust / mo</th>
              <th className="px-4 py-2 text-right">Churn</th>
              <th className="px-4 py-2 text-right">Starting MRR</th>
              <th className="px-4 py-2 text-right">P50 total</th>
              <th className="px-4 py-2 text-right">P90 total</th>
              <th className="px-4 py-2 text-right">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {markets.map((m) => (
              <tr key={m.market} className="border-t border-border">
                <td className="px-4 py-2 font-medium text-foreground">
                  {MARKET_FLAG[m.market]} {m.market}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtMoney(m.aov)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtNum(m.baselineNewCustomersPerMonth)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtPct(m.monthlyChurnRate)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmtMoney(m.startingMrr)}
                </td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums">
                  {fmtMoney(m.totals.totalP50)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                  {fmtMoney(m.totals.totalP90)}
                </td>
                <td className="px-4 py-2 text-right text-xs text-muted-foreground">
                  {(m.confidenceFactor * 100).toFixed(0)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DiagnosticsStrip({
  diagnostics,
}: {
  diagnostics: Array<{ name: string; ok: boolean; cached: boolean; error: string | null }>;
}) {
  const anyError = diagnostics.some((d) => !d.ok);
  return (
    <section
      className={`rounded-xl border px-3 py-2 text-xs ${
        anyError
          ? "border-amber-300 bg-amber-50"
          : "border-emerald-200 bg-emerald-50/60"
      }`}
    >
      <div className="mb-1 font-medium text-foreground">Data sources</div>
      <div className="flex flex-wrap gap-2">
        {diagnostics.map((d) => (
          <div
            key={d.name}
            className={`flex items-center gap-1 rounded-md border px-2 py-0.5 ${
              d.ok
                ? "border-emerald-200 bg-white text-emerald-800"
                : "border-rose-300 bg-white text-rose-700"
            }`}
            title={d.error ?? (d.cached ? "Served from cache" : "Fresh")}
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                d.ok ? "bg-emerald-500" : "bg-rose-500"
              }`}
            />
            <span>{d.name}</span>
            {d.cached ? (
              <span className="text-[10px] text-muted-foreground">· cached</span>
            ) : null}
            {!d.ok && d.error ? (
              <span className="text-[10px] text-rose-700">
                · {d.error.slice(0, 60)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function ScenariosPanel({
  scenarios,
  error,
  onRefresh,
  onApply,
  onDelete,
}: {
  scenarios: ScenarioListItem[];
  error: string | null;
  onRefresh: () => void;
  onApply: (id: string) => void;
  onDelete: (id: string, name: string) => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Saved scenarios
          </h2>
          <p className="text-xs text-muted-foreground">
            Named what-if forecasts. Save new ones via the chat assistant
            ("save this as 'Joe Rogan partnership'").
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs font-medium hover:bg-muted"
        >
          Refresh
        </button>
      </header>
      {error ? (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {scenarios.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          No saved scenarios yet. Try the chat: <em>"Save this forecast as 'Base 2026'"</em>.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-right">Growth</th>
                <th className="px-4 py-2 text-right">Churn override</th>
                <th className="px-4 py-2 text-right">Sub override</th>
                <th className="px-4 py-2 text-right">P50 total</th>
                <th className="px-4 py-2 text-right">P90 total</th>
                <th className="px-4 py-2 text-right">Updated</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="px-4 py-2 font-medium text-foreground">
                    {s.name}
                    {s.description ? (
                      <div className="text-xs font-normal text-muted-foreground">
                        {s.description}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {typeof s.assumptions.monthlyGrowthRate === "number"
                      ? `${(s.assumptions.monthlyGrowthRate * 100).toFixed(1)}%/mo`
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {s.assumptions.churnRateOverride == null
                      ? "auto"
                      : `${(s.assumptions.churnRateOverride * 100).toFixed(1)}%`}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {s.assumptions.subscriberRateOverride == null
                      ? "auto"
                      : `${(s.assumptions.subscriberRateOverride * 100).toFixed(0)}%`}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums">
                    {s.snapshot ? fmtMoney(s.snapshot.grand.totalP50) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                    {s.snapshot ? fmtMoney(s.snapshot.grand.totalP90) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-muted-foreground">
                    {new Date(s.updated_at).toLocaleDateString("en-GB")}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => onApply(s.id)}
                        className="rounded-md border border-input bg-background px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(s.id, s.name)}
                        className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-foreground tabular-nums">
        {value}
      </div>
    </div>
  );
}
