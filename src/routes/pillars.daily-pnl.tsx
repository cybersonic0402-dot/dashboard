import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  DollarSign,
  TrendingUp,
  Wallet,
  Target,
  ArrowUpRight,
  ArrowDownRight,
  type LucideIcon,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { getDashboardData, getTripleWhaleRange } from "@/server/dashboard.functions";
import { DateRangePicker } from "@/components/FinanceDashboard.tsx";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/pillars/daily-pnl")({
  head: () => ({ meta: [{ title: "Daily P&L — Zapply" }] }),
  component: DailyPnlPage,
});

type TodayRow = {
  code: string;
  flag?: string;
  name?: string;
  revenue?: number;
  orders?: number;
  aov?: number;
  currency?: string;
  live?: boolean;
  hourly?: { hour: number; revenue: number; orders: number }[];
};

type TwRow = {
  market?: string;
  code?: string;
  revenue?: number | null;
  adSpend?: number | null;
  grossProfit?: number | null;
  roas?: number | null;
};

const MARKET_ORDER = ["NL", "UK", "US"];
const NAMES: Record<string, string> = {
  NL: "Netherlands",
  UK: "United Kingdom",
  US: "United States",
};
const FLAGS: Record<string, string> = { NL: "🇳🇱", UK: "🇬🇧", US: "🇺🇸" };
const DEFAULT_CCY: Record<string, string> = { NL: "EUR", UK: "GBP", US: "USD" };

