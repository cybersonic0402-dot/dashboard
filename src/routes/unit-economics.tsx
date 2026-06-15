import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { useDashboard } from "@/hooks/api";
import {
  Calculator,
  Package,
  Receipt,
  Truck,
  RotateCcw,
  CreditCard,
  Boxes,
  Target,
  Gauge,
  TrendingUp,
  TrendingDown,
  Info,
  Activity,
} from "lucide-react";

export const Route = createFileRoute("/unit-economics")({
  head: () => ({ meta: [{ title: "Unit Economics Calculator — Zapply" }] }),
  component: UnitEconomicsPage,
});

// ─────────────────────────────────────────────────────────────────────────────
// Model — one editable set of assumptions per market. Mirrors the
// "Zapply Unit Economics Calculator" workbook (tabs: NL & BE / UK / USA),
// extended to show 3- / 6- / 12-month LTV contribution margins side by side
// (the workbook only carried a single horizon per market).
// Soft-green cells in the sheet = inputs here; bright-green = calculated.
// ─────────────────────────────────────────────────────────────────────────────
type MarketInputs = {
  aov: number; // NC AOV incl. tax (B2)
  cogsPct: number; // COST OF GOODS, share of AOV (C6)
  merchantPct: number; // MERCHANT FEES, share of AOV (C7)
  merchantFixed: number; // fixed per-order fee added to merchant fees (+0.3 in NL/USA)
  returnsPct: number; // CUSTOMER RETURNS, share of AOV (C8)
  shipping: number; // SHIPPING COSTS per order (B9)
  fulfilment: number; // FULFILLMENT COST PER UNIT (B10)
  ltv3: number; // 3-month LTV uplift — repeat revenue on top of first order
  ltv6: number; // 6-month LTV uplift
  ltv12: number; // 12-month LTV uplift
  delayedMultiplier: number; // Delayed Purchase Multiplier — 1DC vs 28DC gap (B15)
};

type MarketMeta = {
  id: string;
  name: string;
  flag: string; // flagcdn country code
  currency: string;
  taxLabel: string;
  taxRate: number;
  defaults: MarketInputs;
};

// LTV uplift seeds: the horizon present in the workbook is the real value;
// the other two are placeholder curves the client should overwrite with their
// own cohort LTV (the green cells are editable). NL 6-mo = 1.30, UK 4-mo = 1.29.
const MARKETS: MarketMeta[] = [
  {
    id: "nl-be",
    name: "NL & BE",
    flag: "nl",
    currency: "EUR",
    taxLabel: "BTW",
    taxRate: 0.09,
    defaults: {
      aov: 78,
      cogsPct: 0.1594,
      merchantPct: 0.0122,
      merchantFixed: 0.3,
      returnsPct: 0.017,
      shipping: 5.49,
      fulfilment: 0,
      ltv3: 0.9,
      ltv6: 1.3, // workbook value
      ltv12: 1.8,
      delayedMultiplier: 0.2,
    },
  },
  {
    id: "uk",
    name: "UK",
    flag: "gb",
    currency: "GBP",
    taxLabel: "VAT",
    taxRate: 0.2,
    defaults: {
      aov: 77,
      cogsPct: 0.145,
      merchantPct: 0.0287,
      merchantFixed: 0,
      returnsPct: 0.014,
      shipping: 4.58,
      fulfilment: 0,
      ltv3: 1.0,
      ltv6: 1.5, // workbook carried 4-month = 1.29, sits between 3 & 6 mo
      ltv12: 2.0,
      delayedMultiplier: 0.2,
    },
  },
  {
    id: "usa",
    name: "USA",
    flag: "us",
    currency: "USD",
    taxLabel: "Sales tax",
    taxRate: 0.07,
    defaults: {
      aov: 81,
      cogsPct: 0.155,
      merchantPct: 0.035,
      merchantFixed: 0.3,
      returnsPct: 0.018,
      shipping: 7.26,
      fulfilment: 0,
      ltv3: 0.7,
      ltv6: 1.1,
      ltv12: 1.6,
      delayedMultiplier: 0.2,
    },
  },
];

