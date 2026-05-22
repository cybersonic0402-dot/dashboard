import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { getDashboardData } from "@/server/dashboard.functions";
import { setAppSetting } from "@/server/manual-data.functions";
import {
  Briefcase, TrendingUp, Wallet, Building2, Info, Sliders,
  DollarSign, Repeat, UserMinus, Star, Users, Pencil,
} from "lucide-react";

// Inline Instagram glyph — lucide-react 1.9.0 doesn't export an Instagram
// icon, so we draw it: rounded-square camera body, lens circle, flash dot.
function InstagramGlyph({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  );
}

export const Route = createFileRoute("/pillars/valuation")({
  head: () => ({ meta: [{ title: "Business Valuation — Zapply" }] }),
  component: ValuationPage,
});

const DASH = "—";

function fmtEUR(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return DASH;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}€${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}€${(abs / 1000).toFixed(0)}k`;
  return `${sign}€${Math.round(abs).toLocaleString()}`;
}
function fmtPct(n: number | null | undefined, digits = 1) {
  if (n == null || !Number.isFinite(n)) return DASH;
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function SkeletonBox({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-neutral-200/70 ${className}`} />;
}

function ValuationSkeleton() {
  return (
    <div className="p-6 space-y-4">
      <SkeletonBox className="h-8 w-64" />
      <SkeletonBox className="h-4 w-96" />
      <SkeletonBox className="h-40 mt-6" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4 mt-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBox key={i} className="h-40" />
        ))}
      </div>
      <SkeletonBox className="h-56 mt-3" />
      <SkeletonBox className="h-72 mt-3" />
    </div>
  );
}

// ─── DERIVATION ────────────────────────────────────────────────────────────
// Every input below is pulled from a real cached source. When a source is
// missing the corresponding signal is null, and downstream the affected
// valuation method dims out — no synthetic values.
type DerivedInputs = {
  ttmRevenue: number | null;
  monthsCovered: number;
  annualizedFromPartial: boolean;
  ttmEbitda: number | null;
  ttmNetProfit: number | null;
  grossMarginPct: number | null;
  annualMRR: number | null;
  subscriptionShare: number | null; // 0..1
  growthYoYPct: number | null;
  activeCustomers: number | null;
  ltvCacRatio: number | null;
  repeatRatePct: number | null; // 2nd order, mature
  bookValue: number | null;
  cashOnHand: number | null;
  inventoryAtCost: number | null;
};

