import { authedFetch } from "@/lib/authed-fetch";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { getDashboardData } from "@/server/dashboard.functions";
import { getManualDataSnapshot } from "@/server/manual-data.functions";
import { MarketsView } from "@/components/FinanceDashboard.tsx";
import { Users, Target, Package, Truck, Building2, Gauge, TrendingUp, TrendingDown } from "lucide-react";

export const Route = createFileRoute("/pillars/margin-per-market")({
  head: () => ({ meta: [{ title: "Margin per Market — Zapply" }] }),
  component: MarginPerMarketPage,
});

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function startOfMonthStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function daysAgoStr(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return todayStr(d);
}

function SkeletonBox({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-neutral-200/70 ${className}`} />;
}

function PillarSkeleton() {
  return (
    <div className="p-6 space-y-4">
      <SkeletonBox className="h-8 w-64" />
      <SkeletonBox className="h-4 w-96" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 mt-6">
        {Array.from({ length: 4 }).map((_, i) => <SkeletonBox key={i} className="h-24" />)}
      </div>
      <SkeletonBox className="h-72 mt-3" />
    </div>
  );
}

function MarginPerMarketPage() {
  const { user } = useDashboardSession();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [manualData, setManualData] = useState<any>(null);

  const [dateRange, setDateRange] = useState({ from: daysAgoStr(30), to: todayStr() });
  const [rangeData, setRangeData] = useState<any>(null);
  const [rangeSyncing, setRangeSyncing] = useState(false);

  useEffect(() => {
    let alive = true;
    getDashboardData()
      .then((d) => alive && setData(d))
      .finally(() => alive && setLoading(false));
    getManualDataSnapshot()
      .then((m) => alive && setManualData(m))
      .catch(() => { if (alive) setManualData(null); });
    return () => { alive = false; };
  }, []);

  // Auto-load default 30D range so the table reflects the picker on first paint.
  useEffect(() => {
    let alive = true;
    setRangeSyncing(true);
    authedFetch(`/api/sync?from=${daysAgoStr(30)}&to=${todayStr()}`, { method: "POST" })
      .then((r) => r.json())
      .then((json) => { if (alive) setRangeData(json.rangeData ?? null); })
      .catch(() => { if (alive) setRangeData(null); })
      .finally(() => { if (alive) setRangeSyncing(false); });
    return () => { alive = false; };
  }, []);

  const handleDateChange = useCallback(async (from: string, to: string) => {
    setDateRange({ from, to });
    const isCurrentMonth = from === startOfMonthStr() && to === todayStr();
    if (isCurrentMonth) {
      setRangeData(null);
      return;
    }
    setRangeSyncing(true);
    setRangeData(null);
    try {
      const res = await authedFetch(`/api/sync?from=${from}&to=${to}`, { method: "POST" });
      const json = await res.json();
      setRangeData(json.rangeData ?? null);
    } catch {
      setRangeData(null);
    } finally {
      setRangeSyncing(false);
    }
  }, []);

  if (loading) {
    return (
      <DashboardShell user={user} title="Margin per Market">
        <PillarSkeleton />
      </DashboardShell>
    );
  }

  const cachedShopifyMarkets = Array.isArray(data?.shopifyMarkets) ? data.shopifyMarkets : [];
  const cachedTwData = (Array.isArray(data?.tripleWhale) ? data.tripleWhale : []).filter((m: any) => m?.live);

  // Prefer fresh range-synced data when available
  const effectiveMarkets = Array.isArray(rangeData?.shopifyMarkets) ? rangeData.shopifyMarkets : cachedShopifyMarkets;
  const effectiveTw = Array.isArray(rangeData?.tripleWhale)
    ? rangeData.tripleWhale.filter((m: any) => m?.live)
    : cachedTwData;

  const activeMarkets = effectiveMarkets.some((m: any) => m?.live) ? effectiveMarkets : null;

  return (
    <DashboardShell user={user} title="Margin per Market">
      <div className="p-6 space-y-4">
        {activeMarkets ? (
          <MarketsView
            liveMarkets={activeMarkets}
            twData={effectiveTw}
            dateRange={dateRange}
            onDateChange={handleDateChange}
            rangeSyncing={rangeSyncing}
            shopifyMonthly={Array.isArray(data?.shopifyMonthly) ? data.shopifyMonthly : null}
            marketCosts={manualData?.settings?.market_costs ?? null}
            paymentFeesByMonth={data?.paymentFeesMonthly?.byMonth ?? null}
            shippingByMonth={data?.tripleWhaleShippingMonthly ?? null}
          />
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center text-[13px] text-amber-800">
            <strong>Margin per Market</strong> requires Shopify &amp; Triple Whale data.
          </div>
        )}

        {/* Retention LTV + unit-economics break-even ROAS */}
        <RetentionEconomics econ={data?.retentionEconomics ?? null} />
      </div>
    </DashboardShell>
  );
}

const DASH = "—";
function eur(n: number | null | undefined, currency = "EUR") {
  if (n == null || !Number.isFinite(n)) return DASH;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `€${Math.round(n).toLocaleString()}`;
  }
}
function x2(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return DASH;
  return `${n.toFixed(2)}×`;
}
function pct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return DASH;
  return `${n.toFixed(1)}%`;
}

const MARKET_NAMES: Record<string, string> = {
  NL: "Netherlands",
  UK: "United Kingdom",
  US: "United States",
};

// Real flag images (flagcdn) instead of emoji — Windows has no flag emoji
// glyphs and renders 🇳🇱 as the letters "NL", which is what the cards were
// showing. Images render identically on every OS.
function Flag({ code, size = 20 }: { code: string; size?: number }) {
  const cc = code === "UK" ? "gb" : code.toLowerCase();
  return (
    <img
      src={`https://flagcdn.com/${size * 2}x${Math.round(size * 1.5)}/${cc}.png`}
      width={size}
      height={Math.round(size * 0.75)}
      alt={code}
      loading="lazy"
      className="inline-block rounded-[3px] shadow-sm ring-1 ring-black/5 align-[-2px]"
    />
  );
}

