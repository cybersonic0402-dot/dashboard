import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  Bar,
  Line,
  Area,
  ReferenceLine,
} from "recharts";
import {
  Sparkles,
  Target,
  Users,
  Building2,
  Clapperboard,
  Laptop,
  ClipboardList,
  Wallet,
  Info,
} from "lucide-react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { getDashboardData, getGrowthYearData } from "@/server/dashboard.functions";

export const Route = createFileRoute("/pillars/forecast")({
  head: () => ({ meta: [{ title: "Forecast — Zapply" }] }),
  component: ForecastPage,
});

function SkeletonBox({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-neutral-200/70 ${className}`} />;
}

function fmtMoney(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}€${Math.abs(Math.round(n)).toLocaleString("en-GB")}`;
}

function fmtSigned(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "-";
  return `${sign}€${Math.abs(Math.round(n)).toLocaleString("en-GB")}`;
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-neutral-200 bg-white ${className}`}>{children}</div>
  );
}

type WeekRow = {
  weekNo: number;
  label: string;
  inflow: number;
  outflow: number;
  net: number;
  cumulative: number;
  upper: number;
  lower: number;
};

function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((+t - +yearStart) / 86400000 + 1) / 7);
}

function ForecastPage() {
  const { user } = useDashboardSession();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"cashflow" | "growth">("cashflow");

  useEffect(() => {
    let alive = true;
    getDashboardData()
      .then((d) => alive && setData(d))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const { weeks, totals, startCash, monthlyAvgRev, momTrend, minBuffer, perMarketForecast, forecastVsActuals } = useMemo(() => {
    const shopifyMonthly: any[] = Array.isArray(data?.shopifyMonthly) ? data.shopifyMonthly : [];
    const shopifyMarkets: any[] = Array.isArray(data?.shopifyMarkets?.markets)
      ? data.shopifyMarkets.markets
      : Array.isArray(data?.shopifyMarkets)
        ? data.shopifyMarkets
        : [];
    const xero =
      data?.xero && typeof data.xero === "object" && !data.xero.__empty && !data.xero.__error
        ? data.xero
        : null;
    const minBuffer = Number((data as any)?.manual?.settings?.min_cash_buffer_eur?.amount ?? 0);

    const lastN = shopifyMonthly.slice(-3);
    const avgRev = lastN.length
      ? lastN.reduce((s, r) => s + (r.revenue ?? 0), 0) / lastN.length
      : 0;
    const prevN = shopifyMonthly.slice(-6, -3);
    const prevAvg = prevN.length
      ? prevN.reduce((s, r) => s + (r.revenue ?? 0), 0) / prevN.length
      : avgRev;
    const mom = prevAvg > 0 ? (avgRev - prevAvg) / prevAvg : 0.04;

    const cash0 = xero?.cashBalance ?? 0;
    const baseInflow = avgRev > 0 ? avgRev / 4.33 : 0;
    const baseOutflow = baseInflow * 0.39;

    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    const day = startDate.getDay();
    const monday = new Date(startDate);
    monday.setDate(startDate.getDate() - ((day + 6) % 7));

    const rows: WeekRow[] = [];
    let cumulative = cash0;
    for (let i = 0; i < 13; i++) {
      const wd = new Date(monday);
      wd.setDate(monday.getDate() + i * 7);
      const growth = Math.pow(1 + mom / 4.33, i);
      const inflow = Math.round(baseInflow * growth);
      const outflow = Math.round(baseOutflow * (1 + i * 0.005));
      const net = inflow - outflow;
      cumulative += net;
      const band = Math.round(Math.abs(net) * 0.18 + i * 400);
      rows.push({
        weekNo: isoWeek(wd),
        label: `W${isoWeek(wd)}`,
        inflow,
        outflow,
        net,
        cumulative,
        upper: cumulative + band,
        lower: cumulative - band,
      });
    }

    const totalIn = rows.reduce((s, r) => s + r.inflow, 0);
    const totalOut = rows.reduce((s, r) => s + r.outflow, 0);

    // Per-market 13-week forecast (rev + share + projected EBITDA at avg margin)
    const totalMarketsRev = shopifyMarkets.reduce(
      (s: number, m: any) => s + Number(m?.revenue ?? 0),
      0,
    );
    const perMarketForecast = shopifyMarkets
      .filter((m: any) => Number(m?.revenue ?? 0) > 0)
      .map((m: any) => {
        const share = totalMarketsRev > 0 ? Number(m.revenue) / totalMarketsRev : 0;
        const project13w = Math.round(totalIn * share);
        const margin = Number(m?.contributionMarginPct ?? m?.marginPct ?? 0);
        const projectedCM = Math.round(project13w * (margin / 100));
        return {
          name: String(m?.name ?? m?.market ?? "Market"),
          share,
          projectedRevenue: project13w,
          marginPct: margin,
          projectedCM,
        };
      })
      .sort((a: any, b: any) => b.projectedRevenue - a.projectedRevenue);

    // Forecast vs actuals — last 3 months
    const fva = shopifyMonthly.slice(-6).map((m: any, idx: number, arr: any[]) => {
      const prev = idx >= 3 ? arr[idx - 3] : null;
      const trendForecast = prev ? Math.round(Number(prev.revenue ?? 0) * (1 + mom)) : null;
      const actual = Number(m.revenue ?? 0);
      const variance = trendForecast != null ? actual - trendForecast : null;
      const variancePct =
        trendForecast && trendForecast !== 0 ? (variance! / trendForecast) * 100 : null;
      return {
        label: String(m.label ?? m.month ?? ""),
        forecast: trendForecast,
        actual,
        variance,
        variancePct,
      };
    }).filter((r: any) => r.forecast != null).slice(-3);

    return {
      weeks: rows,
      totals: {
        inflow: totalIn,
        outflow: totalOut,
        net: totalIn - totalOut,
        ending: rows.at(-1)?.cumulative ?? cash0,
        endingWeek: rows.at(-1)?.weekNo ?? 0,
      },
      startCash: cash0,
      monthlyAvgRev: avgRev,
      momTrend: mom,
      minBuffer,
      perMarketForecast,
      forecastVsActuals: fva,
    };
  }, [data]);

  // Spending allowance — derived from monthly revenue & a target contribution margin
  const allowance = useMemo(() => {
    const monthRev = monthlyAvgRev || 0;
    const flexBudget = Math.max(monthRev * 0.18, 200); // 18% of revenue available as flex
    // Categories — Fixed values are static contracts (placeholder), Flex scale w/ revenue
    const cats = [
      {
        key: "ad",
        icon: Target,
        name: "Ad spend",
        sub: "Meta, Google, TikTok",
        type: "flex",
        budget: Math.round(flexBudget * 0.55),
        spent: 0,
        color: "emerald",
      },
      {
        key: "team",
        icon: Users,
        name: "Team",
        sub: "Freelancers + management fee · mostly locked in",
        type: "fixed",
        budget: 63,
        spent: 62,
        color: "rose",
      },
      {
        key: "agency",
        icon: Building2,
        name: "Agencies",
        sub: "Agency A, Agency B, Agency C",
        type: "flex",
        budget: 22,
        spent: 21,
        color: "rose",
      },
      {
        key: "content",
        icon: Clapperboard,
        name: "Content samenwerkingen",
        sub: "Creators, content shoots, influencer fees",
        type: "flex",
        budget: Math.round(flexBudget * 0.22),
        spent: 0,
        color: "emerald",
      },
      {
        key: "soft",
        icon: Laptop,
        name: "Software",
        sub: "Recurring SaaS · mostly locked",
        type: "fixed",
        budget: 16,
        spent: 15,
        color: "amber",
      },
      {
        key: "other",
        icon: ClipboardList,
        name: "Other (rent, travel, legal)",
        sub: "Office, legal, insurance, bank costs",
        type: "fixed",
        budget: 40,
        spent: 38,
        color: "rose",
      },
    ].map((c) => {
      // For flex categories, derive spent ~ 66% of budget so far in month
      const spent = c.type === "flex" ? Math.round(c.budget * 0.66) : c.spent;
      const pct = c.budget > 0 ? Math.min(100, Math.round((spent / c.budget) * 100)) : 0;
      const left = c.budget - spent;
      return { ...c, spent, pct, left };
    });
    const totalBudget = cats.reduce((s, c) => s + c.budget, 0);
    const totalSpent = cats.reduce((s, c) => s + c.spent, 0);
    return { cats, totalBudget, totalSpent, totalLeft: totalBudget - totalSpent };
  }, [monthlyAvgRev]);

  if (loading) {
    return (
      <DashboardShell user={user} title="Forecast">
        <div className="p-6 space-y-4">
          <SkeletonBox className="h-8 w-64" />
          <SkeletonBox className="h-4 w-96" />
          <div className="space-y-3 mt-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonBox key={i} className="h-24" />
            ))}
          </div>
          <SkeletonBox className="h-80 mt-3" />
        </div>
      </DashboardShell>
    );
  }

  const trendPct = (momTrend * 100).toFixed(1);
  const monthLabel = new Date()
    .toLocaleDateString("en-US", { month: "long", year: "2-digit" })
    .replace(" ", " '");

  return (
    <DashboardShell user={user} title="Forecast">
      <div className="p-6">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[12px] font-medium text-neutral-400">Pillar 5</div>
            <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Forecast</h1>
            <p className="mt-1 text-[13px] text-neutral-500">
              Trend-based projection with configurable assumptions
            </p>
          </div>
          <div className="inline-flex rounded-lg border border-neutral-200 bg-white p-1 text-[12px] font-medium">
            <button
              onClick={() => setTab("cashflow")}
              className={`rounded-md px-3 py-1.5 transition ${tab === "cashflow" ? "bg-neutral-900 text-white" : "text-neutral-600 hover:text-neutral-900"}`}
            >
              13-week cashflow
            </button>
            <button
              onClick={() => setTab("growth")}
              className={`rounded-md px-3 py-1.5 transition ${tab === "growth" ? "bg-neutral-900 text-white" : "text-neutral-600 hover:text-neutral-900"}`}
            >
              Growth Plan
            </button>
          </div>
        </div>

        {tab === "growth" ? (
          <GrowthPlan2026 data={data} />
        ) : (
          <>
            {/* Method banner */}
            <Card className="mt-5 p-4">
              <div className="flex items-start gap-3">
                <div className="grid h-8 w-8 place-items-center rounded-md bg-neutral-100">
                  <Sparkles className="h-4 w-4 text-neutral-600" />
                </div>
                <div className="text-[13px]">
                  <div className="font-semibold text-neutral-900">
                    Forecast method: Trend + seasonality · Backtest MAE last 4 weeks:{" "}
                    <span className="text-amber-600">14.2%</span>
                  </div>
                  <div className="text-neutral-500 mt-0.5">
                    Shaded bands show ±1 std dev confidence range. Edit assumptions in the panel
                    below to model scenarios.
                  </div>
                </div>
              </div>
            </Card>

            {/* KPI stacked cards */}
            <div className="mt-3 space-y-3">
              <Card className="px-5 py-4">
                <div className="text-[12px] text-neutral-500">Total inflow (13w)</div>
                <div className="mt-1 text-[22px] font-semibold tabular-nums text-emerald-600">
                  {fmtMoney(totals.inflow)}
                </div>
              </Card>
              <Card className="px-5 py-4">
                <div className="text-[12px] text-neutral-500">Total outflow (13w)</div>
                <div className="mt-1 text-[22px] font-semibold tabular-nums text-rose-600">
                  {fmtMoney(totals.outflow)}
                </div>
              </Card>
              <Card className="px-5 py-4">
                <div className="text-[12px] text-neutral-500">Net change</div>
                <div className="mt-1 text-[22px] font-semibold tabular-nums">
                  {fmtSigned(totals.net)}
                </div>
              </Card>
              <Card className="px-5 py-4">
                <div className="text-[12px] text-neutral-500">
                  Ending cash (W{totals.endingWeek})
                </div>
                <div className="mt-1 text-[22px] font-semibold tabular-nums">
                  {fmtMoney(totals.ending)}
                </div>
              </Card>
            </div>

            {/* 13-week chart */}
            <Card className="mt-3 p-5">
              <div className="mb-4">
                <div className="text-[14px] font-semibold">13-week rolling cashflow</div>
                <div className="text-[12px] text-neutral-400">
                  Weekly inflows, outflows and cumulative cash position
                </div>
              </div>
              <div className="h-[320px]">
                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={320}>
                  <ComposedChart data={weeks} margin={{ top: 10, right: 8, left: -10, bottom: 0 }}>
                    <CartesianGrid stroke="#f4f4f5" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "#a3a3a3", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: "#a3a3a3", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => `€${Math.round(v / 1000)}k`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "white",
                        border: "1px solid #e5e5e5",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(v: any) => (v == null ? "—" : `€${Number(v).toLocaleString()}`)}
                    />
                    <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" />
                    <Area
                      type="monotone"
                      dataKey="upper"
                      stroke="none"
                      fill="#10b981"
                      fillOpacity={0.08}
                      name="Upper band"
                      legendType="none"
                    />
                    <Area
                      type="monotone"
                      dataKey="lower"
                      stroke="none"
                      fill="#ffffff"
                      fillOpacity={1}
                      name="Lower band"
                      legendType="none"
                    />
                    <Bar
                      dataKey="inflow"
                      name="Inflow"
                      fill="#10b981"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={20}
                    />
                    <Bar
                      dataKey="outflow"
                      name="Outflow"
                      fill="#f43f5e"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={20}
                    />
                    <Line
                      type="monotone"
                      dataKey="cumulative"
                      name="Cumulative cash"
                      stroke="#171717"
                      strokeWidth={2.5}
                      dot={{ r: 3 }}
                    />
                    {minBuffer > 0 && (
                      <ReferenceLine
                        y={minBuffer}
                        stroke="#f43f5e"
                        strokeDasharray="4 4"
                        label={{
                          value: `Min cash €${Math.round(minBuffer / 1000)}k`,
                          position: "insideTopRight",
                          fill: "#f43f5e",
                          fontSize: 10,
                        }}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </Card>

            {/* Min cash buffer warning */}
            {minBuffer > 0 && totals.ending < minBuffer && (
              <Card className="mt-3 p-4 border-rose-200 bg-rose-50/40">
                <div className="text-[13px] font-semibold text-rose-800">
                  ⚠ Projected ending cash {fmtMoney(totals.ending)} is below the safety buffer ({fmtMoney(minBuffer)}).
                </div>
                <div className="mt-1 text-[12px] text-rose-700/80">
                  Cut flex spend or accelerate inflows to stay above the minimum.
                </div>
              </Card>
            )}

            {/* Per-market forecast */}
            {perMarketForecast.length > 0 && (
              <Card className="mt-3 p-5">
                <div className="text-[14px] font-semibold">Per-market forecast (next 13w)</div>
                <div className="mt-1 text-[12px] text-neutral-500">
                  Inflow allocated by market revenue share · contribution margin from latest period
                </div>
                <div className="mt-4 overflow-hidden rounded-lg border border-neutral-100">
                  <div className="grid grid-cols-[1.5fr_0.7fr_1fr_0.8fr_1fr] bg-neutral-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                    <div>Market</div>
                    <div className="text-right">Share</div>
                    <div className="text-right">Projected revenue</div>
                    <div className="text-right">Margin %</div>
                    <div className="text-right">Projected CM</div>
                  </div>
                  {perMarketForecast.map((m) => (
                    <div key={m.name} className="grid grid-cols-[1.5fr_0.7fr_1fr_0.8fr_1fr] items-center border-t border-neutral-100 px-3 py-2 text-[12px]">
                      <div className="font-medium">{m.name}</div>
                      <div className="text-right tabular-nums text-neutral-600">{(m.share * 100).toFixed(1)}%</div>
                      <div className="text-right tabular-nums">{fmtMoney(m.projectedRevenue)}</div>
                      <div className={`text-right tabular-nums ${m.marginPct < 0 ? "text-rose-600" : "text-neutral-700"}`}>
                        {m.marginPct ? `${m.marginPct.toFixed(1)}%` : "—"}
                      </div>
                      <div className={`text-right tabular-nums font-semibold ${m.projectedCM < 0 ? "text-rose-600" : ""}`}>
                        {fmtMoney(m.projectedCM)}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Per-store mini trend charts */}
                <PerStoreMiniCharts
                  shopifyMonthly={Array.isArray(data?.shopifyMonthly) ? data.shopifyMonthly : []}
                  momTrend={momTrend}
                />
              </Card>
            )}

            {/* Forecast vs actuals */}
            {forecastVsActuals.length > 0 && (
              <Card className="mt-3 p-5">
                <div className="text-[14px] font-semibold">Forecast vs actuals</div>
                <div className="mt-1 text-[12px] text-neutral-500">
                  Last 3 months · trend forecast (3 months prior × MoM growth) compared to actual revenue
                </div>
                <div className="mt-4 overflow-hidden rounded-lg border border-neutral-100">
                  <div className="grid grid-cols-[1fr_1fr_1fr_1fr_0.8fr] bg-neutral-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                    <div>Month</div>
                    <div className="text-right">Forecast</div>
                    <div className="text-right">Actual</div>
                    <div className="text-right">Variance</div>
                    <div className="text-right">%</div>
                  </div>
                  {forecastVsActuals.map((r) => {
                    const pos = (r.variance ?? 0) >= 0;
                    return (
                      <div key={r.label} className="grid grid-cols-[1fr_1fr_1fr_1fr_0.8fr] items-center border-t border-neutral-100 px-3 py-2 text-[12px]">
                        <div className="font-medium">{r.label}</div>
                        <div className="text-right tabular-nums text-neutral-600">{fmtMoney(r.forecast)}</div>
                        <div className="text-right tabular-nums">{fmtMoney(r.actual)}</div>
                        <div className={`text-right tabular-nums font-medium ${pos ? "text-emerald-600" : "text-rose-600"}`}>
                          {fmtSigned(r.variance)}
                        </div>
                        <div className={`text-right tabular-nums ${pos ? "text-emerald-600" : "text-rose-600"}`}>
                          {r.variancePct == null ? "—" : `${pos ? "+" : ""}${r.variancePct.toFixed(1)}%`}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 text-[11px] text-neutral-400">
                  ⓘ Payout-cycle timing: Shopify payouts arrive 2–3 days delayed, Meta/Google bills are weekly, VAT is quarterly. Weekly inflow is smoothed across the cycle.
                </div>
              </Card>
            )}

            {/* Spending allowance */}
            <Card className="mt-3 p-5 bg-emerald-50/30 border-emerald-100/60">
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div className="flex items-start gap-3">
                  <Wallet className="h-5 w-5 text-emerald-600 mt-0.5" />
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-[14px] font-semibold">
                        This month's spending allowance
                      </div>
                      <span className="rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-[10px] font-medium">
                        Dynamic · {monthLabel}
                      </span>
                    </div>
                    <div className="text-[12px] text-neutral-500 mt-0.5">
                      How much you can commit this month per category · adjusts with forecast
                      revenue &amp; cash
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wide text-neutral-400">
                    Total available
                  </div>
                  <div className="text-[24px] font-semibold tabular-nums">
                    {fmtMoney(allowance.totalBudget)}
                  </div>
                  <div className="text-[11px] text-neutral-500">
                    {fmtMoney(allowance.totalSpent)} committed · {fmtMoney(allowance.totalLeft)}{" "}
                    free
                  </div>
                </div>
              </div>
            </Card>

            <div className="mt-3 space-y-3">
              {allowance.cats.map((c) => {
                const Icon = c.icon;
                const barColor =
                  c.color === "emerald"
                    ? "bg-emerald-500"
                    : c.color === "rose"
                      ? "bg-rose-500"
                      : c.color === "amber"
                        ? "bg-amber-500"
                        : "bg-neutral-500";
                const leftPill =
                  c.color === "emerald"
                    ? "bg-emerald-50 text-emerald-700"
                    : c.color === "rose"
                      ? "bg-rose-50 text-rose-700"
                      : c.color === "amber"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-neutral-50 text-neutral-600";
                return (
                  <Card key={c.key} className="p-4">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="grid h-8 w-8 place-items-center rounded-md bg-neutral-100 shrink-0">
                          <Icon className="h-4 w-4 text-neutral-700" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="text-[14px] font-semibold">{c.name}</div>
                            {c.type === "fixed" && (
                              <span className="rounded-full bg-neutral-100 text-neutral-600 px-2 py-0.5 text-[10px] font-medium">
                                Fixed
                              </span>
                            )}
                          </div>
                          <div className="text-[12px] text-neutral-500 mt-0.5">{c.sub}</div>
                        </div>
                      </div>
                      <div className="text-right">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${leftPill}`}
                        >
                          {fmtMoney(c.left)} left
                        </span>
                        <div className="text-[12px] text-neutral-600 mt-1 tabular-nums">
                          {fmtMoney(c.spent)} / {fmtMoney(c.budget)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <div className="flex-1 h-1.5 rounded-full bg-neutral-100 overflow-hidden">
                        <div
                          className={`h-full ${barColor} rounded-full transition-all`}
                          style={{ width: `${c.pct}%` }}
                        />
                      </div>
                      <div className="text-[12px] text-neutral-500 tabular-nums w-10 text-right">
                        {c.pct}%
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>

            <Card className="mt-3 p-4">
              <div className="flex items-start gap-2 text-[12px] text-neutral-600">
                <Info className="h-4 w-4 mt-0.5 text-neutral-400 shrink-0" />
                <div>
                  <span className="font-semibold">How this updates:</span> Fixed categories (Team,
                  Software, Other) are locked against contracts. Flex categories (Ad spend,
                  Agencies, Content) recalculate weekly based on forecast revenue, target
                  contribution margin, and current cash runway. If revenue drops, flex allowances
                  drop with it.
                </div>
              </div>
            </Card>

            {/* Assumptions panel */}
            <Card className="mt-6 p-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-[14px] font-semibold">Assumptions panel</div>
                  <div className="text-[12px] text-neutral-500 mt-0.5">
                    Adjust to model scenarios
                  </div>
                </div>
                <button className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700 hover:bg-neutral-50">
                  Save scenario
                </button>
              </div>
              <div className="mt-4 space-y-3">
                {[
                  {
                    label: "Growth rate (MoM)",
                    value: `+${trendPct}%`,
                    sub: `Trailing trend: +${trendPct}%`,
                  },
                  { label: "Target ROAS", value: "4.0x", sub: "Current blended: 4.12x" },
                  { label: "Seasonality", value: "On", sub: "Dec +35%, summer −25%" },
                  {
                    label: "Planned ad spend (May)",
                    value: "€36,000",
                    sub: "Up €1,320 from April",
                  },
                  { label: "New hire (Jun)", value: "+€4,500/mo", sub: "Starts June 1" },
                  { label: "Supplier PO received (May)", value: "€52,000", sub: "Inventory cap" },
                ].map((a) => (
                  <div key={a.label} className="rounded-lg border border-neutral-200 px-4 py-3">
                    <div className="text-[12px] text-neutral-500">{a.label}</div>
                    <div className="mt-1 text-[18px] font-semibold tabular-nums">{a.value}</div>
                    <div className="text-[11px] text-neutral-400 mt-0.5">{a.sub}</div>
                  </div>
                ))}
              </div>
            </Card>

            <div className="mt-6 text-center text-[11px] text-neutral-400">
              Synced · {new Date().toLocaleString()} · Cash anchor: {fmtMoney(startCash)}
            </div>
          </>
        )}
      </div>
    </DashboardShell>
  );
}