function deriveInputs(data: any): DerivedInputs {
  // — Shopify monthly revenue (TTM) —
  const monthly: any[] = Array.isArray(data?.shopifyMonthly) ? data.shopifyMonthly : [];
  const months = monthly.slice(-12);
  const months_full = months.filter((m: any) => Number(m?.revenue ?? 0) > 0);
  const sumRev = months_full.reduce(
    (s: number, m: any) => s + Number(m?.revenue ?? 0),
    0,
  );
  const monthsCovered = months_full.length;
  let ttmRevenue: number | null = null;
  let annualizedFromPartial = false;
  if (monthsCovered >= 12) {
    ttmRevenue = sumRev;
  } else if (monthsCovered > 0) {
    // Annualize: scale up to 12-month equivalent. Last month may be MTD —
    // assume calendar-month run rate is roughly the booked total / 1.
    ttmRevenue = (sumRev / monthsCovered) * 12;
    annualizedFromPartial = true;
  }

  // — Triple Whale aggregates —
  const twRows: any[] = Array.isArray(data?.tripleWhale)
    ? data.tripleWhale.filter((m: any) => m?.live !== false)
    : [];
  const twTotal = twRows.reduce(
    (acc: any, m: any) => {
      acc.revenue += Number(m?.revenue ?? 0);
      acc.adSpend += Number(m?.adSpend ?? 0);
      acc.grossProfit += Number(m?.grossProfit ?? 0);
      acc.netProfit += Number(m?.netProfit ?? 0);
      acc.uniqueCustomers += Number(m?.uniqueCustomers ?? 0);
      acc.ncpaWeighted +=
        Number.isFinite(Number(m?.ncpa)) ? Number(m.ncpa) * Number(m?.revenue ?? 0) : 0;
      acc.ltvCpaWeighted +=
        Number.isFinite(Number(m?.ltvCpa)) ? Number(m.ltvCpa) * Number(m?.revenue ?? 0) : 0;
      return acc;
    },
    {
      revenue: 0,
      adSpend: 0,
      grossProfit: 0,
      netProfit: 0,
      uniqueCustomers: 0,
      ncpaWeighted: 0,
      ltvCpaWeighted: 0,
    },
  );

  const grossMarginPct =
    twTotal.revenue > 0 ? (twTotal.grossProfit / twTotal.revenue) * 100 : null;

  // — TTM Xero OpEx (sum 6 buckets across all available months) —
  const xero =
    data?.xero && typeof data.xero === "object" && !data.xero.__empty && !data.xero.__error
      ? data.xero
      : null;
  const opexRows: any[] = Array.isArray(xero?.opexByMonth) ? xero.opexByMonth : [];
  const opexCats = ["team", "agencies", "content", "software", "rent", "other"];
  const opexTotal = opexRows
    .slice(-12)
    .reduce(
      (s: number, m: any) =>
        s + opexCats.reduce((a, k) => a + Number((m as any)?.[k] ?? 0), 0),
      0,
    );
  // Scale OpEx the same way as revenue when we have partial data
  const opexAnnualized =
    opexRows.length > 0 && opexRows.length < 12
      ? (opexTotal / opexRows.length) * 12
      : opexTotal;

  // — TTM EBITDA = Revenue − COGS − OpEx − Ad spend —
  // COGS prefers TW's grossProfit-based COGS (revenue − grossProfit). Falls
  // back to the standard 45% heuristic when TW grossProfit is absent.
  let ttmEbitda: number | null = null;
  if (ttmRevenue != null && ttmRevenue > 0) {
    const cogs =
      twTotal.revenue > 0 && twTotal.grossProfit > 0
        ? (1 - twTotal.grossProfit / twTotal.revenue) * ttmRevenue
        : ttmRevenue * 0.45;
    const adSpendShare = twTotal.revenue > 0 ? twTotal.adSpend / twTotal.revenue : 0;
    const adSpendAnnual = ttmRevenue * adSpendShare;
    ttmEbitda = ttmRevenue - cogs - opexAnnualized - adSpendAnnual;
  }

  // — Xero net profit (real, year-to-date sum) —
  const npByMonth = xero?.netProfitByMonth ?? null;
  let ttmNetProfit: number | null = null;
  if (npByMonth && typeof npByMonth === "object") {
    const vals = Object.values(npByMonth) as any[];
    const numeric = vals.filter((v) => Number.isFinite(Number(v))).map((v) => Number(v));
    const sum = numeric.reduce((s, v) => s + v, 0);
    if (numeric.length > 0) ttmNetProfit = sum;
  }

  // — Subscriptions (Juo + Loop) —
  const juo = Array.isArray(data?.juo) ? data.juo : [];
  const loop = Array.isArray(data?.loop) ? data.loop : [];
  const subRows = [...juo, ...loop].filter((m: any) => m?.live !== false);
  const totalMRR = subRows.reduce(
    (s: number, m: any) =>
      s + Number(m?.mrr ?? 0) * Number(m?.fxRate ?? 1),
    0,
  );
  const annualMRR = totalMRR > 0 ? totalMRR * 12 : null;
  const subscriptionShare =
    annualMRR != null && ttmRevenue && ttmRevenue > 0
      ? Math.min(1, annualMRR / ttmRevenue)
      : null;

  // — YoY growth — prefer 12mo vs prior 12mo when we have it; else MoM
  // compounded annual (sensible only when 3+ months exist).
  let growthYoYPct: number | null = null;
  if (monthly.length >= 24) {
    const recent12 = monthly.slice(-12).reduce(
      (s: number, m: any) => s + Number(m?.revenue ?? 0),
      0,
    );
    const prior12 = monthly.slice(-24, -12).reduce(
      (s: number, m: any) => s + Number(m?.revenue ?? 0),
      0,
    );
    if (prior12 > 0) growthYoYPct = ((recent12 - prior12) / prior12) * 100;
  } else if (monthly.length >= 3) {
    // MoM 1v1, compounded over 12 months. Use second-to-last month as
    // current to avoid the MTD partial month biasing the growth rate.
    const idx = monthly.length - 2; // last completed
    const cur = Number(monthly[idx]?.revenue ?? 0);
    const prev = Number(monthly[idx - 1]?.revenue ?? 0);
    if (cur > 0 && prev > 0) {
      const mom = (cur - prev) / prev;
      growthYoYPct = (Math.pow(1 + mom, 12) - 1) * 100;
    }
  }

  // — Active customers (TTM) —
  const activeCustomers = twTotal.uniqueCustomers > 0 ? twTotal.uniqueCustomers : null;

  // — LTV:CAC —
  const ltvCacRatio =
    twTotal.revenue > 0
      ? twTotal.ltvCpaWeighted / twTotal.revenue
      : null;

  // — Repeat rate (2nd order, mature) —
  const funnel = data?.subscriptionRepeatFunnel ?? data?.shopifyRepeatFunnel ?? null;
  const repeatRow = Array.isArray(funnel?.funnel) ? funnel.funnel[1] : null; // 2nd order
  const repeatRatePct =
    repeatRow && Number.isFinite(Number(repeatRow?.rateMature ?? repeatRow?.rate))
      ? Number(repeatRow.rateMature ?? repeatRow.rate)
      : null;

  // — Balance sheet (Xero) —
  const totalAssets = Number.isFinite(Number(xero?.totalAssets))
    ? Number(xero.totalAssets)
    : null;
  const totalLiabilities = Number.isFinite(Number(xero?.totalLiabilities))
    ? Number(xero.totalLiabilities)
    : null;
  const bookValue =
    totalAssets != null && totalLiabilities != null
      ? totalAssets - Math.abs(totalLiabilities)
      : null;

  // — Cash on hand: merged bank+platform (same logic as Forecast/Balance Sheet) —
  const jorttObj =
    data?.jortt && typeof data.jortt === "object" && !data.jortt.__empty && !data.jortt.__error
      ? data.jortt
      : null;
  const xeroBanks: any[] = Array.isArray(xero?.bankAccounts) ? xero.bankAccounts : [];
  const jorttBanks: any[] = Array.isArray(jorttObj?.bankAccounts) ? jorttObj.bankAccounts : [];
  const sumBalance = (rows: any[]) =>
    rows.reduce((s, b) => s + (Number(b?.balance ?? 0) || 0), 0);
  const bankTotal = sumBalance(xeroBanks) + sumBalance(jorttBanks);
  const sp = Array.isArray(data?.shopifyPayouts?.markets) ? data.shopifyPayouts.markets : [];
  const platformTotal =
    sp.reduce(
      (s: number, m: any) =>
        s + Number(m?.pendingBalance ?? 0) + Number(m?.scheduledPayouts ?? 0),
      0,
    ) +
    (Array.isArray(data?.paypalBalances?.accounts)
      ? data.paypalBalances.accounts.reduce((s: number, a: any) => s + Number(a?.balance ?? 0), 0)
      : 0) +
    (Array.isArray(data?.mollieBalances?.accounts)
      ? data.mollieBalances.accounts.reduce((s: number, a: any) => s + Number(a?.balance ?? 0), 0)
      : 0);
  const cashOnHand = bankTotal + platformTotal || (Number(xero?.cashBalance ?? 0) || null);

  // — Inventory at cost (Picqer) —
  const picqer = data?.picqer ?? null;
  const inventoryAtCost =
    picqer && Array.isArray(picqer?.rows)
      ? picqer.rows.reduce(
          (s: number, r: any) =>
            s + Number(r?.pieces ?? 0) * Number(r?.unit_cost_eur ?? 0),
          0,
        ) || null
      : null;

  return {
    ttmRevenue,
    monthsCovered,
    annualizedFromPartial,
    ttmEbitda,
    ttmNetProfit,
    grossMarginPct,
    annualMRR,
    subscriptionShare,
    growthYoYPct,
    activeCustomers,
    ltvCacRatio,
    repeatRatePct,
    bookValue,
    cashOnHand,
    inventoryAtCost,
  };
}