// Market label = flag image + country name, used in both cards.
function MarketLabel({ code, className = "" }: { code: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Flag code={code} size={18} />
      <span>{MARKET_NAMES[code] ?? code}</span>
    </span>
  );
}

function RetentionEconomics({ econ }: { econ: { markets: any[] } | null }) {
  if (!econ || !Array.isArray(econ.markets) || econ.markets.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-6 text-center text-[13px] text-neutral-500">
        <strong>Retention &amp; unit economics</strong> — building cohorts from the Shopify orders
        mirror. LTV windows fill in as order history accumulates (and once <code>read_all_orders</code> backfills the older years).
      </div>
    );
  }

  return (
    <>
      {/* ── Retention / LTV ── */}
      <div className="rounded-xl border bg-white shadow-sm p-5">
        <div className="flex items-start justify-between flex-wrap gap-2">
          <div className="flex items-start gap-2.5">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-100">
              <Users className="h-4 w-4 text-violet-700" />
            </div>
            <div>
              <div className="text-[14px] font-semibold">Customer LTV by horizon</div>
              <div className="mt-0.5 text-[12px] text-neutral-500">
                True cohort LTV — average revenue within N days of each customer's first order ·
                source: Shopify orders mirror
              </div>
            </div>
          </div>
          <span className="rounded-md bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700">
            Cohort-based
          </span>
        </div>
        <div className="mt-4 overflow-x-auto rounded-lg border border-neutral-100">
          <table className="w-full min-w-[640px] text-[12px]">
            <thead>
              <tr className="bg-neutral-50 text-left text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                <th className="px-3 py-2.5">Market</th>
                <th className="px-3 py-2.5 text-right">60-day LTV</th>
                <th className="px-3 py-2.5 text-right">90-day LTV</th>
                <th className="px-3 py-2.5 text-right">180-day LTV</th>
                <th className="px-3 py-2.5 text-right">1-year LTV</th>
                <th className="px-3 py-2.5 text-right">Avg orders / cust</th>
                <th className="px-3 py-2.5 text-right">LTV / CAC</th>
              </tr>
            </thead>
            <tbody>
              {econ.markets.map((m) => {
                const ltvCell = (val: number | null, mature: number) =>
                  val != null ? (
                    <span className="tabular-nums">{eur(val, m.currency)}</span>
                  ) : (
                    <span className="text-neutral-400" title={`${mature} mature customers`}>
                      maturing
                    </span>
                  );
                return (
                  <tr key={m.market} className="border-t border-neutral-100">
                    <td className="px-3 py-2 font-medium"><MarketLabel code={m.market} /></td>
                    <td className="px-3 py-2 text-right">{ltvCell(m.ltv60, m.matureCustomers60)}</td>
                    <td className="px-3 py-2 text-right">{ltvCell(m.ltv90, m.matureCustomers90)}</td>
                    <td className="px-3 py-2 text-right">{ltvCell(m.ltv180, m.matureCustomers180)}</td>
                    <td className="px-3 py-2 text-right">{ltvCell(m.ltv365, m.matureCustomers365)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-neutral-600">
                      {m.avgOrdersPerCustomer != null ? m.avgOrdersPerCustomer.toFixed(2) : DASH}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {m.ltvCac != null ? (
                        <span
                          className={`tabular-nums font-semibold ${m.ltvCac >= 3 ? "text-emerald-700" : m.ltvCac >= 1 ? "text-amber-600" : "text-rose-600"}`}
                        >
                          {x2(m.ltvCac)}
                          {m.ltvCacWindow && (
                            <span className="ml-1 text-[10px] font-normal text-neutral-400">
                              ({m.ltvCacWindow})
                            </span>
                          )}
                        </span>
                      ) : (
                        DASH
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-2 text-[10px] text-neutral-400">
          "maturing" = no cohorts old enough for that window yet. LTV/CAC uses the longest mature
          window available · ≥3× healthy (green), 1–3× watch (amber), &lt;1× losing money (red).
        </div>
      </div>

      {/* ── Unit economics / break-even ROAS ── */}
      <div className="rounded-xl border bg-white shadow-sm p-5">
        <div className="flex items-start justify-between flex-wrap gap-2">
          <div className="flex items-start gap-2.5">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-100">
              <Target className="h-4 w-4 text-blue-700" />
            </div>
            <div>
              <div className="text-[14px] font-semibold">Unit economics &amp; break-even ROAS</div>
              <div className="mt-0.5 text-[12px] text-neutral-500">
                The marketing efficiency needed to break even at three cost levels · per market
              </div>
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          {econ.markets.map((m) => {
            const aovForCac = Number(m.aov ?? 0);
            // Break-even ROAS = AOV / CAC, so the max spendable CAC at that
            // level is AOV ÷ break-even ROAS. This is the € the user can pay
            // to acquire a customer before losing money at that cost level.
            const maxCac = (roas: number | null) =>
              roas != null && roas > 0 && aovForCac > 0 ? aovForCac / roas : null;
            const beRow = (
              icon: React.ReactNode,
              label: string,
              value: number | null,
              hint: string,
              tone: string,
            ) => (
              <div className="flex items-center justify-between gap-2 border-t border-neutral-100 py-2 first:border-t-0">
                <div className="flex items-start gap-2 min-w-0">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded bg-neutral-100 text-neutral-500">
                    {icon}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium text-neutral-700">{label}</div>
                    <div className="text-[10px] text-neutral-400">{hint}</div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-[16px] font-semibold tabular-nums ${tone}`}>{x2(value)}</div>
                  <div className="text-[10px] text-neutral-400 tabular-nums">
                    max CAC {eur(maxCac(value), m.currency)}
                  </div>
                </div>
              </div>
            );
            // Headroom: how far current blended ROAS sits above the full
            // (OpEx-inclusive) break-even. Positive = room to lower targets.
            const headroom =
              m.blendedRoas != null && m.breakEvenRoasOpex != null
                ? m.blendedRoas - m.breakEvenRoasOpex
                : null;
            return (
              <div key={m.market} className="rounded-lg border border-neutral-200 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-semibold"><MarketLabel code={m.market} /></div>
                  <div className="text-[10px] text-neutral-400">
                    AOV {eur(m.aov, m.currency)} · CAC {eur(m.cac, m.currency)}
                  </div>
                </div>
                {(() => {
                  // Per-order € amounts = AOV × the cost ratio. Shown next
                  // to the % so the user sees both "8.0%" and "€5.68/order".
                  const aovVal = Number(m.aov ?? 0);
                  const amt = (p: number | null | undefined) =>
                    p != null && Number.isFinite(p) ? eur((aovVal * p) / 100, m.currency) : DASH;
                  const cogsAmt = amt(m.cogsPct);
                  const shipAmt = amt(m.shippingPct);
                  const feeAmt = amt(m.paymentFeePct);
                  const fulfilAmt = amt(m.fulfilmentPct);
                  return (
                    <div className="mt-2">
                      {beRow(
                        <Package className="h-3 w-3" />,
                        "Product margin",
                        m.breakEvenRoasProduct,
                        `COGS ${cogsAmt} (${pct(m.cogsPct)})`,
                        "text-neutral-900",
                      )}
                      {beRow(
                        <Truck className="h-3 w-3" />,
                        "Incl. delivery",
                        m.breakEvenRoasDelivery,
                        `+ ship ${shipAmt} · fees ${feeAmt} · fulfil ${fulfilAmt} /order`,
                        "text-neutral-900",
                      )}
                      {beRow(
                        <Building2 className="h-3 w-3" />,
                        "Incl. fixed OpEx",
                        m.breakEvenRoasOpex,
                        `+ OpEx ${eur(m.opexPerOrder, m.currency)}/order`,
                        "text-neutral-900",
                      )}
                    </div>
                  );
                })()}
                <div
                  className={`mt-3 rounded-md px-3 py-2 ${
                    headroom == null
                      ? "bg-neutral-50"
                      : headroom >= 0
                        ? "bg-emerald-50/60"
                        : "bg-rose-50/60"
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-neutral-500">
                      <Gauge className="h-3.5 w-3.5" /> Current blended ROAS
                    </span>
                    <span className="font-semibold tabular-nums">{x2(m.blendedRoas)}</span>
                  </div>
                  {headroom != null && (
                    <div
                      className={`mt-1 flex items-start gap-1 text-[11px] font-medium ${headroom >= 0 ? "text-emerald-700" : "text-rose-600"}`}
                    >
                      {headroom >= 0 ? (
                        <TrendingUp className="h-3.5 w-3.5 mt-px shrink-0" />
                      ) : (
                        <TrendingDown className="h-3.5 w-3.5 mt-px shrink-0" />
                      )}
                      <span>
                        {headroom >= 0
                          ? `${x2(headroom)} above full break-even — room to lower targets & scale`
                          : `${x2(Math.abs(headroom))} below full break-even — tighten targets`}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-[10px] text-neutral-400 leading-relaxed">
          Break-even ROAS = revenue per €1 ad spend needed to not lose money at that cost level.
          <strong> Product margin</strong> covers COGS only · <strong>Incl. delivery</strong> adds
          shipping + payment fees + fulfilment · <strong>Incl. fixed OpEx</strong> also covers the
          allocated monthly operating cost per order. If current blended ROAS sits comfortably above
          the OpEx-inclusive figure, you can lower acquisition targets to scale new-customer intake
          (future repeat orders bring the cash back).
        </div>
      </div>
    </>
  );
}