const DASH = "—";

function money(n: number | null | undefined, currency: string) {
  if (n == null || !Number.isFinite(n)) return DASH;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return n.toFixed(2);
  }
}
function x2(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return DASH;
  return `${n.toFixed(2)}×`;
}
function pct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return DASH;
  return `${(n * 100).toFixed(1)}%`;
}

// All derived numbers from a market's assumptions — pure, recomputed on edit.
function compute(m: MarketMeta, i: MarketInputs) {
  const tax = i.aov * m.taxRate;
  const cogs = i.aov * i.cogsPct;
  const merchant = i.aov * i.merchantPct + i.merchantFixed;
  const returns = i.aov * i.returnsPct;
  const totalCost = tax + cogs + merchant + returns + i.shipping + i.fulfilment;
  const pctCost = i.aov > 0 ? totalCost / i.aov : 0;
  const unitMargin = i.aov - totalCost; // first-order contribution before CAC

  // First-purchase break-even ROAS = 1 / (1 − cost%). Below/above are ±20%.
  const breakeven = pctCost < 1 ? 1 / (1 - pctCost) : Infinity;
  const scenarios = [
    { key: "below", label: "20% Below Breakeven", roas: breakeven * 0.8 },
    { key: "be", label: "First Purchase Breakeven", roas: breakeven },
    { key: "above", label: "20% Above Breakeven", roas: breakeven * 1.2 },
  ].map((s) => {
    const cac = s.roas > 0 ? i.aov / s.roas : null;
    // Contribution after acquiring the customer at that CAC.
    const firstPurchaseCM = cac == null ? null : i.aov * (1 - pctCost) - cac;
    // Same, but crediting the repeat-revenue uplift over each LTV horizon.
    const ltvCM = (uplift: number) => (cac == null ? null : unitMargin * (1 + uplift) - cac);
    return {
      ...s,
      cac,
      firstPurchaseCM,
      ltvCM3: ltvCM(i.ltv3),
      ltvCM6: ltvCM(i.ltv6),
      ltvCM12: ltvCM(i.ltv12),
    };
  });

  // 28-day-click vs 1-day-click view. The delayed-purchase multiplier discounts
  // the 1DC target since fewer conversions are attributed in the 1-day window.
  const roas28 = breakeven;
  const roas1 = roas28 / (1 + i.delayedMultiplier);
  const cpa28 = roas28 > 0 ? i.ltv6 / roas28 : null;
  const cpa1 = roas1 > 0 ? i.ltv6 / roas1 : null;

  return {
    lines: { tax, cogs, merchant, returns, shipping: i.shipping, fulfilment: i.fulfilment },
    totalCost,
    pctCost,
    unitMargin,
    breakeven,
    scenarios,
    roas28,
    roas1,
    cpa28,
    cpa1,
  };
}

// Map calculator tabs → live cohort market codes from /api/dashboard.
const LIVE_CODE: Record<string, string> = { "nl-be": "NL", uk: "UK", usa: "US" };

