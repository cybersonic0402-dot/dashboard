import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Plus, Info, AlertTriangle } from "lucide-react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { getDashboardData } from "@/server/dashboard.functions";

export const Route = createFileRoute("/operations/reconciliation")({
  head: () => ({ meta: [{ title: "Reconciliation — Profit Variance — Zapply" }] }),
  component: ReconciliationPage,
});

function fmtMoney(n: number | null | undefined, opts: { signed?: boolean } = {}) {
  if (n == null || !isFinite(n)) return "—";
  const v = Math.round(n);
  if (opts.signed && v < 0) return `-€${Math.abs(v).toLocaleString("en-GB")}`;
  if (opts.signed && v > 0) return `+€${v.toLocaleString("en-GB")}`;
  if (v < 0) return `-€${Math.abs(v).toLocaleString("en-GB")}`;
  return `€${v.toLocaleString("en-GB")}`;
}

const SOURCE_META = {
  Shopify:       { cls: "text-amber-700" },
  Jortt:         { cls: "text-violet-700" },
  "Triple Whale":{ cls: "text-sky-700" },
  Calculated:    { cls: "text-neutral-500" },
  Xero:          { cls: "text-emerald-700" },
  // Placeholder for rows whose source isn't wired yet (e.g. Shipping costs).
  "—":           { cls: "text-neutral-400" },
} as const;

type Source = keyof typeof SOURCE_META;
type Row = { label: string; source: Source; value: number | null; tone: "pos" | "neg" | "neutral" };