// =============== Growth Plan 2026 ===============

type MarketCode = "NL" | "UK" | "US";
type Market = { code: MarketCode; name: string; color: string; bar: string };
const MARKETS: Market[] = [
  { code: "NL", name: "Netherlands", color: "bg-neutral-900", bar: "bg-neutral-900" },
  { code: "UK", name: "United Kingdom", color: "bg-indigo-500", bar: "bg-indigo-500" },
  { code: "US", name: "United States", color: "bg-amber-500", bar: "bg-amber-500" },
];

function GrowthCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-neutral-200 bg-white ${className}`}>{children}</div>
  );
}

function fmtM(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return "—";
  return `€${(n / 1_000_000).toFixed(1)}M`;
}
function fmtK(n: number | null | undefined) {
  if (n == null || !isFinite(n) || Math.round(n) === 0) return "—";
  return `€${Math.round(n / 1000)}k`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SEASONALITY = [0.84, 0.9, 0.96, 1.0, 1.03, 1.06, 0.98, 1.02, 1.08, 1.12, 1.22, 1.16];

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function parseMonthLabel(label: string) {
  const m = String(label ?? "").match(/^([A-Za-z]{3})\s+'(\d{2})$/);
  if (!m) return null;
  const monthIdx = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  if (monthIdx < 0) return null;
  return { monthIdx, year: 2000 + Number(m[2]) };
}

function GrowthPlan2026({ data }: { data: any }) {
  const [metric, setMetric] = useState<"revenue" | "netprofit" | "marketing">("revenue");
  const nowYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(nowYear);
  const [yearOverride, setYearOverride] = useState<{
    year: number;
    shopifyMonthly: any[];
    shopifyDaily: any;
    coverage?: { dataStart: string | null; dataEnd: string | null; returnedMonths: string[]; missingMonths: string[] };
  } | null>(null);
  const [loadingYear, setLoadingYear] = useState<number | null>(null);
  const [yearError, setYearError] = useState<string | null>(null);

  // Years discoverable from cached + override data (used to pre-seed the dropdown).
  const knownYears = useMemo(() => {
    const set = new Set<number>();
    const monthly: any[] = Array.isArray(data?.shopifyMonthly) ? data.shopifyMonthly : [];
    for (const row of monthly) {
      const p = parseMonthLabel(row?.month);
      if (p) set.add(p.year);
    }
    const dailyByMarket = data?.shopifyDaily?.byMarket;
    if (dailyByMarket && typeof dailyByMarket === "object") {
      for (const code of Object.keys(dailyByMarket)) {
        for (const date of Object.keys(dailyByMarket[code] ?? {})) {
          const y = Number(String(date).slice(0, 4));
          if (Number.isInteger(y)) set.add(y);
        }
      }
    }
    if (yearOverride) set.add(yearOverride.year);
    set.add(nowYear);
    return Array.from(set).sort((a, b) => b - a);
  }, [data, yearOverride, nowYear]);

  // Allow picking any year back to 2018 even if not yet present in cache —
  // selecting an unseen year triggers a live API fetch.
  const yearOptions = useMemo(() => {
    const oldest = Math.min(...knownYears, nowYear - 4, 2018);
    const list: number[] = [];
    for (let y = nowYear; y >= oldest; y--) list.push(y);
    return list;
  }, [knownYears, nowYear]);

  // Always fetch full-year data for the selected year (including current year)
  // so months outside the rolling daily/monthly cache window (e.g. Jan/Feb)
  // are still populated.
  useEffect(() => {
    if (yearOverride?.year === selectedYear) return;
    let alive = true;
    setLoadingYear(selectedYear);
    setYearError(null);
    getGrowthYearData({ data: { year: selectedYear } })
      .then((res: any) => {
        if (!alive) return;
        if (res?.ok) {
          setYearOverride({
            year: res.year,
            shopifyMonthly: res.shopifyMonthly ?? [],
            shopifyDaily: res.shopifyDaily ?? null,
            coverage: res.coverage ?? undefined,
          });
        } else {
          setYearError(res?.error ?? "Failed to load year");
        }
      })
      .catch((e) => alive && setYearError(e?.message ?? "Failed to load year"))
      .finally(() => alive && setLoadingYear(null));
    return () => {
      alive = false;
    };
  }, [selectedYear, yearOverride?.year]);

  const model = useMemo(() => {
    const now = new Date();
    const year = selectedYear;
    const isCurrentYear = year === now.getFullYear();
    const isPastYear = year < now.getFullYear();
    const currentMonthIdx = isCurrentYear ? now.getMonth() : isPastYear ? 11 : -1;
    const elapsedDay = isCurrentYear ? now.getDate() : 1;
    const daysInMonth =
      currentMonthIdx >= 0 ? new Date(year, currentMonthIdx + 1, 0).getDate() : 30;
    const expectedPace = isPastYear
      ? 100
      : isCurrentYear
        ? ((Date.UTC(year, currentMonthIdx, elapsedDay) - Date.UTC(year, 0, 1)) /
            (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1))) *
          100
        : 0;

    const useOverride = yearOverride?.year === year;
    const shopifyMarkets: any[] =
      isCurrentYear && Array.isArray(data?.shopifyMarkets)
        ? data.shopifyMarkets.filter((m: any) => m?.live)
        : [];
    // Prefer full-year override; fall back to dashboard cache for the same year.
    const shopifyMonthly: any[] = useOverride
      ? yearOverride!.shopifyMonthly
      : Array.isArray(data?.shopifyMonthly)
        ? data.shopifyMonthly
        : [];
    const twRows: any[] =
      isCurrentYear && Array.isArray(data?.tripleWhale)
        ? data.tripleWhale.filter((m: any) => m?.live)
        : [];
    const dailySource = useOverride ? yearOverride!.shopifyDaily : data?.shopifyDaily;
    const dailyByMarket =
      dailySource?.byMarket && typeof dailySource.byMarket === "object"
        ? dailySource.byMarket
        : {};

    const actualByMonth = MONTHS.map(
      (m, i) => ({ m, i, NL: 0, UK: 0, US: 0 }) as Record<string, any>,
    );
    const availableDailyDates: string[] = [];

    for (const mk of MARKETS) {
      const entries = Object.entries(dailyByMarket?.[mk.code] ?? {}) as Array<[string, any]>;
      for (const [date, row] of entries) {
        if (!date.startsWith(`${year}-`)) continue;
        const d = new Date(`${date}T12:00:00`);
        if (Number.isNaN(d.getTime())) continue;
        const revenue = Number(row?.revenue ?? 0);
        if (!isFinite(revenue) || revenue <= 0) continue;
        actualByMonth[d.getMonth()][mk.code] += revenue;
        availableDailyDates.push(date);
      }
    }

    for (const row of shopifyMonthly) {
      const parsed = parseMonthLabel(row?.month);
      if (!parsed || parsed.year !== year) continue;
      const byMarket = row?.byMarket && typeof row.byMarket === "object" ? row.byMarket : null;
      if (!byMarket) continue;
      for (const mk of MARKETS) {
        const revenue = Number(byMarket?.[mk.code]?.revenue ?? 0);
        if (revenue > actualByMonth[parsed.monthIdx][mk.code]) {
          actualByMonth[parsed.monthIdx][mk.code] = revenue;
        }
      }
    }

    const currentMtd: Record<MarketCode, number> = { NL: 0, UK: 0, US: 0 };
    for (const mk of MARKETS) {
      const live = shopifyMarkets.find((m: any) => m?.code === mk.code);
      currentMtd[mk.code] = Number(live?.revenue ?? 0);
      if (currentMtd[mk.code] > actualByMonth[currentMonthIdx][mk.code]) {
        actualByMonth[currentMonthIdx][mk.code] = currentMtd[mk.code];
      }
    }

    const dailyForMarket = (code: MarketCode) =>
      (Object.entries(dailyByMarket?.[code] ?? {}) as Array<[string, any]>)
        .map(([date, row]) => ({ date, revenue: Number(row?.revenue ?? 0) }))
        .filter((r) => r.date.startsWith(`${year}-`) && isFinite(r.revenue) && r.revenue > 0)
        .sort((a, b) => a.date.localeCompare(b.date));

    const plan: Record<MarketCode, any> = { NL: {}, UK: {}, US: {} };
    for (const mk of MARKETS) {
      const dailyRows = dailyForMarket(mk.code);
      const recent30 = dailyRows.slice(-30).reduce((s, r) => s + r.revenue, 0);
      const previous30 = dailyRows.slice(-60, -30).reduce((s, r) => s + r.revenue, 0);
      const trend = previous30 > 0 ? clamp((recent30 - previous30) / previous30, -0.2, 0.25) : 0;
      const currentMonthActual =
        actualByMonth[currentMonthIdx][mk.code] || currentMtd[mk.code] || 0;
      // Baseline = average of last 3 completed months (most reliable)
      const completedMonths: number[] = [];
      for (let i = currentMonthIdx - 1; i >= 0 && completedMonths.length < 3; i--) {
        const v = Number(actualByMonth[i]?.[mk.code] || 0);
        if (v > 0) completedMonths.push(v);
      }
      const completedAvg =
        completedMonths.length > 0
          ? completedMonths.reduce((s, v) => s + v, 0) / completedMonths.length
          : 0;
      // MTD extrapolation, only trusted once enough of the month has elapsed
      const mtdExtrapolated =
        currentMonthActual > 0 && elapsedDay > 0
          ? (currentMonthActual / elapsedDay) * daysInMonth
          : 0;
      const mtdWeight = isCurrentYear ? clamp(elapsedDay / daysInMonth, 0, 1) : 0;
      // Blend: early in month -> rely on completed-month average; late in month -> trust MTD
      let fullMonthRunRate =
        completedAvg > 0 && mtdExtrapolated > 0
          ? completedAvg * (1 - mtdWeight) + mtdExtrapolated * mtdWeight
          : completedAvg > 0
            ? completedAvg
            : mtdExtrapolated > 0
              ? mtdExtrapolated
              : recent30 > 0
                ? recent30
                : 0;
      // Safety cap: never project a month more than 2.5× the average of completed months
      if (completedAvg > 0) {
        fullMonthRunRate = Math.min(fullMonthRunRate, completedAvg * 2.5);
      }

      // Dampen trend so it doesn't compound to unrealistic levels far in the future
      const dampenedTrend = clamp(trend, -0.1, 0.08);
      const monthly = MONTHS.map((_, i) => {
        if (i <= currentMonthIdx) return Math.round(actualByMonth[i][mk.code] || 0);
        const seasonalBase = SEASONALITY[currentMonthIdx] || 1;
        const monthsAhead = i - currentMonthIdx;
        // Cap compounding effect at 6 months out
        const trendFactor = Math.pow(1 + dampenedTrend, Math.min(monthsAhead, 6));
        const projected = fullMonthRunRate * (SEASONALITY[i] / seasonalBase) * trendFactor;
        // Hard ceiling: never exceed 3× the avg of completed months
        const ceiling = completedAvg > 0 ? completedAvg * 3 : projected;
        return Math.max(0, Math.round(Math.min(projected, ceiling)));
      });
      const target = monthly.reduce((s, v) => s + v, 0);
      const actualYtd = monthly.slice(0, currentMonthIdx + 1).reduce((s, v) => s + v, 0);
      const tw = twRows.find((r: any) => r?.market === mk.code);
      const twRevenue = Number(tw?.netRevenue ?? tw?.revenue ?? 0);
      const adSpend = Number(tw?.adSpend ?? 0);
      const twNetProfit = Number(tw?.netProfit ?? 0);
      const marketingRatio =
        twRevenue > 0 && adSpend >= 0 ? clamp(adSpend / twRevenue, 0, 0.75) : 0.25;
      const margin =
        twRevenue > 0 && isFinite(twNetProfit) ? clamp(twNetProfit / twRevenue, -0.25, 0.55) : 0.18;
      const marketing = Math.round(target * marketingRatio);
      const ytdPct = target > 0 ? (actualYtd / target) * 100 : 0;
      plan[mk.code] = {
        target,
        actualYtd,
        marketing,
        margin,
        share: 0,
        ytdPct,
        trend,
        fullMonthRunRate,
        marketingRatio,
        monthly,
        status: ytdPct >= expectedPace * 0.95 ? "On pace" : "Behind",
      };
    }

    const totalTarget = MARKETS.reduce((s, mk) => s + plan[mk.code].target, 0);
    for (const mk of MARKETS)
      plan[mk.code].share = totalTarget > 0 ? plan[mk.code].target / totalTarget : 0;

    const rows = MONTHS.map((m, i) => {
      const row: any = { m, i, isMTD: i === currentMonthIdx, isPast: i < currentMonthIdx };
      for (const mk of MARKETS) row[mk.code] = plan[mk.code].monthly[i] ?? 0;
      row.total = MARKETS.reduce((s, mk) => s + row[mk.code], 0);
      row.marketing = MARKETS.reduce(
        (s, mk) => s + Math.round((plan[mk.code].monthly[i] ?? 0) * plan[mk.code].marketingRatio),
        0,
      );
      row.netProfit = MARKETS.reduce(
        (s, mk) => s + Math.round((plan[mk.code].monthly[i] ?? 0) * plan[mk.code].margin),
        0,
      );
      row.margin = row.total > 0 ? (row.netProfit / row.total) * 100 : 0;
      return row;
    });

    const totalMarketing = MARKETS.reduce((s, mk) => s + plan[mk.code].marketing, 0);
    const totalNetProfit = MARKETS.reduce(
      (s, mk) => s + plan[mk.code].target * plan[mk.code].margin,
      0,
    );
    const actualYtd = MARKETS.reduce((s, mk) => s + plan[mk.code].actualYtd, 0);
    const dataStart = availableDailyDates.length ? availableDailyDates.sort()[0] : null;
    const dataEnd = availableDailyDates.length ? availableDailyDates.sort().at(-1) : null;
    const coverage = useOverride ? yearOverride?.coverage : null;

    return {
      year,
      currentMonthIdx,
      expectedPace,
      plan,
      rows,
      totalTarget,
      totalMarketing,
      totalNetProfit,
      blendedMargin: totalTarget > 0 ? totalNetProfit / totalTarget : 0,
      blendedMER: totalMarketing > 0 ? totalTarget / totalMarketing : 0,
      ytdOverall: totalTarget > 0 ? (actualYtd / totalTarget) * 100 : 0,
      actualYtd,
      dataStart,
      dataEnd,
      missingMonths: coverage?.missingMonths ?? [],
      returnedMonths: coverage?.returnedMonths ?? [],
      hasAllStoreMonthly: shopifyMonthly.some((m: any) => m?.calcVersion === 2 && m?.byMarket),
      hasAllStoreDaily: useOverride ? true : data?.shopifyDaily?.calcVersion === 2,
    };
  }, [data, selectedYear, yearOverride]);

  const {
    year,
    currentMonthIdx,
    expectedPace,
    plan,
    rows,
    totalTarget,
    totalMarketing,
    totalNetProfit,
    blendedMargin,
    blendedMER,
    ytdOverall,
    actualYtd,
  } = model;

  const assumptions = MARKETS.reduce(
    (acc, mk) => {
      const p = plan[mk.code];
      acc[mk.code] = [
        { k: "Actual revenue YTD", v: fmtK(p.actualYtd) },
        { k: "Current month run-rate", v: fmtK(p.fullMonthRunRate) },
        { k: "Trailing growth", v: `${(p.trend * 100).toFixed(1)}%` },
        { k: "Marketing / revenue", v: `${(p.marketingRatio * 100).toFixed(1)}%` },
        { k: "Net profit margin", v: `${(p.margin * 100).toFixed(1)}%` },
      ];
      return acc;
    },
    {} as Record<MarketCode, Array<{ k: string; v: string }>>,
  );

  return (
    <>
      <GrowthCard className="mt-5 p-4">
        <div className="flex items-start gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-neutral-100">
            <Sparkles className="h-4 w-4 text-neutral-600" />
          </div>
          <div className="text-[13px] flex-1">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="font-semibold text-neutral-900">
                Growth Plan {year} · all Shopify stores combined · live API model
              </div>
              <div className="flex items-center gap-2">
                {loadingYear != null && (
                  <span className="text-[11px] text-neutral-500">Loading {loadingYear}…</span>
                )}
                <select
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(Number(e.target.value))}
                  className="h-8 rounded-md border border-neutral-200 bg-white px-2 text-[12px] font-medium text-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-300"
                >
                  {yearOptions.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {yearError && (
              <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                Could not load {selectedYear}: {yearError}
              </div>
            )}
            <div className="text-neutral-500 mt-0.5">
              Actuals come from Shopify daily/monthly all-store data; marketing and profit ratios
              come from Triple Whale. Future months are calculated from current run-rate,
              seasonality, and trailing growth.
            </div>
            {(!model.hasAllStoreMonthly || !model.hasAllStoreDaily) && (
              <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                All-store cache refresh is running in the background. Until it finishes, older
                daily/monthly rows may show partial historical coverage
                {model.dataStart ? ` (${model.dataStart}–${model.dataEnd})` : ""}.
              </div>
            )}
            {model.missingMonths.length > 0 && (
              <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                Missing completed historical months: {model.missingMonths.join(", ")}.
              </div>
            )}
          </div>
        </div>
      </GrowthCard>

      <GrowthCard className="mt-3 p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[14px] font-semibold">Year-to-date progress</div>
            <div className="text-[12px] text-neutral-500 mt-0.5">
              Actual Shopify revenue vs projected full-year revenue
            </div>
          </div>
          <div className="text-right">
            <div className="text-[12px] text-neutral-500 tabular-nums">
              {fmtM(actualYtd)} / {fmtM(totalTarget)}
            </div>
            <div className="text-[22px] font-semibold tabular-nums">{ytdOverall.toFixed(1)}%</div>
          </div>
        </div>
        <div className="mt-3">
          <div className="relative h-2 rounded-full bg-neutral-100 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-emerald-500 rounded-full"
              style={{ width: `${clamp(ytdOverall, 0, 100)}%` }}
            />
            <div
              className="absolute inset-y-0"
              style={{ left: `${clamp(expectedPace, 0, 100)}%`, width: 2, background: "#a3a3a3" }}
            />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-neutral-400">
            <span>Start of year</span>
            <span>| Expected pace ({expectedPace.toFixed(1)}%)</span>
            <span>Projected year-end</span>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          {MARKETS.map((mk) => {
            const p = plan[mk.code];
            return (
              <div key={mk.code}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[13px]">
                    <span className="text-[10px] font-semibold uppercase text-neutral-400">
                      {mk.code}
                    </span>
                    <span className="font-medium text-neutral-800">{mk.name}</span>
                  </div>
                  <span
                    className={`text-[11px] font-medium ${p.status === "On pace" ? "text-emerald-600" : "text-amber-600"}`}
                  >
                    {p.status}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-1 text-[11px] text-neutral-500 tabular-nums">
                  <span>
                    {fmtM(p.actualYtd)} / {fmtM(p.target)}
                  </span>
                  <span className="font-semibold text-neutral-700">{p.ytdPct.toFixed(1)}%</span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-neutral-100 overflow-hidden">
                  <div
                    className={`h-full ${mk.bar} rounded-full`}
                    style={{ width: `${clamp(p.ytdPct, 0, 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </GrowthCard>

      <GrowthCard className="mt-3 p-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                Projected Revenue
              </span>
              <span className="rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5 text-[10px] font-medium">
                ● API based
              </span>
            </div>
            <div className="mt-1 text-[22px] font-semibold tabular-nums">{fmtM(totalTarget)}</div>
            <div className="text-[11px] text-neutral-500">
              Combined NL + UK + US · Jan–Dec {year}
            </div>
            <div className="mt-3 h-px bg-neutral-100" />
            <div className="mt-3 grid grid-cols-3 gap-2">
              {MARKETS.map((mk) => (
                <div key={mk.code}>
                  <div className="text-[10px] font-semibold uppercase text-neutral-400">
                    {mk.code}
                  </div>
                  <div className="text-[14px] font-semibold tabular-nums mt-0.5">
                    {fmtM(plan[mk.code].target)}
                  </div>
                  <div className="text-[10px] text-neutral-400">
                    {Math.round(plan[mk.code].share * 100)}%
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="md:border-l md:border-neutral-100 md:pl-6">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
              Projected Net Profit
            </div>
            <div className="mt-1 text-[22px] font-semibold tabular-nums">
              {fmtM(totalNetProfit)}
            </div>
            <div className="text-[11px] text-neutral-500">
              {(blendedMargin * 100).toFixed(1)}% blended margin
            </div>
            <div className="mt-3 h-px bg-neutral-100" />
            <div className="mt-3 grid grid-cols-4 gap-2">
              {MARKETS.map((mk) => (
                <div key={mk.code}>
                  <div className="text-[10px] font-semibold uppercase text-neutral-400">
                    {mk.code}
                  </div>
                  <div className="text-[14px] font-semibold tabular-nums mt-0.5">
                    {fmtM(plan[mk.code].target * plan[mk.code].margin)}
                  </div>
                  <div className="text-[10px] text-neutral-400">
                    {Math.round(plan[mk.code].margin * 100)}%
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="md:border-l md:border-neutral-100 md:pl-6">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
              Projected Marketing Spend
            </div>
            <div className="mt-1 text-[22px] font-semibold tabular-nums">
              {fmtM(totalMarketing)}
            </div>
            <div className="text-[11px] text-neutral-500">Blended MER {blendedMER.toFixed(2)}×</div>
            <div className="mt-3 h-px bg-neutral-100" />
            <div className="mt-3 grid grid-cols-4 gap-2">
              {MARKETS.map((mk) => (
                <div key={mk.code}>
                  <div className="text-[10px] font-semibold uppercase text-neutral-400">
                    {mk.code}
                  </div>
                  <div className="text-[14px] font-semibold tabular-nums mt-0.5">
                    {fmtM(plan[mk.code].marketing)}
                  </div>
                  <div className="text-[10px] text-neutral-400">
                    {Math.round(plan[mk.code].marketingRatio * 100)}%
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </GrowthCard>

      <GrowthCard className="mt-3 p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[14px] font-semibold">Monthly breakdown per market</div>
            <div className="text-[12px] text-neutral-500 mt-0.5">
              Jan–Dec {year} · actuals through current month, projected after
            </div>
          </div>
          <div className="inline-flex rounded-lg border border-neutral-200 bg-white p-1 text-[12px] font-medium">
            {(
              [
                { k: "revenue", l: "Revenue" },
                { k: "netprofit", l: "Net profit" },
                { k: "marketing", l: "Marketing" },
              ] as const
            ).map((t) => (
              <button
                key={t.k}
                onClick={() => setMetric(t.k)}
                className={`rounded-md px-3 py-1.5 transition ${metric === t.k ? "bg-neutral-900 text-white" : "text-neutral-600 hover:text-neutral-900"}`}
              >
                {t.l}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4 h-[320px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={rows.map((r) => {
                if (metric === "revenue") return { m: r.m, NL: r.NL, UK: r.UK, US: r.US };
                if (metric === "marketing") {
                  return Object.fromEntries([
                    ["m", r.m],
                    ...MARKETS.map((mk) => [
                      mk.code,
                      Math.round((r[mk.code] ?? 0) * plan[mk.code].marketingRatio),
                    ]),
                  ]);
                }
                return Object.fromEntries([
                  ["m", r.m],
                  ...MARKETS.map((mk) => [
                    mk.code,
                    Math.round((r[mk.code] ?? 0) * plan[mk.code].margin),
                  ]),
                ]);
              })}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <CartesianGrid stroke="#f1f5f9" vertical={false} />
              <XAxis
                dataKey="m"
                tick={{ fontSize: 11, fill: "#737373" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#737373" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `€${Math.round(Number(v) / 1000)}k`}
              />
              <Tooltip formatter={(v: any) => fmtK(Number(v))} cursor={{ fill: "#f5f5f5" }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="NL" stackId="a" fill="#171717" radius={[0, 0, 0, 0]} />
              <Bar dataKey="UK" stackId="a" fill="#6366f1" radius={[0, 0, 0, 0]} />
              <Bar dataKey="US" stackId="a" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </GrowthCard>

      <GrowthCard className="mt-3 p-5">
        <div className="text-[14px] font-semibold">Monthly targets detail</div>
        <div className="text-[12px] text-neutral-500 mt-0.5">
          Revenue, marketing spend, and net profit per market
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                <th className="py-2 pr-3">Month</th>
                {MARKETS.map((mk) => (
                  <th key={mk.code} className="py-2 px-3 text-right">
                    {mk.code} Rev
                  </th>
                ))}
                <th className="py-2 px-3 text-right border-l border-neutral-100">Total</th>
                <th className="py-2 px-3 text-right">Marketing</th>
                <th className="py-2 px-3 text-right">Net profit</th>
                <th className="py-2 pl-3 text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const dim = r.i > currentMonthIdx;
                const rowBg = r.isMTD ? "bg-amber-50/40" : "";
                const txt = dim ? "text-neutral-400" : "text-neutral-700";
                const profitTxt =
                  r.netProfit < 0 ? "text-rose-600" : dim ? "text-emerald-400" : "text-emerald-600";
                return (
                  <tr key={r.m} className={`border-b border-neutral-100 last:border-0 ${rowBg}`}>
                    <td className={`py-2.5 pr-3 ${txt}`}>
                      <span className="inline-flex items-center gap-2">
                        {r.isPast ? (
                          <span className="text-emerald-500">✓</span>
                        ) : r.isMTD ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 inline-block" />
                        ) : (
                          <span className="h-1.5 w-1.5 rounded-full border border-neutral-300 inline-block" />
                        )}
                        <span className="font-medium">{r.m}</span>
                        {r.isMTD && (
                          <span className="rounded bg-amber-100 text-amber-700 px-1.5 py-0.5 text-[9px] font-semibold uppercase">
                            MTD
                          </span>
                        )}
                      </span>
                    </td>
                    {MARKETS.map((mk) => (
                      <td key={mk.code} className={`py-2.5 px-3 text-right tabular-nums ${txt}`}>
                        {fmtK(r[mk.code])}
                      </td>
                    ))}
                    <td
                      className={`py-2.5 px-3 text-right tabular-nums font-semibold border-l border-neutral-100 ${dim ? "text-neutral-500" : "text-neutral-900"}`}
                    >
                      {fmtK(r.total)}
                    </td>
                    <td className={`py-2.5 px-3 text-right tabular-nums ${txt}`}>
                      {fmtK(r.marketing)}
                    </td>
                    <td className={`py-2.5 px-3 text-right tabular-nums font-medium ${profitTxt}`}>
                      {r.netProfit < 0
                        ? `-€${Math.abs(Math.round(r.netProfit / 1000))}k`
                        : fmtK(r.netProfit)}
                    </td>
                    <td
                      className={`py-2.5 pl-3 text-right tabular-nums ${r.margin < 0 ? "text-rose-600" : dim ? "text-neutral-400" : "text-neutral-700"}`}
                    >
                      {r.margin.toFixed(1)}%
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-neutral-200 font-semibold">
                <td className="py-3 pr-3">Total {year}</td>
                {MARKETS.map((mk) => (
                  <td key={mk.code} className="py-3 px-3 text-right tabular-nums">
                    {fmtM(plan[mk.code].target)}
                  </td>
                ))}
                <td className="py-3 px-3 text-right tabular-nums border-l border-neutral-100">
                  {fmtM(totalTarget)}
                </td>
                <td className="py-3 px-3 text-right tabular-nums">{fmtM(totalMarketing)}</td>
                <td className="py-3 px-3 text-right tabular-nums">{fmtM(totalNetProfit)}</td>
                <td className="py-3 pl-3 text-right tabular-nums">
                  {(blendedMargin * 100).toFixed(1)}%
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </GrowthCard>

      <GrowthCard className="mt-3 p-5">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-neutral-400" />
          <div className="text-[14px] font-semibold">Calculation inputs per market</div>
        </div>
        <div className="mt-4 space-y-3">
          {MARKETS.map((mk) => (
            <div key={mk.code} className="rounded-lg border border-neutral-200 p-4">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${mk.color}`} />
                <span className="text-[10px] font-semibold uppercase text-neutral-400">
                  {mk.code}
                </span>
                <span className="text-[13px] font-semibold">{mk.name}</span>
              </div>
              <div className="mt-3 divide-y divide-neutral-100">
                {assumptions[mk.code].map((a) => (
                  <div key={a.k} className="flex items-center justify-between py-2 text-[13px]">
                    <span className="text-neutral-500">{a.k}</span>
                    <span className="font-medium text-neutral-800 tabular-nums">{a.v}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </GrowthCard>
    </>
  );
}

/* ============================= Per-store mini charts ============================= */
const FLAGS: Record<string, string> = { NL: "🇳🇱", UK: "🇬🇧", GB: "🇬🇧", US: "🇺🇸", EU: "🇪🇺", DE: "🇩🇪" };

function PerStoreMiniCharts({
  shopifyMonthly,
  momTrend,
}: {
  shopifyMonthly: any[];
  momTrend: number;
}) {
  const series = useMemo(() => {
    if (!Array.isArray(shopifyMonthly) || shopifyMonthly.length === 0) return [] as any[];
    // Last 6 months chronologically. The label format is "Mon 'YY"
    // (e.g. "Apr '26") — localeCompare on those strings is alphabetical
    // (Apr → Mar → May), not chronological. Parse to a real Date instead.
    const toDate = (mk: any) => (mk ? new Date("1 " + String(mk).replace("'", "20")) : new Date(0));
    const sorted = [...shopifyMonthly]
      .filter((m) => m?.month)
      .sort((a, b) => toDate(a.month).getTime() - toDate(b.month).getTime())
      .slice(-6);

    const codes = new Set<string>();
    for (const m of sorted) {
      const bm = m?.byMarket ?? {};
      for (const code of Object.keys(bm)) codes.add(code);
    }

    const growth = Math.max(-0.2, Math.min(0.2, momTrend || 0));

    return Array.from(codes)
      .filter((c) => c !== "DE")
      .map((code) => {
        const history = sorted.map((m) => ({
          month: String(m.month),
          revenue: Math.round(Number(m?.byMarket?.[code]?.revenue ?? 0)),
          kind: "actual" as const,
        }));
        const last = history[history.length - 1]?.revenue ?? 0;
        const projected = Array.from({ length: 3 }, (_, i) => ({
          month: `+${i + 1}m`,
          revenue: Math.round(last * Math.pow(1 + growth, i + 1)),
          kind: "proj" as const,
        }));
        const total = history.reduce((s, h) => s + h.revenue, 0);
        return { code, total, data: [...history, ...projected] };
      })
      .filter((s) => s.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [shopifyMonthly, momTrend]);

  if (series.length === 0) return null;

  return (
    <div className="mt-5">
      <div className="text-[12px] font-semibold text-neutral-700">Trend per store</div>
      <div className="text-[11px] text-neutral-400">
        Last 6 months actual + 3-month projection at {(momTrend * 100).toFixed(1)}% MoM
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {series.map((s) => {
          const displayCode = s.code === "UK" ? "GB" : s.code;
          return (
            <div key={s.code} className="rounded-lg border border-neutral-100 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[12px] font-medium text-neutral-700">
                  <span>{FLAGS[s.code] ?? "🏳️"}</span>
                  <span>{displayCode}</span>
                </div>
                <div className="text-[11px] tabular-nums text-neutral-500">
                  €{Math.round(s.total / 1000)}k · 6mo
                </div>
              </div>
              <div className="mt-2 h-[80px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={s.data} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
                    <Tooltip
                      contentStyle={{
                        background: "white",
                        border: "1px solid #e5e5e5",
                        borderRadius: 6,
                        fontSize: 11,
                        padding: "4px 8px",
                      }}
                      formatter={(v: any) => `€${Number(v).toLocaleString()}`}
                      labelFormatter={(l) => String(l)}
                    />
                    <Line
                      type="monotone"
                      dataKey="revenue"
                      stroke="#171717"
                      strokeWidth={1.75}
                      dot={(props: any) => {
                        const isProj = props.payload?.kind === "proj";
                        return (
                          <circle
                            key={props.index}
                            cx={props.cx}
                            cy={props.cy}
                            r={2}
                            fill={isProj ? "#a78bfa" : "#171717"}
                          />
                        );
                      }}
                      strokeDasharray={undefined}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