// Real 3 / 6 / 12-month LTV contribution margin from the dashboard's cohort
// engine (retentionEconomics). Cohort LTV is gross revenue per customer within
// N days of first order; contribution = LTV × variable-margin% − CAC.
function computeLive(m: any | null) {
  if (!m) return null;
  const variablePct =
    (Number(m.cogsPct) || 0) +
    (Number(m.shippingPct) || 0) +
    (Number(m.paymentFeePct) || 0) +
    (Number(m.fulfilmentPct) || 0);
  const marginFrac =
    variablePct > 0 && variablePct < 100
      ? 1 - variablePct / 100
      : m.breakEvenRoasDelivery
        ? 1 / m.breakEvenRoasDelivery
        : null;
  const cac = Number(m.cac) || null;
  const horizon = (ltv: number | null, mature: number) => {
    const contrib = ltv != null && marginFrac != null ? ltv * marginFrac : null;
    const cm = contrib != null ? (cac != null ? contrib - cac : contrib) : null;
    const ratio = ltv != null && cac && cac > 0 ? ltv / cac : null;
    return { ltv, mature, contrib, cm, ratio };
  };
  const rows = [
    { label: "3-month", ...horizon(m.ltv90 ?? null, Number(m.matureCustomers90 ?? 0)) },
    { label: "6-month", ...horizon(m.ltv180 ?? null, Number(m.matureCustomers180 ?? 0)) },
    { label: "12-month", ...horizon(m.ltv365 ?? null, Number(m.matureCustomers365 ?? 0)) },
  ];
  const hasAny = rows.some((r) => r.ltv != null);
  return {
    currency: String(m.currency || "EUR"),
    cac,
    aov: Number(m.aov) || null,
    marginFrac,
    blendedRoas: Number(m.blendedRoas) || null,
    breakEven: m.breakEvenRoasDelivery ?? null,
    rows,
    hasAny,
  };
}

function Flag({ code, size = 20 }: { code: string; size?: number }) {
  return (
    <img
      src={`https://flagcdn.com/${size * 2}x${Math.round(size * 1.5)}/${code}.png`}
      width={size}
      height={Math.round(size * 0.75)}
      alt={code}
      loading="lazy"
      className="inline-block rounded-[3px] shadow-sm ring-1 ring-black/5 align-[-2px]"
    />
  );
}

// A soft-green editable cell (matches the workbook's "input your actuals" cells).
function InputCell({
  value,
  onChange,
  mode, // "money" | "percent" | "number"
  symbol,
  step = 0.01,
}: {
  value: number;
  onChange: (n: number) => void;
  mode: "money" | "percent" | "number";
  symbol?: string;
  step?: number;
}) {
  const display = mode === "percent" ? value * 100 : value;
  return (
    <div className="flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50/70 px-2 py-1 focus-within:ring-2 focus-within:ring-emerald-300">
      {symbol && <span className="text-[11px] text-emerald-700">{symbol}</span>}
      <input
        type="number"
        step={step}
        value={Number.isFinite(display) ? Number(display.toFixed(4)) : ""}
        onChange={(e) => {
          const raw = parseFloat(e.target.value);
          const v = Number.isFinite(raw) ? raw : 0;
          onChange(mode === "percent" ? v / 100 : v);
        }}
        className="w-full bg-transparent text-right text-[13px] font-medium tabular-nums text-emerald-900 outline-none"
      />
      {mode === "percent" && <span className="text-[11px] text-emerald-700">%</span>}
    </div>
  );
}