// ─── QUALITY SCORE ─────────────────────────────────────────────────────────
type ScoreSignal = {
  key: string;
  label: string;
  value: number | null;
  display: string;
  score: number | null; // 0..100
  weight: number;
  note: string;
};

function buildQualityScore(inp: DerivedInputs): { signals: ScoreSignal[]; composite: number | null } {
  const ruleOf40 =
    inp.growthYoYPct != null && inp.ttmEbitda != null && inp.ttmRevenue && inp.ttmRevenue > 0
      ? inp.growthYoYPct + (inp.ttmEbitda / inp.ttmRevenue) * 100
      : null;
  const signals: ScoreSignal[] = [
    {
      key: "rule40",
      label: "Rule of 40",
      value: ruleOf40,
      display: ruleOf40 != null ? `${ruleOf40.toFixed(1)}` : DASH,
      score: ruleOf40 == null ? null : Math.max(0, Math.min(100, (ruleOf40 / 40) * 100)),
      weight: 25,
      note: "Growth % + EBITDA margin %. ≥ 40 is healthy.",
    },
    {
      key: "subShare",
      label: "Subscription revenue share",
      value: inp.subscriptionShare,
      display:
        inp.subscriptionShare != null ? `${(inp.subscriptionShare * 100).toFixed(0)}%` : DASH,
      score:
        inp.subscriptionShare == null
          ? null
          : Math.min(100, inp.subscriptionShare * 100 * 2),
      weight: 20,
      note: "Annualized MRR / TTM revenue. Recurring revenue commands higher multiples.",
    },
    {
      key: "repeat",
      label: "Repeat rate (2nd order)",
      value: inp.repeatRatePct,
      display: inp.repeatRatePct != null ? `${inp.repeatRatePct.toFixed(1)}%` : DASH,
      score:
        inp.repeatRatePct == null
          ? null
          : Math.max(0, Math.min(100, (inp.repeatRatePct / 60) * 100)),
      weight: 20,
      note: "Share of cohort returning for a second order. > 35% is strong for DTC.",
    },
    {
      key: "ltvCac",
      label: "LTV / CAC",
      value: inp.ltvCacRatio,
      display: inp.ltvCacRatio != null ? `${inp.ltvCacRatio.toFixed(2)}×` : DASH,
      score:
        inp.ltvCacRatio == null
          ? null
          : inp.ltvCacRatio < 1
            ? 0
            : inp.ltvCacRatio >= 3
              ? 100
              : ((inp.ltvCacRatio - 1) / 2) * 100,
      weight: 20,
      note: "Lifetime value vs new customer acquisition cost. ≥ 3× is the gold standard.",
    },
    {
      key: "grossMargin",
      label: "Gross margin",
      value: inp.grossMarginPct,
      display: inp.grossMarginPct != null ? `${inp.grossMarginPct.toFixed(1)}%` : DASH,
      score:
        inp.grossMarginPct == null
          ? null
          : inp.grossMarginPct < 30
            ? 0
            : inp.grossMarginPct >= 60
              ? 100
              : ((inp.grossMarginPct - 30) / 30) * 100,
      weight: 15,
      note: "Gross profit / revenue. < 30% caps multiples; ≥ 60% earns premium.",
    },
  ];
  // Weighted composite — only signals with non-null scores contribute, and
  // weights are renormalised so a missing signal doesn't drag the overall
  // score to zero.
  const available = signals.filter((s) => s.score != null);
  const totalWeight = available.reduce((s, x) => s + x.weight, 0);
  const composite =
    available.length > 0 && totalWeight > 0
      ? available.reduce((s, x) => s + (x.score as number) * x.weight, 0) / totalWeight
      : null;
  return { signals, composite };
}

// ─── VALUATION METHODS ─────────────────────────────────────────────────────
type Methods = {
  revenue: { low: number | null; mid: number | null; high: number | null; mult: { low: number; mid: number; high: number } };
  ebitda: { low: number | null; mid: number | null; high: number | null; mult: { low: number; mid: number; high: number } };
  dcf: { value: number | null; horizonYears: number; waccPct: number };
  asset: { value: number | null };
  bestFit: { method: string; value: number | null } | null;
};