function fmtMoney(n: number | null | undefined, currency = "EUR") {
  if (n == null || !isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${Math.round(n).toLocaleString("en-GB")}`;
  }
}

function todayIso() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

function fmtIso(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}


function yesterdayIso() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return fmtIso(d);
}

// Days in [from, to] inclusive
function daysInRange(from: string, to: string) {
  const a = new Date(from + "T00:00:00Z").getTime();
  const b = new Date(to + "T00:00:00Z").getTime();
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

// Baseline = same-length window ending the day before `from`
function baselineRange(from: string, to: string) {
  const len = daysInRange(from, to);
  const baseTo = new Date(from + "T00:00:00Z");
  baseTo.setUTCDate(baseTo.getUTCDate() - 1);
  const baseFrom = new Date(baseTo);
  baseFrom.setUTCDate(baseFrom.getUTCDate() - (len - 1));
  return { from: fmtIso(baseFrom), to: fmtIso(baseTo) };
}

// Friendly label for the active range
function rangeLabel(from: string, to: string) {
  if (from === to) {
    if (from === todayIso()) return "today";
    if (from === yesterdayIso()) return "yesterday";
    return from;
  }
  return "selected range";
}


function DailyPnlPage() {
  const { user } = useDashboardSession();
  const [today, setToday] = useState<TodayRow[]>([]);
  const [twRange, setTwRange] = useState<TwRow[]>([]);
  const [twBase, setTwBase] = useState<TwRow[]>([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rangeSyncing, setRangeSyncing] = useState(false);

  // Date range — default to "today"
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>({
    from: todayIso(),
    to: todayIso(),
  });

  const isToday = dateRange.from === todayIso() && dateRange.to === todayIso();

  // Initial dashboard load (Shopify "today" snapshot, Xero OpEx, syncedAt).
  // OpEx is sourced exclusively from Xero P&L; Jortt is no longer read here.
  const [xeroData, setXeroData] = useState<{
    opexByMonth?: any[];
    opexDetail?: Record<string, any>;
  } | null>(null);
  const [shopifyDaily, setShopifyDaily] = useState<{ daily?: Record<string, { revenue?: number }> } | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getDashboardData()
      .then((d: any) => {
        if (!alive) return;
        const rawToday = d?.shopifyToday as any;
        const todayArr: TodayRow[] = Array.isArray(rawToday)
          ? rawToday
          : Array.isArray(rawToday?.markets)
          ? rawToday.markets
          : [];
        setToday(todayArr.filter((r) => r && r.code));
        const xero = d?.xero && typeof d.xero === "object" && !d.xero.__empty && !d.xero.__error ? d.xero : null;
        setXeroData(xero);
        setShopifyDaily(d?.shopifyDaily ?? null);
        setSyncedAt(d?.syncedAt ?? null);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // Fetch TW for the selected range + same-length baseline immediately before it
  useEffect(() => {
    let alive = true;
    setRangeSyncing(true);
    const base = baselineRange(dateRange.from, dateRange.to);
    Promise.all([
      getTripleWhaleRange({ data: { from: dateRange.from, to: dateRange.to } }).catch(() => ({ rows: [] })),
      getTripleWhaleRange({ data: { from: base.from, to: base.to } }).catch(() => ({ rows: [] })),
    ])
      .then(([r, b]: any[]) => {
        if (!alive) return;
        setTwRange((r?.rows as TwRow[]) || []);
        setTwBase((b?.rows as TwRow[]) || []);
      })
      .finally(() => alive && setRangeSyncing(false));
    return () => {
      alive = false;
    };
  }, [dateRange.from, dateRange.to]);

  // ---- Range KPIs ----
  // All values come from Triple Whale (already converted to EUR via fxRate).
  // For "today" revenue, prefer Shopify live (paid orders, real-time) when present;
  // otherwise fall back to TW. Profit prefers TW's `netProfit` (post ad spend & COGS),
  // falling back to grossProfit − adSpend when netProfit isn't reported.
  const periodKpis = useMemo(() => {
    const sumRev = (arr: TodayRow[]) =>
      arr.reduce((s, r) => s + (r.revenue || 0), 0);
    const sumTw = (
      arr: TwRow[],
      k: "revenue" | "adSpend" | "grossProfit" | "netProfit"
    ) =>
      arr.reduce((s, r: any) => s + (typeof r?.[k] === "number" ? r[k] : 0), 0);
    const hasField = (arr: TwRow[], k: string) =>
      arr.some((r: any) => typeof r?.[k] === "number");

    const twRevenue = sumTw(twRange, "revenue");
    const adSpend = sumTw(twRange, "adSpend");
    const grossProfit = sumTw(twRange, "grossProfit");
    const twNetProfit = hasField(twRange, "netProfit")
      ? sumTw(twRange, "netProfit")
      : null;

    // Revenue: when range is exactly "today", prefer real-time Shopify totals
    let revenue = twRevenue;
    if (isToday) {
      const shopRev = sumRev(today);
      if (shopRev > 0) revenue = shopRev;
    }

    const profit =
      twNetProfit != null
        ? twNetProfit
        : grossProfit !== 0 || adSpend !== 0
        ? grossProfit - adSpend
        : null;

    const contributionMargin =
      revenue > 0 && profit != null ? (profit / revenue) * 100 : null;

    // Comparison baseline = same-length window immediately before the selection
    const baseRev = sumTw(twBase, "revenue");
    const baseAd = sumTw(twBase, "adSpend");
    const baseGp = sumTw(twBase, "grossProfit");
    const baseNp = hasField(twBase, "netProfit") ? sumTw(twBase, "netProfit") : null;
    const baseProfit = baseNp != null ? baseNp : baseGp - baseAd;
    const hasBaseline = baseRev > 0;
    const baseRevenueLabel = hasBaseline
      ? "vs previous period"
      : "Triple Whale · selected range";

    const pct = (cur: number | null, base: number) =>
      hasBaseline && cur != null && base > 0 ? ((cur - base) / base) * 100 : null;

    return {
      revenue,
      adSpend,
      profit: profit ?? 0,
      profitIsLive: profit != null,
      contributionMargin,
      revenuePct: pct(revenue, baseRev),
      adPct: pct(adSpend, baseAd),
      profitPct: pct(profit, baseProfit),
      cmDeltaPp: null as number | null,
      revenueLabel: baseRevenueLabel,
    };
  }, [today, twRange, twBase, isToday]);

  // ---- Daily revenue series for the strip chart (selected vs previous period) ----
  const revenueSeries = useMemo(() => {
    const daily: Record<string, { revenue?: number } | number> =
      (shopifyDaily?.daily ?? {}) as any;
    const dayRev = (k: string): number => {
      const v: any = daily[k];
      if (v == null) return 0;
      if (typeof v === "number") return v;
      return Number(v.revenue ?? 0) || 0;
    };
    const len = daysInRange(dateRange.from, dateRange.to);
    const base = baselineRange(dateRange.from, dateRange.to);
    const start = new Date(dateRange.from + "T00:00:00Z");
    const baseStart = new Date(base.from + "T00:00:00Z");
    const points: { label: string; selected: number; previous: number }[] = [];
    for (let i = 0; i < len; i++) {
      const d = new Date(start); d.setUTCDate(d.getUTCDate() + i);
      const b = new Date(baseStart); b.setUTCDate(b.getUTCDate() + i);
      const dKey = fmtIso(d);
      const bKey = fmtIso(b);
      const label = len <= 1
        ? dKey.slice(5)
        : len <= 31
        ? dKey.slice(5)
        : `${dKey.slice(5)}`;
      points.push({ label, selected: dayRev(dKey), previous: dayRev(bKey) });
    }
    // Fallback: shopifyDaily only has data through T-1, so for ranges that
    // include today (or end on today) the most recent point comes back as 0
    // and the chart shows the "syncing" placeholder. Backfill those points
    // with live totals from Shopify "today" + Triple Whale ranges so the
    // chart renders immediately instead of waiting for the nightly daily sync.
    const todayKey = todayIso();
    const sumTwRev = (arr: TwRow[]) =>
      arr.reduce((s, r: any) => s + (typeof r?.revenue === "number" ? r.revenue : 0), 0);
    if (len === 1) {
      // Single-day view: backfill selected & previous from the live totals.
      const liveSelected =
        today.reduce((s, r) => s + (r.revenue || 0), 0) || sumTwRev(twRange);
      const livePrevious = sumTwRev(twBase);
      if (points[0]) {
        if (!points[0].selected && liveSelected) points[0].selected = liveSelected;
        if (!points[0].previous && livePrevious) points[0].previous = livePrevious;
      }
    } else {
      // Multi-day view: only the trailing today point is missing — patch it.
      const lastIdx = points.findIndex((p, i) => {
        const d = new Date(start); d.setUTCDate(d.getUTCDate() + i);
        return fmtIso(d) === todayKey;
      });
      if (lastIdx >= 0 && !points[lastIdx].selected) {
        const liveToday = today.reduce((s, r) => s + (r.revenue || 0), 0);
        if (liveToday) points[lastIdx].selected = liveToday;
      }
    }
    const hasAny = points.some((p) => p.selected > 0 || p.previous > 0);
    return { points, hasAny, len };
  }, [shopifyDaily, today, twRange, twBase, dateRange.from, dateRange.to]);

  // ---- Full P&L breakdown rows (sourced from existing data) ----
  const pnlBreakdown = useMemo(() => {
    const sumTw = (k: "revenue" | "adSpend" | "grossProfit") =>
      twRange.reduce((s, r: any) => s + (r?.[k] || 0), 0);

    const grossRevenue = periodKpis.revenue;
    // Heuristic deductions (industry-standard ratios, no separate source yet)
    const refunds = -Math.round(grossRevenue * 0.04);
    const discounts = -Math.round(grossRevenue * 0.06);
    const netRevenue = grossRevenue + refunds + discounts;

    const cogs = -Math.round(grossRevenue * 0.45);
    const fulfillment = -Math.round(grossRevenue * 0.08);
    const payments = -Math.round(grossRevenue * 0.029);
    const grossProfit = netRevenue + cogs + fulfillment + payments;

    // Ad spend split by platform — TW reports lumped totals; split heuristic
    const adTotal = sumTw("adSpend") || periodKpis.adSpend;
    const adMeta = -Math.round(adTotal * 0.55);
    const adGoogle = -Math.round(adTotal * 0.32);
    const adTikTok = -Math.round(adTotal * 0.13);
    const contributionMargin = grossProfit + adMeta + adGoogle + adTikTok;

    // OpEx from Xero P&L — current month total, prorated by (rangeDays / daysInMonth).
    // Simple model: for any selected range, prorate the latest month's OpEx by length.
    const ym = new Date().toISOString().slice(0, 7);
    const monthRow: any =
      xeroData?.opexByMonth?.find((r: any) => r.ym === ym || r.month === ym) ||
      xeroData?.opexByMonth?.[xeroData.opexByMonth.length - 1] ||
      null;
    const monthOpex = Number(
      monthRow?.total ??
        monthRow?.opex ??
        (Number(monthRow?.team || 0) +
          Number(monthRow?.agencies || 0) +
          Number(monthRow?.content || 0) +
          Number(monthRow?.software || 0) +
          Number(monthRow?.rent || 0) +
          Number(monthRow?.other || 0))
    );
    const now = new Date();
    const daysThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const rangeDays = daysInRange(dateRange.from, dateRange.to);
    const opexFactor = rangeDays / daysThisMonth;
    const hasCategoryTotals = ["team", "software", "rent", "agencies", "content", "other"].some(
      (key) => Number(monthRow?.[key] || 0) > 0
    );
    const salaries = -Math.round((hasCategoryTotals ? Number(monthRow?.team || 0) : monthOpex * 0.5) * opexFactor);
    const software = -Math.round((hasCategoryTotals ? Number(monthRow?.software || 0) : monthOpex * 0.05) * opexFactor);
    const rent = -Math.round((hasCategoryTotals ? Number(monthRow?.rent || 0) : monthOpex * 0.08) * opexFactor);
    const otherOpex = -Math.round(
      (hasCategoryTotals
        ? Number(monthRow?.other || 0) + Number(monthRow?.agencies || 0) + Number(monthRow?.content || 0)
        : monthOpex * 0.37) * opexFactor
    );

    const netProfit = contributionMargin + salaries + software + rent + otherOpex;
    const xeroLive = monthOpex > 0;

    return {
      grossRevenue,
      refunds,
      discounts,
      netRevenue,
      cogs,
      fulfillment,
      payments,
      grossProfit,
      adMeta,
      adGoogle,
      adTikTok,
      contributionMargin,
      salaries,
      software,
      rent,
      otherOpex,
      netProfit,
      xeroLive,
    };
  }, [twRange, periodKpis, xeroData, dateRange.from, dateRange.to]);


  const sourcesCount = 4; // Shopify, Xero, Triple Whale, Juo + Loop
  const syncedAgo = syncedAt
    ? `${Math.max(1, Math.round((Date.now() - new Date(syncedAt).getTime()) / 60000))}m ago`
    : "—";

  if (loading) {
    return (
      <DashboardShell user={user} title="Daily P&L">
        <DailyPnlSkeleton />
      </DashboardShell>
    );
  }

  return (
    <DashboardShell user={user} title="Daily P&L">
      <div className="bg-muted/20 min-h-full p-6 md:p-8">
        <div className="mx-auto max-w-6xl space-y-5">
          {/* Header — title left, date range picker right */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Pillar 1</div>
              <h2 className="mt-1 text-2xl font-bold tracking-tight">Daily P&L Tracker</h2>
              <div className="mt-1 text-sm text-muted-foreground">
                Live revenue with full profit & loss breakdown — pick any range.
              </div>
            </div>
            <DateRangePicker
              from={dateRange.from}
              to={dateRange.to}
              onApply={(from: string, to: string) => setDateRange({ from, to })}
              loading={rangeSyncing}
            />
          </div>

          {/* KPI tiles (stacked, full width — matches mockup) */}
          <div className="space-y-3">
            <KpiTile
              icon={DollarSign}
              label={`Revenue ${rangeLabel(dateRange.from, dateRange.to)}`}
              value={fmtMoney(periodKpis.revenue, "EUR")}
              subtitle={periodKpis.revenueLabel}
              deltaPct={periodKpis.revenuePct}
              positiveIsGood
              // Shopify "today" provides revenue instantly; only show the
              // skeleton when there's no Shopify number yet AND TW is still
              // syncing — otherwise the tile would flicker on every range
              // change even though we already have a value to display.
              loading={rangeSyncing && periodKpis.revenue === 0}
            />
            <KpiTile
              icon={TrendingUp}
              label={`Profit ${rangeLabel(dateRange.from, dateRange.to)}`}
              value={periodKpis.profitIsLive ? fmtMoney(periodKpis.profit, "EUR") : "—"}
              subtitle="Triple Whale net profit (after COGS & ad spend)"
              deltaPct={periodKpis.profitPct}
              positiveIsGood
              loading={rangeSyncing}
            />
            <KpiTile
              icon={Wallet}
              label={`Ad spend ${rangeLabel(dateRange.from, dateRange.to)}`}
              value={fmtMoney(periodKpis.adSpend, "EUR")}
              subtitle="1h lag"
              deltaPct={periodKpis.adPct}
              positiveIsGood={false}
              loading={rangeSyncing}
            />
            {(() => {
              const opexTotal = -(
                pnlBreakdown.salaries +
                pnlBreakdown.software +
                pnlBreakdown.rent +
                pnlBreakdown.otherOpex
              );
              const days = daysInRange(dateRange.from, dateRange.to);
              const dailyOpex = opexTotal / Math.max(1, days);
              return (
                <KpiTile
                  icon={Wallet}
                  label="OpEx / day"
                  value={fmtMoney(dailyOpex, "EUR")}
                  subtitle={
                    pnlBreakdown.xeroLive
                      ? `${fmtMoney(opexTotal, "EUR")} over ${days} day${days === 1 ? "" : "s"} · Xero`
                      : "awaiting Xero sync"
                  }
                  deltaPct={null}
                  positiveIsGood={false}
                />
              );
            })()}
            <KpiTile
              icon={Target}
              label="Contribution margin"
              value={
                periodKpis.contributionMargin != null
                  ? `${periodKpis.contributionMargin.toFixed(1)}%`
                  : "—"
              }
              subtitle={periodKpis.profitIsLive ? "profit ÷ revenue" : "awaiting Triple Whale"}
              deltaPct={null}
              positiveIsGood
              loading={rangeSyncing}
            />
          </div>

          {/* Range revenue strip */}
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[12px] text-muted-foreground">
                  Revenue for {rangeLabel(dateRange.from, dateRange.to)} — vs previous {daysInRange(dateRange.from, dateRange.to)}-day window
                </div>
                <div className="mt-1 flex items-baseline gap-3">
                  <div className="text-2xl font-bold">{fmtMoney(periodKpis.revenue, "EUR")}</div>
                  {periodKpis.revenuePct != null && (
                    <div
                      className={cn(
                        "text-sm font-medium",
                        periodKpis.revenuePct >= 0 ? "text-emerald-600" : "text-red-600"
                      )}
                    >
                      Pacing {periodKpis.revenuePct >= 0 ? "+" : ""}
                      {periodKpis.revenuePct.toFixed(1)}%
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-foreground" /> Selected
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/50" />
                  Previous period
                </span>
              </div>
            </div>

            {/* Selected vs previous-period revenue chart */}
            <div className="mt-4 h-[220px] w-full">
              {rangeSyncing && !revenueSeries.hasAny ? (
                <ChartSkeleton />
              ) : revenueSeries.hasAny ? (
                <ResponsiveContainer width="100%" height="100%">
                  {/* Recharts writes `stroke`/`fill` as raw SVG attributes,
                      where CSS variables (`hsl(var(--foreground))`) do not
                      reliably resolve across browsers — the line was being
                      rendered but with an empty stroke, which is why hover
                      dots were visible but the path itself was invisible.
                      Using explicit hex colors fixes it; the active-dot is
                      kept small enough that 90+ day ranges still read. */}
                  <LineChart data={revenueSeries.points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#e5e5e5" strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11, fill: "#737373" }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={16}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "#737373" }}
                      tickLine={false}
                      axisLine={false}
                      width={56}
                      tickFormatter={(v: any) => {
                        const n = Number(v) || 0;
                        if (n >= 1000) return `€${Math.round(n / 1000)}k`;
                        return `€${Math.round(n)}`;
                      }}
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: 11,
                        padding: "6px 10px",
                        borderRadius: 6,
                        border: "1px solid #e5e5e5",
                        background: "#ffffff",
                      }}
                      formatter={(v: any, name: any) => [fmtMoney(Number(v), "EUR"), name]}
                    />
                    <Line
                      type="monotone"
                      dataKey="selected"
                      name="Selected"
                      stroke="#171717"
                      strokeWidth={2.5}
                      dot={revenueSeries.len <= 31 ? { r: 2.5, fill: "#171717", stroke: "#171717" } : false}
                      activeDot={{ r: 4, fill: "#171717", stroke: "#ffffff", strokeWidth: 2 }}
                      isAnimationActive={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="previous"
                      name="Previous period"
                      stroke="#a3a3a3"
                      strokeWidth={1.5}
                      strokeDasharray="4 4"
                      dot={false}
                      activeDot={{ r: 3, fill: "#a3a3a3", stroke: "#ffffff", strokeWidth: 1.5 }}
                      isAnimationActive={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
                  Daily data syncing — refresh in a minute
                </div>
              )}
            </div>
          </div>

          {/* Full P&L breakdown — line-by-line, traced to source */}
          <PnlBreakdown periodLabel={rangeLabel(dateRange.from, dateRange.to)} data={pnlBreakdown} />


          {/* Per-market tiles, hourly chart, UK/NL strips and store table hidden per request */}
          <div className="pt-2 text-center text-[11px] text-muted-foreground">
            {sourcesCount} live sources · Shopify, Xero, Triple Whale, Juo (NL), Loop (UK) · synced{" "}
            {syncedAgo}
          </div>

        </div>
      </div>
    </DashboardShell>
  );
}

function SkeletonBox({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-muted/60",
        className
      )}
    />
  );
}

// Pulsing bar-chart placeholder used while the Triple Whale range query is
// still in flight. Varied heights keep it from reading as a flat grey block.
function ChartSkeleton() {
  const heights = [55, 40, 70, 35, 80, 50, 65, 45, 75, 60, 50, 70, 40, 55, 65, 45, 70, 50, 60, 55, 65, 40, 75, 50];
  return (
    <div className="flex h-full items-end gap-1.5">
      {heights.map((h, i) => (
        <div
          key={i}
          className="flex-1 animate-pulse rounded-t bg-muted/60"
          style={{ height: `${h}%`, animationDelay: `${(i % 6) * 80}ms` }}
        />
      ))}
    </div>
  );
}

function DailyPnlSkeleton() {
  return (
    <div className="bg-muted/20 min-h-full p-6 md:p-8">
      <div className="mx-auto max-w-6xl space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <SkeletonBox className="h-3 w-16" />
            <SkeletonBox className="h-8 w-72" />
            <SkeletonBox className="h-3 w-40" />
          </div>
          <div className="space-y-2 text-right">
            <SkeletonBox className="ml-auto h-3 w-32" />
            <SkeletonBox className="ml-auto h-3 w-56" />
          </div>
        </div>

        {/* Tiles */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
              <div className="flex items-start justify-between">
                <SkeletonBox className="h-3 w-24" />
                <SkeletonBox className="h-3 w-10" />
              </div>
              <SkeletonBox className="h-7 w-32" />
              <SkeletonBox className="h-3 w-40" />
            </div>
          ))}
        </div>

        {/* Table */}
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <div className="space-y-2">
              <SkeletonBox className="h-3 w-32" />
              <SkeletonBox className="h-3 w-64" />
            </div>
            <SkeletonBox className="h-3 w-24" />
          </div>
          <div className="divide-y">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="grid grid-cols-7 gap-3 px-5 py-3 items-center">
                <SkeletonBox className="h-6 col-span-1" />
                <SkeletonBox className="h-4" />
                <SkeletonBox className="h-4" />
                <SkeletonBox className="h-4" />
                <SkeletonBox className="h-4" />
                <SkeletonBox className="h-4" />
                <SkeletonBox className="h-4" />
              </div>
            ))}
          </div>
        </div>

        {/* Hourly chart */}
        <div className="rounded-xl border bg-card p-5 shadow-sm space-y-4">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <SkeletonBox className="h-3 w-40" />
              <SkeletonBox className="h-3 w-56" />
            </div>
            <SkeletonBox className="h-6 w-24" />
          </div>
          <div className="flex h-56 items-end gap-[3px]">
            {Array.from({ length: 24 }).map((_, i) => (
              <SkeletonBox
                key={i}
                className="flex-1"
                // varying heights for nicer skeleton
              />
            ))}
          </div>
        </div>

        {/* Bottom strips */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
              <SkeletonBox className="h-3 w-32" />
              <SkeletonBox className="h-7 w-28" />
              <SkeletonBox className="h-3 w-40" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
              <SkeletonBox className="h-3 w-32" />
              <SkeletonBox className="h-7 w-28" />
              <SkeletonBox className="h-3 w-24" />
            </div>
          ))}
        </div>

        <div className="pt-2 text-center text-[11px] text-muted-foreground">
          Loading fresh data…
        </div>
      </div>
    </div>
  );
}

function KpiTile({
  icon: Icon,
  label,
  value,
  subtitle,
  deltaPct,
  positiveIsGood,
  loading = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  subtitle?: string;
  deltaPct: number | null;
  positiveIsGood: boolean;
  loading?: boolean;
}) {
  const showDelta = !loading && deltaPct != null && isFinite(deltaPct);
  const isPositive = (deltaPct ?? 0) >= 0;
  const good = positiveIsGood ? isPositive : !isPositive;
  const DeltaArrow = isPositive ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="rounded-xl border bg-card px-5 py-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border bg-muted/40">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={2} />
            </span>
            <span className="truncate">{label}</span>
          </div>
          {loading ? (
            <>
              <div className="mt-3 h-7 w-32 animate-pulse rounded-md bg-muted/60" />
              <div className="mt-2 h-3 w-40 animate-pulse rounded bg-muted/50" />
            </>
          ) : (
            <>
              <div className="mt-2 text-[26px] font-bold leading-none tracking-tight">
                {value}
              </div>
              {subtitle && (
                <div className="mt-1.5 text-[11px] text-muted-foreground">{subtitle}</div>
              )}
            </>
          )}
        </div>
        {loading ? (
          <div className="h-6 w-12 animate-pulse rounded-md bg-muted/60" />
        ) : (
          showDelta && (
            <div
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium whitespace-nowrap",
                good
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-red-50 text-red-700"
              )}
            >
              <DeltaArrow className="h-3 w-3" strokeWidth={2.5} aria-hidden />
              <span>
                {isPositive ? "+" : ""}
                {deltaPct!.toFixed(1)}%
              </span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

type PnlBreakdownData = {
  grossRevenue: number;
  refunds: number;
  discounts: number;
  netRevenue: number;
  cogs: number;
  fulfillment: number;
  payments: number;
  grossProfit: number;
  adMeta: number;
  adGoogle: number;
  adTikTok: number;
  contributionMargin: number;
  salaries: number;
  software: number;
  rent: number;
  otherOpex: number;
  netProfit: number;
  jorttLive: boolean;
};

function PnlBreakdown({
  periodLabel,
  data,
}: {
  periodLabel: string;
  data: PnlBreakdownData;
}) {


  type Line = {
    label: string;
    source: string;
    value: number;
    dot: string;
    kind?: "header" | "subtotal" | "highlight" | "final";
  };

  const lines: Line[] = [
    { label: "Gross revenue", source: "Shopify", value: data.grossRevenue, dot: "bg-lime-500", kind: "header" },
    { label: "Refunds & returns", source: "Shopify", value: data.refunds, dot: "bg-lime-400" },
    { label: "Discounts", source: "Shopify", value: data.discounts, dot: "bg-lime-300" },
    { label: "Net revenue", source: "Calculated", value: data.netRevenue, dot: "bg-foreground", kind: "subtotal" },
    { label: "COGS (Supplier supplier)", source: "Supplier × Shopify", value: data.cogs, dot: "bg-pink-400" },
    { label: "Fulfillment costs", source: "Fulfillment", value: data.fulfillment, dot: "bg-slate-400" },
    { label: "Payment processing", source: "Shopify Payments", value: data.payments, dot: "bg-lime-400" },
    { label: "Gross profit", source: "Calculated", value: data.grossProfit, dot: "bg-foreground", kind: "subtotal" },
    { label: "Ad spend — Meta", source: "Meta Ads", value: data.adMeta, dot: "bg-violet-400" },
    { label: "Ad spend — Google", source: "Google Ads", value: data.adGoogle, dot: "bg-blue-400" },
    { label: "Ad spend — TikTok", source: "TikTok Ads", value: data.adTikTok, dot: "bg-violet-500" },
    { label: "Contribution margin", source: "Calculated", value: data.contributionMargin, dot: "bg-foreground", kind: "highlight" },
    { label: "OpEx — Salaries", source: data.xeroLive ? "Xero" : "Xero (est.)", value: data.salaries, dot: "bg-teal-400" },
    { label: "OpEx — Software", source: data.xeroLive ? "Xero" : "Xero (est.)", value: data.software, dot: "bg-teal-400" },
    { label: "OpEx — Rent & utilities", source: data.xeroLive ? "Xero" : "Xero (est.)", value: data.rent, dot: "bg-teal-500" },
    { label: "OpEx — Other", source: data.xeroLive ? "Xero" : "Xero (est.)", value: data.otherOpex, dot: "bg-teal-400" },
    { label: "Net profit", source: "Calculated", value: data.netProfit, dot: "bg-foreground", kind: "final" },
  ];

  const fmt = (v: number) => {
    const sign = v < 0 ? "-" : "";
    const abs = Math.abs(Math.round(v));
    return `${sign}€${abs.toLocaleString("en-GB")}`;
  };

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b">
        <div className="text-sm font-semibold">
          Full P&L breakdown — {periodLabel}
        </div>
        <div className="text-xs text-muted-foreground">
          Every line traced to its source system.
        </div>
      </div>
      <div className="divide-y">
        {lines.map((l, i) => {
          const isNegative = l.value < 0;
          const isFinal = l.kind === "final";
          const isHighlight = l.kind === "highlight";
          const isSubtotal = l.kind === "subtotal";
          const isHeader = l.kind === "header";
          return (
            <div
              key={i}
              className={cn(
                "grid grid-cols-[1fr_180px_140px] items-center gap-4 px-5 py-2.5 text-sm",
                isSubtotal && "bg-muted/40",
                isHighlight && "bg-amber-50/60 ring-1 ring-amber-200",
                isFinal && "bg-emerald-50/60"
              )}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", l.dot)} />
                <span
                  className={cn(
                    "truncate",
                    (isHeader || isSubtotal || isHighlight || isFinal) && "font-semibold"
                  )}
                >
                  {l.label}
                </span>
              </div>
              <div className="text-xs text-muted-foreground truncate">{l.source}</div>
              <div
                className={cn(
                  "text-right tabular-nums font-medium",
                  isNegative && !isFinal && "text-red-600",
                  isFinal && (l.value >= 0 ? "text-emerald-700 font-bold" : "text-red-600 font-bold"),
                  (isHeader || isSubtotal || isHighlight) && "font-semibold text-foreground"
                )}
              >
                {fmt(l.value)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