function ReconciliationPage() {
  const { user } = useDashboardSession();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getDashboardData()
      .then((d) => alive && setData(d))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const computed = useMemo(() => {
    const shopifyMonthly: any[] = Array.isArray(data?.shopifyMonthly) ? data.shopifyMonthly : [];
    const lastMonth = shopifyMonthly[shopifyMonthly.length - 1] ?? null;
    const monthKey = lastMonth?.month ?? null;
    const grossRev   = lastMonth ? Number(lastMonth.revenue ?? 0) : null;
    const refunds    = lastMonth?.refunds   != null ? -Math.abs(Number(lastMonth.refunds))   : null;
    const discounts  = lastMonth?.discounts != null ? -Math.abs(Number(lastMonth.discounts)) : null;

    // Net sales after refunds & discounts (used for the fallback fee estimate
    // only — the real PSP-aggregated fees take precedence below).
    const netSales = grossRev != null
      ? grossRev + (refunds ?? 0) + (discounts ?? 0)
      : null;

    // Payment processing fees — prefer the actual aggregated PSP feed
    // (Shopify Payments + PayPal + Mollie) for this month, fall back to the
    // ~2.9% × net-sales estimate only when that feed has no row yet.
    const feesEntry: any =
      data?.paymentFeesMonthly?.byMonth && monthKey
        ? data.paymentFeesMonthly.byMonth[monthKey]
        : null;
    const realFees =
      feesEntry && typeof feesEntry.total === "number" && feesEntry.total > 0
        ? -Math.round(feesEntry.total)
        : null;
    const paymentFees =
      realFees ??
      (lastMonth?.paymentFees != null
        ? -Math.abs(Number(lastMonth.paymentFees))
        : netSales != null && netSales > 0
          ? -Math.round(netSales * 0.029)
          : null);
    const paymentFeesSource: Source =
      realFees != null ? "Shopify" : lastMonth?.paymentFees != null ? "Shopify" : "Calculated";

    // COGS — estimate via Triple Whale NL gross-profit ratio applied to net revenue
    // (mirrors the P&L table in FinanceDashboard). Fallback to a 0.54 GP ratio
    // when Triple Whale hasn't reported a usable revenue/grossProfit pair.
    const twAll: any[] = Array.isArray(data?.tripleWhale)
      ? data.tripleWhale
      : Array.isArray(data?.tripleWhale?.markets)
        ? data.tripleWhale.markets
        : [];
    const twNL = twAll.find((t: any) => t?.market === "NL") ?? twAll[0];
    const gpRatio =
      twNL && typeof twNL.revenue === "number" && twNL.revenue > 0 && typeof twNL.grossProfit === "number"
        ? twNL.grossProfit / twNL.revenue
        : 0.54;
    const netRev = netSales != null && netSales > 0
      ? netSales
      : (grossRev != null && grossRev > 0 ? grossRev : null);
    const cogs = netRev != null ? -Math.round(netRev * (1 - gpRatio)) : null;

    // OpEx sourced exclusively from Xero P&L (opexDetail is nested {label,items}).
    // Jortt is no longer used for OpEx — if Xero has no OpEx data, the row is null.
    const opexByMonth: any[] = Array.isArray(data?.xero?.opexByMonth) ? data.xero.opexByMonth : [];
    const lastOpex = opexByMonth[opexByMonth.length - 1] ?? null;

    // Shipping — pulled from Triple Whale's per-month shipping aggregate
    // (the same source the P&L table uses on Monthly Overview). Keyed by
    // the "Mon 'YY" month label that matches Shopify's monthly format.
    const shippingEntry =
      data?.tripleWhaleShippingMonthly && monthKey
        ? data.tripleWhaleShippingMonthly[monthKey]
        : null;
    const shipping: number | null =
      shippingEntry && typeof shippingEntry.total === "number" && shippingEntry.total > 0
        ? -Math.round(shippingEntry.total)
        : null;

    const opex = lastOpex
      ? -Math.abs(
          (lastOpex.team ?? 0) +
          (lastOpex.agencies ?? 0) +
          (lastOpex.content ?? 0) +
          (lastOpex.software ?? 0) +
          (lastOpex.rent ?? 0) +
          (lastOpex.other ?? 0),
        ) || null
      : null;

    // Triple Whale ad spend — cache shape is an array of per-market rows
    // each with { live, adSpend, facebookSpend, googleSpend, ... }.
    const tw = data?.tripleWhale;
    const twRows: any[] = Array.isArray(tw)
      ? tw
      : Array.isArray(tw?.markets)
        ? tw.markets
        : [];
    const sumField = (rows: any[], ...fields: string[]) =>
      rows.reduce((s, r) => {
        if (!r?.live && r?.live !== undefined) return s;
        for (const f of fields) {
          const v = Number(r?.[f] ?? 0);
          if (v) return s + v;
        }
        return s;
      }, 0);
    const adSpendVal =
      Number(tw?.totalSpend ?? tw?.spend ?? tw?.summary?.spend ?? 0) ||
      sumField(twRows, "adSpend", "spend");
    const adSpend = adSpendVal > 0 ? -adSpendVal : null;

    const rows: Row[] = [
      { label: "Shopify gross revenue",   source: "Shopify",            value: grossRev,    tone: "pos" },
      { label: "Refunds & returns",       source: "Shopify",            value: refunds,     tone: "neg" },
      { label: "Discounts applied",       source: "Shopify",            value: discounts,   tone: "neg" },
      { label: "Cost of Goods Sold",      source: "Triple Whale",       value: cogs,        tone: "neg" },
      { label: "Payment processing fees", source: paymentFeesSource,    value: paymentFees, tone: "neg" },
      { label: "Shipping costs",          source: shipping != null ? "Triple Whale" : "—", value: shipping, tone: "neg" },
      { label: "Ad spend",                source: "Triple Whale",       value: adSpend,     tone: "neg" },
      { label: "Operational expenses",    source: "Xero",               value: opex,        tone: "neg" },
    ];

    const calculatedNet = rows.reduce((s, r) => s + (r.value ?? 0), 0);

    // Reported net profit — pull from Xero P&L (the system of record) first,
    // then fall back to Jortt for the rare case Xero isn't connected.
    // Match the month key the rest of the waterfall is built around.
    const xeroNetByMonth: Record<string, number> | null =
      data?.xero?.netProfitByMonth && typeof data.xero.netProfitByMonth === "object"
        ? data.xero.netProfitByMonth
        : null;
    const reportedNet =
      (monthKey && xeroNetByMonth?.[monthKey] != null
        ? Number(xeroNetByMonth[monthKey])
        : null) ??
      (data?.jortt?.plSummary?.grossProfit != null
        ? Number(data.jortt.plSummary.grossProfit)
        : null);
    const reportedSource: Source =
      monthKey && xeroNetByMonth?.[monthKey] != null
        ? "Xero"
        : data?.jortt?.plSummary?.grossProfit != null
          ? "Jortt"
          : "—";
    const variance = reportedNet != null ? calculatedNet - reportedNet : null;

    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.value ?? 0)), Math.abs(calculatedNet), Math.abs(reportedNet ?? 0));

    return { rows, calculatedNet, reportedNet, reportedSource, variance, maxAbs, lineCount: rows.filter((r) => r.value != null).length };
  }, [data]);

  const xeroConnected = !!data?.connections?.xero;

  return (
    <DashboardShell user={user} title="Reconciliation">
      <div className="px-6 py-6 space-y-4 max-w-[1240px] mx-auto w-full">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[12px] text-neutral-500">Reconciliation</div>
            <h1 className="text-[22px] font-semibold tracking-tight mt-0.5">Profit Variance</h1>
            <p className="text-[13px] text-neutral-500 mt-1">Shopify-calculated profit cross-checked against Jortt totals.</p>
          </div>
          <button className="inline-flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-[13px] font-medium hover:bg-neutral-50">
            <Plus className="h-3.5 w-3.5" />
            Manual journal entry
          </button>
        </div>

        {/* Bridge mode banner */}
        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <div className="flex items-start gap-3">
            <Info className="h-4 w-4 text-neutral-500 mt-0.5 shrink-0" />
            <div className="text-[13px]">
              <div className="font-semibold text-neutral-900">
                Bridge mode {xeroConnected ? "— Xero connected" : "— Xero migration in progress"}
              </div>
              <div className="text-neutral-500 mt-0.5">
                Reconciliation runs against Jortt aggregate totals.{" "}
                {xeroConnected
                  ? "Per-journal-entry drilldown is now available for items tagged with a Xero dot."
                  : "Per-journal-entry drilldown activates automatically once Xero is connected (est. within 1 month). Items tagged below with a Xero dot will become fully traceable."}
              </div>
            </div>
          </div>
        </div>

        {/* Variance alert */}
        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-md bg-amber-50 ring-1 ring-amber-200">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
              </div>
              <div>
                <div className="text-[14px] font-semibold text-neutral-900">
                  {computed.variance == null
                    ? "Variance unavailable — Jortt P&L not loaded"
                    : computed.variance > 0
                      ? `Overstated profit of ${fmtMoney(computed.variance)}`
                      : computed.variance < 0
                        ? `Understated profit of ${fmtMoney(Math.abs(computed.variance))}`
                        : "No variance — books reconcile"}
                </div>
                <div className="text-[12px] text-neutral-500 mt-0.5">
                  Calculated {fmtMoney(computed.calculatedNet)} · {computed.reportedSource} reported {fmtMoney(computed.reportedNet)} · {computed.lineCount} line items explain the gap
                </div>
              </div>
            </div>
            <button className="inline-flex items-center rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-[13px] font-medium hover:bg-neutral-50">
              Drill down
            </button>
          </div>
        </div>

        {/* Profit waterfall */}
        <div className="rounded-xl border border-neutral-200 bg-white">
          <div className="px-5 pt-5 pb-3">
            <div className="text-[14px] font-semibold">Profit waterfall</div>
            <div className="text-[12px] text-neutral-500 mt-0.5">Every dollar from gross revenue to net profit, traced to source system.</div>
          </div>

          <div className="divide-y divide-neutral-100">
            {loading ? (
              <div className="py-10 text-center text-[13px] text-neutral-400">Loading…</div>
            ) : (
              computed.rows.map((r) => {
                // Defensive lookup — any unmapped source falls back to neutral
                // styling instead of crashing the route on `.cls of undefined`.
                const meta = SOURCE_META[r.source] ?? { cls: "text-neutral-400" };
                const pct = r.value != null ? (Math.abs(r.value) / computed.maxAbs) * 100 : 0;
                const isPos = r.tone === "pos";
                const barColor = isPos ? "bg-neutral-900" : "bg-rose-300/80";
                const valColor = r.value == null ? "text-neutral-400" : isPos ? "text-neutral-900" : "text-rose-600";
                return (
                  <div key={r.label} className="grid grid-cols-12 items-center gap-3 px-5 py-3">
                    <div className="col-span-3 text-[13px] text-neutral-800">{r.label}</div>
                    <div className={`col-span-2 text-[12px] ${meta.cls}`}>{r.source}</div>
                    <div className="col-span-5">
                      <div className="h-1.5 w-full rounded-full bg-neutral-100/70 overflow-hidden">
                        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <div className={`col-span-2 text-right text-[13px] tabular-nums ${valColor}`}>
                      {r.value == null ? "—" : fmtMoney(r.value, { signed: !isPos })}
                    </div>
                  </div>
                );
              })
            )}

            {/* Calculated net */}
            <div className="grid grid-cols-12 items-center gap-3 px-5 py-3 bg-neutral-50/70">
              <div className="col-span-3 text-[13px] font-semibold text-neutral-900 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
                Net profit (calculated)
              </div>
              <div className="col-span-2 text-[12px] text-neutral-500">Calculated</div>
              <div className="col-span-5">
                <div className="h-1.5 w-full rounded-full bg-neutral-100 overflow-hidden">
                  <div className="h-full rounded-full bg-neutral-900" style={{ width: `${(Math.abs(computed.calculatedNet) / computed.maxAbs) * 100}%` }} />
                </div>
              </div>
              <div className="col-span-2 text-right text-[13px] font-semibold tabular-nums text-neutral-900">
                {fmtMoney(computed.calculatedNet)}
              </div>
            </div>

            {/* Reported net profit — pulled from Xero (system of record),
                falls back to Jortt if Xero hasn't posted a net-profit row
                for this month. Title + source pill reflect which one ran. */}
            <div className="grid grid-cols-12 items-center gap-3 px-5 py-3 bg-emerald-50/40">
              <div className="col-span-3 text-[13px] font-semibold text-neutral-900">
                {computed.reportedSource === "Xero"
                  ? "Xero reported net profit"
                  : computed.reportedSource === "Jortt"
                    ? "Jortt reported profit"
                    : "Reported net profit"}
              </div>
              <div className={`col-span-2 text-[12px] ${SOURCE_META[computed.reportedSource]?.cls ?? "text-neutral-400"}`}>
                {computed.reportedSource}
              </div>
              <div className="col-span-5">
                <div className="h-1.5 w-full rounded-full bg-neutral-100 overflow-hidden">
                  <div className="h-full rounded-full bg-emerald-500" style={{ width: `${computed.reportedNet != null ? (Math.abs(computed.reportedNet) / computed.maxAbs) * 100 : 0}%` }} />
                </div>
              </div>
              <div className="col-span-2 text-right text-[13px] font-semibold tabular-nums text-neutral-900">
                {fmtMoney(computed.reportedNet)}
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center justify-between px-5 py-3 border-t border-neutral-100 text-[12px]">
            <div className="flex items-center gap-4 flex-wrap">
              <span className="text-amber-700">Shopify</span>
              <span className="text-sky-700">Triple Whale</span>
              <span className="text-violet-700">Jortt</span>
              <span className="text-neutral-500 inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />Calculated</span>
            </div>
            <span className={xeroConnected ? "text-emerald-700" : "text-neutral-400"}>
              {xeroConnected ? "● Xero connected" : "Xero (incoming)"}
            </span>
          </div>
        </div>

        <div className="text-center text-[11px] text-neutral-400 pt-2">
          Synced · {data?.syncedAt ? new Date(data.syncedAt).toLocaleString() : "—"} · Live data with calculated bridge values
        </div>
      </div>
    </DashboardShell>
  );
}