function buildMethods(
  inp: DerivedInputs,
  composite: number | null,
  overrides: { revMult: number; ebitdaMult: number; dcfGrowthPct: number; waccPct: number },
): Methods {
  const revMultBand = { low: 1.5, mid: 2.5, high: 4.0 };
  const ebitdaMultBand = { low: 4, mid: 6, high: 8 };

  // Revenue multiples — slider override replaces the band's mid when user
  // moves it; low/high still bound the range so the chart of options doesn't
  // collapse to a single number.
  const revMid = overrides.revMult ?? revMultBand.mid;
  const ebitdaMid = overrides.ebitdaMult ?? ebitdaMultBand.mid;

  const rev = inp.ttmRevenue;
  const revenueMethod = {
    low: rev != null ? rev * revMultBand.low : null,
    mid: rev != null ? rev * revMid : null,
    high: rev != null ? rev * revMultBand.high : null,
    mult: { ...revMultBand, mid: revMid },
  };

  const ebitda = inp.ttmEbitda;
  const ebitdaMethod = {
    low: ebitda != null && ebitda > 0 ? ebitda * ebitdaMultBand.low : null,
    mid: ebitda != null && ebitda > 0 ? ebitda * ebitdaMid : null,
    high: ebitda != null && ebitda > 0 ? ebitda * ebitdaMultBand.high : null,
    mult: { ...ebitdaMultBand, mid: ebitdaMid },
  };

  // DCF (5-yr): project EBITDA at the slider growth rate with decay each
  // year, discount at WACC, plus a terminal value using Gordon growth.
  let dcfValue: number | null = null;
  if (ebitda != null && ebitda > 0) {
    const g = (overrides.dcfGrowthPct ?? 15) / 100;
    const wacc = (overrides.waccPct ?? 12) / 100;
    const terminalG = 0.025;
    let pv = 0;
    let yearEbitda = ebitda;
    for (let yr = 1; yr <= 5; yr++) {
      yearEbitda = yearEbitda * (1 + g * Math.pow(0.85, yr - 1)); // growth decays 15% per year
      pv += yearEbitda / Math.pow(1 + wacc, yr);
    }
    const terminal = (yearEbitda * (1 + terminalG)) / (wacc - terminalG);
    pv += terminal / Math.pow(1 + wacc, 5);
    dcfValue = pv;
  }

  // Asset-based: book value (assets − liabilities) + inventory-at-cost
  // surplus when it isn't already booked at full cost in Xero.
  const assetValue =
    inp.bookValue != null
      ? inp.bookValue + (inp.inventoryAtCost ?? 0)
      : (inp.cashOnHand ?? 0) + (inp.inventoryAtCost ?? 0) || null;

  // Best-fit method: lands at low + (high − low) × composite/100 inside the
  // band that has the most data confidence. EBITDA > Revenue when EBITDA is
  // positive; otherwise revenue method takes over.
  let bestFit: { method: string; value: number | null } | null = null;
  if (composite != null) {
    const c = composite / 100;
    if (ebitdaMethod.low != null && ebitdaMethod.high != null && ebitda != null && ebitda > 0) {
      const v = ebitdaMethod.low + (ebitdaMethod.high - ebitdaMethod.low) * c;
      bestFit = { method: `EBITDA × ${(v / (ebitda || 1)).toFixed(1)}×`, value: v };
    } else if (revenueMethod.low != null && revenueMethod.high != null && rev != null) {
      const v = revenueMethod.low + (revenueMethod.high - revenueMethod.low) * c;
      bestFit = { method: `Revenue × ${(v / (rev || 1)).toFixed(1)}×`, value: v };
    }
  }

  return {
    revenue: revenueMethod,
    ebitda: ebitdaMethod,
    dcf: { value: dcfValue, horizonYears: 5, waccPct: overrides.waccPct ?? 12 },
    asset: { value: assetValue },
    bestFit,
  };
}