function InputRow({
  icon,
  label,
  hint,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_130px] items-center gap-3 border-t border-neutral-100 py-2 first:border-t-0">
      <div className="flex items-start gap-2 min-w-0">
        <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded bg-neutral-100 text-neutral-500">
          {icon}
        </span>
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-neutral-700">{label}</div>
          {hint && <div className="text-[10px] text-neutral-400">{hint}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

function UnitEconomicsPage() {
  const { user } = useDashboardSession();
  const [activeId, setActiveId] = useState(MARKETS[0].id);
  // Editable inputs per market, seeded from the workbook defaults.
  const [inputs, setInputs] = useState<Record<string, MarketInputs>>(() =>
    Object.fromEntries(MARKETS.map((m) => [m.id, { ...m.defaults }])),
  );

  // Live cohort LTV (real 3/6/12-month data) from the dashboard read API.
  const dashboardQuery = useDashboard();
  const econ = (dashboardQuery.data as any)?.retentionEconomics ?? null;

  const market = MARKETS.find((m) => m.id === activeId)!;
  const data = inputs[activeId];
  const r = useMemo(() => compute(market, data), [market, data]);

  const liveMarket = Array.isArray(econ?.markets)
    ? econ.markets.find((mm: any) => mm.market === LIVE_CODE[activeId]) ?? null
    : null;
  const live = useMemo(() => computeLive(liveMarket), [liveMarket]);
  const liveLoading = dashboardQuery.isPending;

  const set = (patch: Partial<MarketInputs>) =>
    setInputs((prev) => ({ ...prev, [activeId]: { ...prev[activeId], ...patch } }));
  const reset = () =>
    setInputs((prev) => ({ ...prev, [activeId]: { ...market.defaults } }));

  const cur = market.currency;
  const sym = cur === "EUR" ? "€" : cur === "GBP" ? "£" : "$";

  return (
    <DashboardShell user={user} title="Unit Economics Calculator">
      <div className="p-6 space-y-4">
        {/* Header + market tabs */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-100">
              <Calculator className="h-5 w-5 text-emerald-700" />
            </div>
            <div>
              <div className="text-[15px] font-semibold">Zapply Unit Economics Calculator</div>
              <div className="mt-0.5 text-[12px] text-neutral-500">
                Break-even ROAS, max CAC and 3 / 6 / 12-month LTV contribution margins per market ·
                edit the
                <span className="mx-1 rounded bg-emerald-50 px-1 text-emerald-700">green</span>
                cells to model your own numbers
              </div>
            </div>
          </div>
          <div className="inline-flex rounded-lg border bg-neutral-50 p-1">
            {MARKETS.map((m) => (
              <button
                key={m.id}
                onClick={() => setActiveId(m.id)}
                className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] font-medium transition ${
                  m.id === activeId
                    ? "bg-white text-neutral-900 shadow-sm"
                    : "text-neutral-500 hover:text-neutral-800"
                }`}
              >
                <Flag code={m.flag} size={16} />
                {m.name}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
          {/* ── Inputs: cost assumptions ── */}
          <div className="rounded-xl border bg-white shadow-sm p-5">
            <div className="flex items-center justify-between">
              <div className="text-[14px] font-semibold">Cost assumptions</div>
              <button
                onClick={reset}
                className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-50"
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </button>
            </div>
            <div className="mt-1 text-[11px] text-neutral-400">
              {market.name} · all per-order, in {cur}
            </div>

            <div className="mt-3">
              <InputRow icon={<Receipt className="h-3 w-3" />} label="NC AOV incl. tax" hint="new-customer average order value">
                <InputCell value={data.aov} onChange={(v) => set({ aov: v })} mode="money" symbol={sym} step={1} />
              </InputRow>
              <InputRow icon={<Package className="h-3 w-3" />} label="Cost of goods" hint={`${money(r.lines.cogs, cur)} / order`}>
                <InputCell value={data.cogsPct} onChange={(v) => set({ cogsPct: v })} mode="percent" />
              </InputRow>
              <InputRow icon={<CreditCard className="h-3 w-3" />} label="Merchant fees" hint={`+ ${money(data.merchantFixed, cur)} fixed · ${money(r.lines.merchant, cur)} / order`}>
                <InputCell value={data.merchantPct} onChange={(v) => set({ merchantPct: v })} mode="percent" />
              </InputRow>
              <InputRow icon={<RotateCcw className="h-3 w-3" />} label="Customer returns" hint={`${money(r.lines.returns, cur)} / order`}>
                <InputCell value={data.returnsPct} onChange={(v) => set({ returnsPct: v })} mode="percent" />
              </InputRow>
              <InputRow icon={<Truck className="h-3 w-3" />} label="Shipping costs" hint="per order">
                <InputCell value={data.shipping} onChange={(v) => set({ shipping: v })} mode="money" symbol={sym} />
              </InputRow>
              <InputRow icon={<Boxes className="h-3 w-3" />} label="Fulfilment / unit" hint="pick & pack per unit">
                <InputCell value={data.fulfilment} onChange={(v) => set({ fulfilment: v })} mode="money" symbol={sym} />
              </InputRow>
              <InputRow icon={<TrendingUp className="h-3 w-3" />} label="3-month LTV uplift" hint="repeat revenue, % of first order">
                <InputCell value={data.ltv3} onChange={(v) => set({ ltv3: v })} mode="percent" />
              </InputRow>
              <InputRow icon={<TrendingUp className="h-3 w-3" />} label="6-month LTV uplift" hint="repeat revenue, % of first order">
                <InputCell value={data.ltv6} onChange={(v) => set({ ltv6: v })} mode="percent" />
              </InputRow>
              <InputRow icon={<TrendingUp className="h-3 w-3" />} label="12-month LTV uplift" hint="repeat revenue, % of first order">
                <InputCell value={data.ltv12} onChange={(v) => set({ ltv12: v })} mode="percent" />
              </InputRow>
              <InputRow icon={<Gauge className="h-3 w-3" />} label="Delayed purchase mult." hint="1DC vs 28DC attribution gap">
                <InputCell value={data.delayedMultiplier} onChange={(v) => set({ delayedMultiplier: v })} mode="percent" />
              </InputRow>
            </div>

            {/* Totals (calculated — bright green) */}
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 space-y-1.5">
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-neutral-600">{market.taxLabel} ({pct(market.taxRate)})</span>
                <span className="tabular-nums font-medium">{money(r.lines.tax, cur)}</span>
              </div>
              <div className="flex items-center justify-between text-[13px] font-semibold border-t border-emerald-200/70 pt-1.5">
                <span>Total costs to deliver</span>
                <span className="tabular-nums">{money(r.totalCost, cur)}</span>
              </div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-neutral-600">Percentage cost</span>
                <span className="tabular-nums font-semibold text-emerald-800">{pct(r.pctCost)}</span>
              </div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-neutral-600">First-order unit margin</span>
                <span className="tabular-nums font-semibold text-emerald-800">{money(r.unitMargin, cur)}</span>
              </div>
            </div>
          </div>

          {/* ── Results ── */}
          <div className="space-y-4">
            {/* Live cohort LTV contribution margin (real 3/6/12-month data) */}
            <div className="rounded-xl border bg-white shadow-sm p-5">
              <div className="flex items-start justify-between flex-wrap gap-2">
                <div className="flex items-start gap-2.5">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-100">
                    <Activity className="h-4 w-4 text-violet-700" />
                  </div>
                  <div>
                    <div className="text-[14px] font-semibold">
                      Live LTV contribution margin · 3 / 6 / 12-month
                    </div>
                    <div className="mt-0.5 text-[12px] text-neutral-500">
                      Real cohort LTV from your Shopify order history · contribution = LTV ×
                      variable margin − CAC
                    </div>
                  </div>
                </div>
                <span className="rounded-md bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                  Actual
                </span>
              </div>

              {liveLoading ? (
                <div className="mt-4 h-28 animate-pulse rounded-lg bg-neutral-100" />
              ) : live && live.hasAny ? (
                <>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-neutral-500">
                    <span>AOV <strong className="text-neutral-700">{money(live.aov, live.currency)}</strong></span>
                    <span>CAC <strong className="text-neutral-700">{money(live.cac, live.currency)}</strong></span>
                    <span>Variable margin <strong className="text-neutral-700">{pct(live.marginFrac)}</strong></span>
                    <span>Blended ROAS <strong className="text-neutral-700">{x2(live.blendedRoas)}</strong></span>
                  </div>
                  <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-100">
                    <table className="w-full min-w-[560px] text-[12px]">
                      <thead>
                        <tr className="bg-neutral-50 text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                          <th className="px-3 py-2.5">Horizon</th>
                          <th className="px-3 py-2.5 text-right">Cohort LTV</th>
                          <th className="px-3 py-2.5 text-right">Contribution (× margin)</th>
                          <th className="px-3 py-2.5 text-right">LTV CM (− CAC)</th>
                          <th className="px-3 py-2.5 text-right">LTV / CAC</th>
                        </tr>
                      </thead>
                      <tbody>
                        {live.rows.map((row) => (
                          <tr key={row.label} className="border-t border-neutral-100">
                            <td className="px-3 py-2.5 font-medium">{row.label} LTV</td>
                            {row.ltv == null ? (
                              <td colSpan={4} className="px-3 py-2.5 text-neutral-400">
                                <span title={`${row.mature} mature customers`}>maturing — cohorts not old enough yet</span>
                              </td>
                            ) : (
                              <>
                                <td className="px-3 py-2.5 text-right tabular-nums">{money(row.ltv, live.currency)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-neutral-600">{money(row.contrib, live.currency)}</td>
                                <td className="px-3 py-2.5 text-right"><Margin value={row.cm} cur={live.currency} /></td>
                                <td className="px-3 py-2.5 text-right">
                                  <span className={`tabular-nums font-semibold ${row.ratio == null ? "text-neutral-400" : row.ratio >= 3 ? "text-emerald-700" : row.ratio >= 1 ? "text-amber-600" : "text-rose-600"}`}>
                                    {row.ratio != null ? x2(row.ratio) : DASH}
                                  </span>
                                </td>
                              </>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-2 text-[10px] text-neutral-400">
                    3/6/12-month ≈ 90/180/365-day cohort windows · "maturing" = not enough cohort age yet ·
                    LTV/CAC ≥3× healthy, 1–3× watch, &lt;1× losing money.
                  </div>
                </>
              ) : (
                <div className="mt-3 rounded-lg border border-violet-100 bg-violet-50/50 p-4 text-[12px] text-neutral-600">
                  Live cohort LTV for <strong>{market.name}</strong> is still building from the Shopify
                  orders mirror — the {market.name === "USA" ? "US" : market.name} windows fill in as order
                  history matures. Use the <strong>what-if model</strong> below in the meantime.
                </div>
              )}
            </div>

            {/* Break-even headline */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Break-even ROAS" value={x2(r.breakeven)} tone="emerald" icon={<Target className="h-4 w-4" />} />
              <Stat label="Max CAC @ B/E" value={money(r.scenarios[1].cac, cur)} tone="neutral" icon={<Receipt className="h-4 w-4" />} />
              <Stat label="28DC ROAS" value={x2(r.roas28)} tone="neutral" icon={<Gauge className="h-4 w-4" />} />
              <Stat label="1DC ROAS" value={x2(r.roas1)} tone="neutral" icon={<Gauge className="h-4 w-4" />} />
            </div>

            {/* ROAS targets matrix with 3/6/12-month LTV contribution margins */}
            <div className="rounded-xl border bg-white shadow-sm p-5">
              <div className="flex items-start gap-2.5">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-100">
                  <Target className="h-4 w-4 text-blue-700" />
                </div>
                <div>
                  <div className="text-[14px] font-semibold">
                    What-if model · ROAS targets &amp; LTV contribution margin
                  </div>
                  <div className="mt-0.5 text-[12px] text-neutral-500">
                    Break-even ROAS plus modeled contribution at 3 / 6 / 12-month LTV horizons
                  </div>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-100">
                <table className="w-full min-w-[720px] text-[12px]">
                  <thead>
                    <tr className="bg-neutral-50 text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                      <th className="px-3 py-2.5">Scenario</th>
                      <th className="px-3 py-2.5 text-right">ROAS target</th>
                      <th className="px-3 py-2.5 text-right">Max CAC</th>
                      <th className="px-3 py-2.5 text-right">1st-order margin</th>
                      <th className="px-3 py-2.5 text-right">3-mo LTV CM</th>
                      <th className="px-3 py-2.5 text-right">6-mo LTV CM</th>
                      <th className="px-3 py-2.5 text-right">12-mo LTV CM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.scenarios.map((s) => {
                      const accent =
                        s.key === "below"
                          ? "bg-rose-400"
                          : s.key === "above"
                            ? "bg-emerald-500"
                            : "bg-neutral-400";
                      return (
                        <tr key={s.key} className="border-t border-neutral-100">
                          <td className="px-3 py-2.5 font-medium">
                            <span className="flex items-center gap-2">
                              <span className={`h-2.5 w-2.5 rounded-full ${accent}`} />
                              {s.label}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{x2(s.roas)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{money(s.cac, cur)}</td>
                          <td className="px-3 py-2.5 text-right">
                            <Margin value={s.firstPurchaseCM} cur={cur} />
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <Margin value={s.ltvCM3} cur={cur} />
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <Margin value={s.ltvCM6} cur={cur} />
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <Margin value={s.ltvCM12} cur={cur} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex gap-2 text-[10px] text-neutral-400 leading-relaxed">
                <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
                <span>
                  <strong>ROAS target</strong> = revenue per {sym}1 of ad spend needed at that level ·{" "}
                  <strong>Max CAC</strong> = AOV ÷ ROAS, the most you can pay to acquire a customer ·{" "}
                  <strong>1st-order margin</strong> = contribution from order one only ·{" "}
                  <strong>LTV CM</strong> credits the repeat-revenue uplift over each horizon
                  (3-mo {pct(data.ltv3)}, 6-mo {pct(data.ltv6)}, 12-mo {pct(data.ltv12)}).
                  Margins turn negative when CAC exceeds the contribution at that level.
                </span>
              </div>
            </div>

            {/* 28DC / 1DC view */}
            <div className="rounded-xl border bg-white shadow-sm p-5">
              <div className="text-[14px] font-semibold">Attribution-window targets</div>
              <div className="mt-0.5 text-[12px] text-neutral-500">
                1-day-click discounts the 28-day target by the delayed-purchase multiplier ({pct(data.delayedMultiplier)})
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="28DC ROAS" value={x2(r.roas28)} tone="emerald" icon={<Gauge className="h-4 w-4" />} />
                <Stat label="1DC ROAS" value={x2(r.roas1)} tone="emerald" icon={<Gauge className="h-4 w-4" />} />
                <Stat label="28DC CPA" value={money(r.cpa28, cur)} tone="neutral" icon={<Receipt className="h-4 w-4" />} />
                <Stat label="1DC CPA" value={money(r.cpa1, cur)} tone="neutral" icon={<Receipt className="h-4 w-4" />} />
              </div>
            </div>

            <div className="flex gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-[11px] text-neutral-600">
              <Info className="h-4 w-4 shrink-0 mt-px" />
              <span>
                The <strong>Live</strong> card above shows real 3/6/12-month LTV contribution margin from your
                Shopify cohorts (source of truth). The <strong>what-if model</strong> here lets you stress-test
                targets — its LTV uplift % green cells are editable assumptions, seeded from the workbook
                (NL&nbsp;6-mo, UK&nbsp;4-mo) with placeholder 3- &amp; 12-month curves.
              </span>
            </div>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone: "emerald" | "neutral";
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-white shadow-sm p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <span className={tone === "emerald" ? "text-emerald-600" : "text-neutral-400"}>{icon}</span>
        {label}
      </div>
      <div className={`mt-1 text-[20px] font-semibold tabular-nums ${tone === "emerald" ? "text-emerald-700" : "text-neutral-900"}`}>
        {value}
      </div>
    </div>
  );
}

function Margin({ value, cur }: { value: number | null; cur: string }) {
  if (value == null || !Number.isFinite(value)) return <span className="text-neutral-300">{DASH}</span>;
  const positive = value >= 0;
  return (
    <span className={`inline-flex items-center justify-end gap-1 tabular-nums font-semibold ${positive ? "text-emerald-700" : "text-rose-600"}`}>
      {positive ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
      {money(value, cur)}
    </span>
  );
}