// ─── PAGE ──────────────────────────────────────────────────────────────────
function ValuationPage() {
  const { user } = useDashboardSession();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [revMult, setRevMult] = useState(2.5);
  const [ebitdaMult, setEbitdaMult] = useState(6);
  const [dcfGrowth, setDcfGrowth] = useState(15);

  useEffect(() => {
    let alive = true;
    getDashboardData()
      .then((d) => alive && setData(d))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const inputs = useMemo(() => deriveInputs(data ?? {}), [data]);
  const { signals, composite } = useMemo(() => buildQualityScore(inputs), [inputs]);
  const methods = useMemo(
    () =>
      buildMethods(inputs, composite, {
        revMult,
        ebitdaMult,
        dcfGrowthPct: dcfGrowth,
        waccPct: 12,
      }),
    [inputs, composite, revMult, ebitdaMult, dcfGrowth],
  );

  if (loading) {
    return (
      <DashboardShell user={user} title="Business Valuation">
        <ValuationSkeleton />
      </DashboardShell>
    );
  }

  // — Hero band: low/mid/high across all methods that produced a number —
  const methodValues: number[] = [];
  if (methods.revenue.low != null) methodValues.push(methods.revenue.low);
  if (methods.revenue.high != null) methodValues.push(methods.revenue.high);
  if (methods.ebitda.low != null) methodValues.push(methods.ebitda.low);
  if (methods.ebitda.high != null) methodValues.push(methods.ebitda.high);
  if (methods.dcf.value != null) methodValues.push(methods.dcf.value);
  if (methods.asset.value != null) methodValues.push(methods.asset.value);
  const bandLow = methodValues.length ? Math.min(...methodValues) : null;
  const bandHigh = methodValues.length ? Math.max(...methodValues) : null;
  const bandMid = methods.bestFit?.value ?? (bandLow != null && bandHigh != null ? (bandLow + bandHigh) / 2 : null);

  return (
    <DashboardShell user={user} title="Business Valuation">
      <div className="bg-neutral-50 min-h-full p-6 md:p-8">
        <div className="mx-auto max-w-6xl space-y-4">
          {/* Header */}
          <div className="flex items-end justify-between">
            <div>
              <div className="text-[12px] font-medium text-neutral-400">Pillar 6</div>
              <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Business Valuation</h1>
              <p className="mt-1 text-[13px] text-neutral-500">
                Range from four valuation methods · quality-score weighted ·{" "}
                {inputs.annualizedFromPartial
                  ? `annualized from ${inputs.monthsCovered} months of data`
                  : "trailing 12 months"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-violet-50 px-2 py-1 text-[11px] font-medium text-violet-700">
                Quality {composite != null ? `${Math.round(composite)}/100` : "—"}
              </span>
            </div>
          </div>

          {/* Hero band */}
          <div className="rounded-xl border bg-card shadow-sm p-6">
            <div className="flex items-start justify-between flex-wrap gap-4">
              <div className="flex items-start gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-md bg-violet-100">
                  <Briefcase className="h-4 w-4 text-violet-700" />
                </div>
                <div>
                  <div className="text-[13px] font-semibold">Estimated business value</div>
                  <div className="mt-0.5 text-[12px] text-neutral-500">
                    Range across Revenue × · EBITDA × · DCF · Asset-based
                  </div>
                </div>
              </div>
              {methods.bestFit && (
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wider text-neutral-400">Best fit</div>
                  <div className="text-[12px] font-medium text-neutral-700">
                    {methods.bestFit.method}
                  </div>
                </div>
              )}
            </div>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">Low</div>
                <div className="mt-1 text-[28px] font-semibold tabular-nums leading-none">{fmtEUR(bandLow)}</div>
                <div className="mt-1 text-[11px] text-neutral-400">Conservative — asset / low multiples</div>
              </div>
              <div className="sm:border-l sm:border-r sm:border-neutral-100 sm:px-6">
                <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">Mid (best fit)</div>
                <div className="mt-1 text-[32px] font-semibold tabular-nums leading-none text-violet-700">
                  {fmtEUR(bandMid)}
                </div>
                <div className="mt-1 text-[11px] text-neutral-400">
                  Score-weighted within method bands
                </div>
              </div>
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">High</div>
                <div className="mt-1 text-[28px] font-semibold tabular-nums leading-none">{fmtEUR(bandHigh)}</div>
                <div className="mt-1 text-[11px] text-neutral-400">Aggressive — high multiples</div>
              </div>
            </div>
          </div>

          {/* Headline metric circles */}
          <MetricCircles data={data} inputs={inputs} onSaved={() => getDashboardData().then(setData)} />

          {/* Method breakdown */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            <MethodCard
              icon={<TrendingUp className="h-4 w-4 text-emerald-700" />}
              tint="emerald"
              label="Revenue multiple"
              formula={`TTM revenue × ${methods.revenue.mult.mid.toFixed(2)}×`}
              source={`${fmtEUR(inputs.ttmRevenue)} TTM`}
              low={methods.revenue.low}
              mid={methods.revenue.mid}
              high={methods.revenue.high}
              hint={`Industry band ${methods.revenue.mult.low}×–${methods.revenue.mult.high}× for DTC`}
            />
            <MethodCard
              icon={<Wallet className="h-4 w-4 text-blue-700" />}
              tint="blue"
              label="EBITDA multiple"
              formula={`TTM EBITDA × ${methods.ebitda.mult.mid.toFixed(2)}×`}
              source={`${fmtEUR(inputs.ttmEbitda)} TTM EBITDA`}
              low={methods.ebitda.low}
              mid={methods.ebitda.mid}
              high={methods.ebitda.high}
              hint={`Industry band ${methods.ebitda.mult.low}×–${methods.ebitda.mult.high}× for DTC`}
              disabled={inputs.ttmEbitda == null || inputs.ttmEbitda <= 0}
              disabledNote="EBITDA must be positive to use this method"
            />
            <MethodCard
              icon={<Sliders className="h-4 w-4 text-amber-700" />}
              tint="amber"
              label="DCF (5-yr)"
              formula={`Growth ${dcfGrowth}% · WACC ${methods.dcf.waccPct}%`}
              source={`Anchored on TTM EBITDA`}
              single={methods.dcf.value}
              hint="Projected cash flows discounted to present"
              disabled={inputs.ttmEbitda == null || inputs.ttmEbitda <= 0}
              disabledNote="Requires positive EBITDA to project forward"
            />
            <MethodCard
              icon={<Building2 className="h-4 w-4 text-neutral-700" />}
              tint="neutral"
              label="Asset-based"
              formula="Total assets − Liabilities + Inventory"
              source={`${fmtEUR(inputs.bookValue)} book value`}
              single={methods.asset.value}
              hint="Floor for negotiations — protects against overvaluation"
            />
          </div>

          {/* Quality scorecard */}
          <div className="rounded-xl border bg-card shadow-sm p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[13px] font-semibold">Quality scorecard</div>
                <div className="mt-0.5 text-[12px] text-neutral-500">
                  Five signals an acquirer weighs · drives where in each band you land
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-neutral-400">Composite</div>
                <div className="mt-0.5 text-[20px] font-semibold tabular-nums">
                  {composite != null ? Math.round(composite) : "—"} / 100
                </div>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {signals.map((s) => (
                <div key={s.key} className="grid grid-cols-[200px_120px_1fr_50px] items-center gap-3 text-[12px]">
                  <div className="text-neutral-700 font-medium">{s.label}</div>
                  <div className="tabular-nums text-neutral-900">{s.display}</div>
                  <div className="h-1.5 rounded-full bg-neutral-100 overflow-hidden">
                    {s.score != null && (
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.max(2, Math.min(100, s.score))}%`,
                          background:
                            s.score >= 70 ? "#10b981" : s.score >= 40 ? "#f59e0b" : "#ef4444",
                        }}
                      />
                    )}
                  </div>
                  <div className="text-right text-[11px] text-neutral-500 tabular-nums">
                    {s.score != null ? `${Math.round(s.score)}` : "—"}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 text-[10px] text-neutral-400">
              Weights — Rule of 40 25% · Subscription 20% · Repeat 20% · LTV/CAC 20% · Gross margin 15%. Missing
              signals are excluded and weights renormalised.
            </div>
          </div>

          {/* Sensitivity sliders */}
          <div className="rounded-xl border bg-card shadow-sm p-5">
            <div className="flex items-start gap-3">
              <Sliders className="h-4 w-4 text-neutral-500 mt-0.5" />
              <div>
                <div className="text-[13px] font-semibold">Sensitivity</div>
                <div className="mt-0.5 text-[12px] text-neutral-500">
                  Drag to override default multipliers · the Hero band updates live
                </div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
              <SliderField
                label="Revenue multiplier"
                value={revMult}
                min={1}
                max={6}
                step={0.1}
                suffix="×"
                onChange={setRevMult}
                defaultValue={2.5}
              />
              <SliderField
                label="EBITDA multiplier"
                value={ebitdaMult}
                min={3}
                max={10}
                step={0.5}
                suffix="×"
                onChange={setEbitdaMult}
                defaultValue={6}
              />
              <SliderField
                label="DCF growth (annual)"
                value={dcfGrowth}
                min={0}
                max={50}
                step={1}
                suffix="%"
                onChange={setDcfGrowth}
                defaultValue={15}
              />
            </div>
          </div>

          {/* Inputs table */}
          <div className="rounded-xl border bg-card shadow-sm">
            <div className="border-b border-neutral-100 p-5">
              <div className="text-[13px] font-semibold">Inputs feeding the valuation</div>
              <div className="mt-0.5 text-[12px] text-neutral-500">
                Every number traces back to a sync — open the linked pillar to verify
              </div>
            </div>
            <table className="w-full text-[13px]">
              <thead className="bg-neutral-50 text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                <tr>
                  <th className="py-2.5 px-5">Metric</th>
                  <th className="py-2.5 px-5">Value</th>
                  <th className="py-2.5 px-5">Source</th>
                </tr>
              </thead>
              <tbody>
                <InputRow label="TTM revenue" value={fmtEUR(inputs.ttmRevenue)} source="Shopify monthly · last 12 months" />
                <InputRow label="TTM EBITDA" value={fmtEUR(inputs.ttmEbitda)} source="Shopify revenue − COGS − Xero OpEx − TW ad spend" />
                <InputRow label="TTM net profit (Xero)" value={fmtEUR(inputs.ttmNetProfit)} source="xero.netProfitByMonth" />
                <InputRow label="Gross margin" value={inputs.grossMarginPct != null ? `${inputs.grossMarginPct.toFixed(1)}%` : DASH} source="Triple Whale grossProfit / revenue" />
                <InputRow label="Annualized MRR" value={fmtEUR(inputs.annualMRR)} source="Juo + Loop · MRR × 12" />
                <InputRow label="Subscription share" value={inputs.subscriptionShare != null ? `${(inputs.subscriptionShare * 100).toFixed(1)}%` : DASH} source="MRR×12 / TTM revenue" />
                <InputRow label="YoY growth (or compounded MoM fallback)" value={fmtPct(inputs.growthYoYPct)} source={inputs.monthsCovered >= 24 ? "Shopify monthly · 12m vs prior 12m" : "Shopify monthly · last-month MoM compounded (only " + inputs.monthsCovered + "mo of data)"} />
                <InputRow label="Active customers (TTM)" value={inputs.activeCustomers != null ? inputs.activeCustomers.toLocaleString() : DASH} source="Triple Whale · sum uniqueCustomers" />
                <InputRow label="LTV / CAC" value={inputs.ltvCacRatio != null ? `${inputs.ltvCacRatio.toFixed(2)}×` : DASH} source="Triple Whale · revenue-weighted ltvCpa" />
                <InputRow label="Repeat rate (2nd order)" value={inputs.repeatRatePct != null ? `${inputs.repeatRatePct.toFixed(1)}%` : DASH} source="Subscription / Shopify repeat funnel · mature cohorts" />
                <InputRow label="Book value (assets − liabilities)" value={fmtEUR(inputs.bookValue)} source="Xero balance sheet" />
                <InputRow label="Cash on hand (merged)" value={fmtEUR(inputs.cashOnHand)} source="Xero + Jortt banks + platform pending" />
                <InputRow label="Inventory at cost" value={fmtEUR(inputs.inventoryAtCost)} source="Picqer · pieces × unit_cost_eur" />
              </tbody>
            </table>
          </div>

          {/* Comparables footer */}
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-[12px] text-neutral-600 flex items-start gap-2">
            <Info className="h-4 w-4 text-neutral-400 mt-0.5 shrink-0" />
            <div>
              <span className="font-semibold">Industry context</span> — DTC supplement / consumer brands typically
              trade at <strong>2.5×–4× revenue</strong> and <strong>5×–7× EBITDA</strong>, with subscription-heavy
              books at the top of those bands and one-time-purchase brands at the bottom. DCF assumptions: 5-year
              horizon, 12% WACC, terminal growth 2.5%, growth decays 15%/year toward terminal.
            </div>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}

// ─── HEADLINE METRIC CIRCLES ───────────────────────────────────────────────
// A row of compact circular stat badges. Four are data-backed (Revenue, MRR,
// EBITDA, Churn); three are operator-supplied (Trustpilot reviews, headcount
// for revenue/employee, Instagram followers) and persist to app_settings via
// an inline click-to-edit. External metrics show "—" with a pencil until set.
function MetricCircles({
  data,
  inputs,
  onSaved,
}: {
  data: any;
  inputs: DerivedInputs;
  onSaved: () => void;
}) {
  // MRR + churn from the subscription markets (Juo + Loop), EUR-normalised.
  const subs = [
    ...(Array.isArray(data?.juo) ? data.juo : []),
    ...(Array.isArray(data?.loop) ? data.loop : []),
  ].filter((m: any) => m?.live !== false);
  const mrr = subs.reduce(
    (s: number, m: any) => s + Number(m?.mrr ?? 0) * Number(m?.fxRate ?? 1),
    0,
  );
  const totalActive = subs.reduce((s: number, m: any) => s + Number(m?.activeSubs ?? 0), 0);
  const totalChurned = subs.reduce((s: number, m: any) => s + Number(m?.churnedThisMonth ?? 0), 0);
  const churnPct =
    totalActive + totalChurned > 0 ? (totalChurned / (totalActive + totalChurned)) * 100 : null;

  // Operator-supplied metrics live under a single app_settings key.
  const settings = data?.manual?.settings ?? {};
  const cm = (settings.company_metrics ?? {}) as Record<string, number | undefined>;
  const headcount = Number(cm.headcount ?? 0) || null;
  const trustpilotReviews = cm.trustpilot_reviews != null ? Number(cm.trustpilot_reviews) : null;
  const trustpilotScore = cm.trustpilot_score != null ? Number(cm.trustpilot_score) : null;
  // Instagram: prefer the LIVE synced count (data.instagram.followers,
  // refreshed via the sync button) over a manually-entered fallback.
  const liveIg = data?.instagram?.followers != null ? Number(data.instagram.followers) : null;
  const instagram = liveIg ?? (cm.instagram_followers != null ? Number(cm.instagram_followers) : null);
  const igLive = liveIg != null;

  const revPerEmployee =
    inputs.ttmRevenue != null && headcount && headcount > 0 ? inputs.ttmRevenue / headcount : null;

  const compact = (n: number | null | undefined, prefix = "") => {
    if (n == null || !Number.isFinite(n)) return null;
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `${prefix}${(n / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${prefix}${(n / 1000).toFixed(0)}k`;
    return `${prefix}${Math.round(n)}`;
  };

  async function saveMetric(key: string, value: number) {
    const next = { ...cm, [key]: value };
    await setAppSetting({ data: { key: "company_metrics", value: next } });
    onSaved();
  }

  return (
    <div className="rounded-xl border bg-card shadow-sm p-5">
      <div className="text-[12px] font-medium text-neutral-500 mb-4">Headline metrics</div>
      <div className="flex flex-wrap items-start justify-center gap-x-6 gap-y-5 sm:justify-between">
        <MetricCircle
          icon={<DollarSign className="h-4 w-4" />}
          accent="emerald"
          label="Revenue (TTM)"
          value={compact(inputs.ttmRevenue, "€")}
        />
        <MetricCircle
          icon={<Repeat className="h-4 w-4" />}
          accent="violet"
          label="MRR"
          value={compact(mrr, "€")}
        />
        <MetricCircle
          icon={<TrendingUp className="h-4 w-4" />}
          accent="blue"
          label="EBITDA (TTM)"
          value={compact(inputs.ttmEbitda, "€")}
        />
        <MetricCircle
          icon={<UserMinus className="h-4 w-4" />}
          accent="amber"
          label="Churn / mo"
          value={churnPct != null ? `${churnPct.toFixed(1)}%` : null}
        />
        <MetricCircle
          icon={<Star className="h-4 w-4" />}
          accent="green"
          label={trustpilotScore != null ? `Trustpilot ${trustpilotScore.toFixed(1)}★` : "Trustpilot"}
          value={trustpilotReviews != null ? compact(trustpilotReviews) : null}
          editable
          editLabel="Trustpilot reviews"
          onSave={(v) => saveMetric("trustpilot_reviews", v)}
          secondaryEditLabel="Score (0–5)"
          onSaveSecondary={(v) => saveMetric("trustpilot_score", v)}
        />
        <MetricCircle
          icon={<Users className="h-4 w-4" />}
          accent="sky"
          label="Rev / employee"
          value={revPerEmployee != null ? compact(revPerEmployee, "€") : null}
          hint={headcount ? `${headcount} staff` : "set headcount"}
          editable
          editLabel="Headcount"
          onSave={(v) => saveMetric("headcount", v)}
        />
        <MetricCircle
          icon={<InstagramGlyph className="h-4 w-4" />}
          accent="pink"
          label="Instagram"
          value={instagram != null ? compact(instagram) : null}
          hint={igLive ? "live · @zapply_" : "manual — sync on Sync page"}
          editable={!igLive}
          editLabel="Instagram followers"
          onSave={(v) => saveMetric("instagram_followers", v)}
        />
      </div>
    </div>
  );
}

function MetricCircle({
  icon,
  accent,
  label,
  value,
  hint,
  editable,
  editLabel,
  onSave,
  secondaryEditLabel,
  onSaveSecondary,
}: {
  icon: React.ReactNode;
  accent: "emerald" | "violet" | "blue" | "amber" | "green" | "sky" | "pink";
  label: string;
  value: string | null;
  hint?: string;
  editable?: boolean;
  editLabel?: string;
  onSave?: (v: number) => void | Promise<void>;
  secondaryEditLabel?: string;
  onSaveSecondary?: (v: number) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draft2, setDraft2] = useState("");
  const [saving, setSaving] = useState(false);

  const ring: Record<string, string> = {
    emerald: "ring-emerald-200 text-emerald-700 bg-emerald-50",
    violet: "ring-violet-200 text-violet-700 bg-violet-50",
    blue: "ring-blue-200 text-blue-700 bg-blue-50",
    amber: "ring-amber-200 text-amber-700 bg-amber-50",
    green: "ring-green-200 text-green-700 bg-green-50",
    sky: "ring-sky-200 text-sky-700 bg-sky-50",
    pink: "ring-pink-200 text-pink-700 bg-pink-50",
  };

  async function commit() {
    setSaving(true);
    try {
      const n = parseFloat(draft.replace(/[^\d.-]/g, ""));
      if (Number.isFinite(n) && onSave) await onSave(n);
      if (secondaryEditLabel && onSaveSecondary && draft2.trim() !== "") {
        const n2 = parseFloat(draft2.replace(/[^\d.-]/g, ""));
        if (Number.isFinite(n2)) await onSaveSecondary(n2);
      }
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex w-[88px] flex-col items-center text-center">
      <button
        type="button"
        disabled={!editable}
        onClick={() => editable && setEditing(true)}
        className={`relative grid h-[68px] w-[68px] place-items-center rounded-full ring-2 ${ring[accent]} ${editable ? "cursor-pointer hover:brightness-95" : "cursor-default"}`}
        title={editable ? `Click to set ${editLabel}` : undefined}
      >
        <div className="absolute top-2 opacity-70">{icon}</div>
        <div className="mt-3 text-[14px] font-semibold tabular-nums leading-none">
          {value ?? <span className="text-neutral-300">—</span>}
        </div>
        {editable && value == null && (
          <Pencil className="absolute bottom-2 right-2 h-2.5 w-2.5 opacity-50" />
        )}
      </button>
      <div className="mt-1.5 text-[10px] font-medium text-neutral-500 leading-tight">{label}</div>
      {hint && <div className="text-[9px] text-neutral-400">{hint}</div>}

      {editing && (
        <div className="mt-2 w-[120px] rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
          <div className="text-[10px] font-medium text-neutral-500 mb-1">{editLabel}</div>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            placeholder="e.g. 1240"
            className="w-full rounded border border-neutral-200 px-1.5 py-1 text-[11px] tabular-nums"
          />
          {secondaryEditLabel && (
            <>
              <div className="text-[10px] font-medium text-neutral-500 mb-1 mt-2">{secondaryEditLabel}</div>
              <input
                value={draft2}
                onChange={(e) => setDraft2(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commit()}
                placeholder="e.g. 4.6"
                className="w-full rounded border border-neutral-200 px-1.5 py-1 text-[11px] tabular-nums"
              />
            </>
          )}
          <div className="mt-2 flex gap-1">
            <button
              onClick={commit}
              disabled={saving}
              className="flex-1 rounded bg-neutral-900 px-2 py-1 text-[10px] font-medium text-white disabled:opacity-50"
            >
              {saving ? "…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded border border-neutral-200 px-2 py-1 text-[10px] text-neutral-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SUB-COMPONENTS ────────────────────────────────────────────────────────
function MethodCard({
  icon,
  tint,
  label,
  formula,
  source,
  low,
  mid,
  high,
  single,
  hint,
  disabled,
  disabledNote,
}: {
  icon: React.ReactNode;
  tint: "emerald" | "blue" | "amber" | "neutral";
  label: string;
  formula: string;
  source: string;
  low?: number | null;
  mid?: number | null;
  high?: number | null;
  single?: number | null;
  hint: string;
  disabled?: boolean;
  disabledNote?: string;
}) {
  const ringClass = {
    emerald: "border-emerald-100",
    blue: "border-blue-100",
    amber: "border-amber-100",
    neutral: "border-neutral-200",
  }[tint];
  const iconBg = {
    emerald: "bg-emerald-50",
    blue: "bg-blue-50",
    amber: "bg-amber-50",
    neutral: "bg-neutral-100",
  }[tint];
  return (
    <div className={`rounded-xl border bg-card shadow-sm p-4 ${ringClass}`}>
      <div className="flex items-start gap-2.5">
        <div className={`grid h-8 w-8 place-items-center rounded-md ${iconBg}`}>{icon}</div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">{label}</div>
          <div className="mt-0.5 text-[11px] text-neutral-500">{formula}</div>
        </div>
      </div>
      {disabled ? (
        <div className="mt-4 rounded-md bg-neutral-50 px-3 py-3 text-[11px] text-neutral-500">
          {disabledNote ?? "Not enough data for this method."}
        </div>
      ) : single != null ? (
        <div className="mt-4">
          <div className="text-[22px] font-semibold tabular-nums">{fmtEUR(single)}</div>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-[9px] uppercase tracking-wider text-neutral-400">Low</div>
            <div className="text-[14px] font-semibold tabular-nums">{fmtEUR(low)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider text-neutral-400">Mid</div>
            <div className="text-[16px] font-semibold tabular-nums">{fmtEUR(mid)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider text-neutral-400">High</div>
            <div className="text-[14px] font-semibold tabular-nums">{fmtEUR(high)}</div>
          </div>
        </div>
      )}
      <div className="mt-3 text-[10px] text-neutral-400">{source}</div>
      <div className="mt-1 text-[10px] text-neutral-400">{hint}</div>
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
  defaultValue,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (v: number) => void;
  defaultValue: number;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] font-medium text-neutral-500">{label}</div>
        <div className="text-[12px] tabular-nums font-semibold">
          {value.toFixed(step < 1 ? 1 : 0)}
          {suffix}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-3 w-full accent-violet-600"
      />
      <button
        type="button"
        onClick={() => onChange(defaultValue)}
        className="mt-2 text-[10px] text-neutral-400 underline hover:text-neutral-600"
      >
        Reset to {defaultValue}
        {suffix}
      </button>
    </div>
  );
}

function InputRow({ label, value, source }: { label: string; value: string; source: string }) {
  return (
    <tr className="border-b border-neutral-100 last:border-0">
      <td className="py-2.5 px-5 font-medium text-neutral-800">{label}</td>
      <td className="py-2.5 px-5 tabular-nums text-neutral-900">{value}</td>
      <td className="py-2.5 px-5 text-[12px] text-neutral-500">{source}</td>
    </tr>
  );
}
