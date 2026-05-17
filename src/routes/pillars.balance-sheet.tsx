import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Wallet, Plug, Box, LineChart, ChevronDown } from "lucide-react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { getDashboardData } from "@/server/dashboard.functions";

export const Route = createFileRoute("/pillars/balance-sheet")({
  head: () => ({ meta: [{ title: "Balance Sheet — Zapply" }] }),
  component: BalanceSheetPage,
});

// ───────── helpers ─────────
function SkeletonBox({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-neutral-200/70 ${className}`} />;
}

const DASH = "—";

function ccySym(c?: string) {
  return c === "GBP" ? "£" : c === "USD" ? "$" : "€";
}

function fmt(n: number | null | undefined, ccy = "EUR"): string {
  if (n == null || !isFinite(n as number)) return DASH;
  const num = n as number;
  const sign = num < 0 ? "-" : "";
  const v = Math.abs(Math.round(num)).toLocaleString("en-GB");
  return `${sign}${ccySym(ccy)}${v}`;
}

function fmtSigned(n: number | null | undefined, ccy = "EUR"): string {
  if (n == null || !isFinite(n as number)) return DASH;
  const num = n as number;
  const sign = num > 0 ? "+" : num < 0 ? "-" : "";
  const v = Math.abs(Math.round(num)).toLocaleString("en-GB");
  return `${sign}${ccySym(ccy)}${v}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !isFinite(n as number)) return DASH;
  return `${(n as number) > 0 ? "+" : ""}${(n as number).toFixed(1)}%`;
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-neutral-200 bg-white ${className}`}>{children}</div>;
}

function Row({
  label,
  sub,
  value,
  bold,
  neg,
  divider,
}: {
  label: string;
  sub?: string;
  value: string;
  bold?: boolean;
  neg?: boolean;
  divider?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between py-2 ${divider ? "border-t border-neutral-100 mt-1 pt-3" : ""}`}>
      <div>
        <div className={`text-[13px] ${bold ? "font-semibold text-neutral-900" : "text-neutral-700"}`}>{label}</div>
        {sub && <div className="text-[11px] text-neutral-400 mt-0.5">{sub}</div>}
      </div>
      <div
        className={`tabular-nums text-[13px] ${bold ? "font-semibold" : "font-medium"} ${
          neg ? "text-rose-600" : "text-neutral-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

// Row that renders a bank/platform balance plus a Jortt/Xero breakdown.
// When both sources contributed we show:
//   - a "Xero + Jortt" pill next to the name
//   - a per-source line under the headline value
//   - a native title tooltip with absolute amounts so the user can verify
//     the books agree across systems
// When only one source contributed we show that source as a single pill so
// it's still obvious where the number came from.
function BankRow({
  row,
  fmt,
  subtitle,
}: {
  row: {
    name: string;
    balance: number;
    currency: string;
    sources: { xero: number | null; jortt: number | null };
  };
  fmt: (n: number | null | undefined, currency?: string) => string;
  subtitle?: string;
}) {
  const { xero, jortt } = row.sources;
  const hasXero = xero != null;
  const hasJortt = jortt != null;
  const bothSources = hasXero && hasJortt;
  const sourceLabel = bothSources
    ? "Xero + Jortt"
    : hasXero
      ? "Xero"
      : hasJortt
        ? "Jortt"
        : null;
  const titleParts: string[] = [];
  if (hasXero) titleParts.push(`Xero: ${fmt(xero ?? 0, row.currency)}`);
  if (hasJortt) titleParts.push(`Jortt: ${fmt(jortt ?? 0, row.currency)}`);
  if (bothSources) titleParts.push(`Combined: ${fmt(row.balance, row.currency)}`);
  const title = titleParts.join(" · ");
  return (
    <div
      className="flex items-center justify-between border-t border-neutral-100 py-3 first:border-t-0 first:pt-0"
      title={title || undefined}
    >
      <div className="flex items-center gap-3 min-w-0">
        <BankIcon name={row.name} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <div className="text-[13px] font-medium text-neutral-900">{row.name}</div>
            {sourceLabel && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                  bothSources
                    ? "bg-violet-100 text-violet-700"
                    : hasXero
                      ? "bg-sky-100 text-sky-700"
                      : "bg-amber-100 text-amber-700"
                }`}
              >
                {sourceLabel}
              </span>
            )}
          </div>
          <div className="text-[11px] text-neutral-400">{subtitle ?? row.name}</div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-[14px] font-semibold tabular-nums">{fmt(row.balance, row.currency)}</div>
        {bothSources ? (
          <div className="text-[10px] text-neutral-500 tabular-nums">
            X {fmt(xero ?? 0, row.currency)} · J {fmt(jortt ?? 0, row.currency)}
          </div>
        ) : (
          <div className="text-[10px] uppercase tracking-wider text-neutral-400">{row.currency}</div>
        )}
      </div>
    </div>
  );
}

function BankIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  let bg = "bg-neutral-900 text-white";
  let label = name.slice(0, 3).toUpperCase();
  if (n.includes("ing")) {
    bg = "bg-orange-500 text-white";
    label = "ING";
  } else if (n.includes("revolut")) {
    bg = "bg-neutral-900 text-white";
    label = "R";
  } else if (n.includes("mollie")) {
    bg = "bg-neutral-900 text-white";
    label = "M";
  } else if (n.includes("shopify")) {
    bg = "bg-emerald-500 text-white";
    label = "S";
  } else if (n.includes("paypal")) {
    bg = "bg-blue-500 text-white";
    label = "P";
  }
  return (
    <div className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-[10px] font-bold ${bg}`}>
      {label}
    </div>
  );
}

function severityBadge(pct: number) {
  if (pct >= 30) return { label: "high", cls: "bg-rose-100 text-rose-700" };
  if (pct >= 15) return { label: "medium", cls: "bg-amber-100 text-amber-700" };
  return { label: "low", cls: "bg-neutral-100 text-neutral-600" };
}

// ───────── component ─────────
function BalanceSheetPage() {
  const { user } = useDashboardSession();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeCat, setActiveCat] = useState<string>("supplier");
  const [showWeeks, setShowWeeks] = useState(false);
  const [activeBlock, setActiveBlock] = useState<"cash" | "inventory" | "topay" | "toreceive" | null>("cash");

  useEffect(() => {
    let alive = true;
    getDashboardData()
      .then((d) => alive && setData(d))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const { xero, xeroError, jortt, shopifyPayouts, paypalBalances, mollieBalances, syncedAt } = useMemo(() => {
    const xero =
      data?.xero && typeof data.xero === "object" && !data.xero.__empty && !data.xero.__error
        ? data.xero
        : null;
    const xeroError: string | null =
      data?.xero && typeof data.xero === "object" && (data.xero as any).__error
        ? String((data.xero as any).message ?? "Xero sync failed")
        : null;
    const jortt =
      data?.jortt && typeof data.jortt === "object" && !data.jortt.__empty && !data.jortt.__error
        ? data.jortt
        : null;
    const pickLive = (k: string) => {
      const v = (data as any)?.[k];
      return v && typeof v === "object" && !v.__empty && !v.__error ? v : null;
    };
    return {
      xero,
      xeroError,
      jortt,
      shopifyPayouts: pickLive("shopifyPayouts"),
      paypalBalances: pickLive("paypalBalances"),
      mollieBalances: pickLive("mollieBalances"),
      syncedAt: data?.syncedAt ?? null,
    };
  }, [data]);

  // ── derive figures (real data only, "—" otherwise) ──
  const {
    asOfDate,
    bankAccountsAll,
    bankAccountsBank,
    platformPending,
    cashBank,
    cashPlatforms,
    cashTotal,
    inventoryItems,
    inventoryTotal,
    receivables,
    prepaidExpenses,
    currentAssets,
    fixedAssetsCost,
    accumDepreciation,
    fixedAssetsNet,
    totalAssets,
    apSupplier,
    apMeta,
    vatPayable,
    otherPayables,
    accruedExpenses,
    totalCurrentLiabilities,
    shareCapital,
    retainedEarnings,
    ytdResult,
    totalEquity,
    totalLiabEquity,
    outstandingTotal,
    outstandingBreakdown,
    currentRatio,
    quickRatio,
    inventoryDays,
    inventoryDaysSource,
    suppliersInvoices,
  } = useMemo(() => {
    const asOf = syncedAt ? new Date(syncedAt) : new Date();
    const asOfDate = asOf.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    // ── Bank accounts — MERGE Xero + Jortt ──
    // The previous implementation deduped by name keeping ONLY the first
    // source (Xero won, Jortt was silently dropped on overlap). That hid
    // accounts the user had in Jortt entirely, and made it impossible to
    // verify the books matched between systems. Now each unique name
    // records contributions from both sources; the displayed `balance` is
    // the sum, and the row keeps the per-source values so the UI can render
    // a "Xero €X · Jortt €Y" breakdown on hover.
    //
    // Jortt's /v3/bank_accounts payload uses `current_balance.value`; Xero's
    // is already normalized upstream to `balance`. Normalize here.
    type BankSources = { xero: number | null; jortt: number | null };
    const xeroBanks: any[] = Array.isArray(xero?.bankAccounts) ? xero.bankAccounts : [];
    const jorttBanks: any[] = Array.isArray(jortt?.bankAccounts) ? jortt.bankAccounts : [];
    const merged = new Map<
      string,
      { name: string; balance: number; currency: string; sources: BankSources }
    >();
    const addSource = (b: any, source: "xero" | "jortt") => {
      const name = String(b?.name ?? "").trim();
      if (!name) return;
      const k = name.toLowerCase();
      const rawBalance =
        b?.balance ??
        b?.current_balance?.value ??
        b?.current_balance ??
        b?.balance?.value ??
        0;
      const value = Number(rawBalance);
      if (!Number.isFinite(value)) return;
      const currency = String(b?.currency ?? "EUR");
      const existing = merged.get(k);
      if (!existing) {
        merged.set(k, {
          name,
          balance: value,
          currency,
          sources: source === "xero" ? { xero: value, jortt: null } : { xero: null, jortt: value },
        });
      } else {
        existing.balance += value;
        existing.sources[source] = (existing.sources[source] ?? 0) + value;
      }
    };
    for (const b of xeroBanks) addSource(b, "xero");
    for (const b of jorttBanks) addSource(b, "jortt");
    const bankAccountsAll = Array.from(merged.values());
    const isPlatform = (n: string) =>
      /(mollie|shopify|paypal|stripe|adyen|klarna|amazon|revolut pay)/i.test(n);
    const bankAccountsBank = bankAccountsAll.filter((b) => !isPlatform(b.name));
    const platformPending = bankAccountsAll.filter((b) => isPlatform(b.name));

    // Helper to ensure a platform row appears even with zero balance.
    // Platform rows don't have a Jortt/Xero split — they come from the
    // platform API directly — so `sources` stays empty. The UI only shows
    // the breakdown tooltip when at least one of xero/jortt is non-null.
    const seen = new Set(platformPending.map((p) => p.name.toLowerCase()));
    const pushPlatform = (row: { name: string; balance: number; currency: string }) => {
      const key = row.name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      platformPending.push({ ...row, sources: { xero: null, jortt: null } });
    };

    // Shopify Payments — one row per market (live or not)
    const spMarkets: any[] = Array.isArray(shopifyPayouts?.markets)
      ? shopifyPayouts.markets
      : [];
    if (spMarkets.length === 0) {
      pushPlatform({ name: "Shopify Payments", balance: 0, currency: "EUR" });
    } else {
      for (const m of spMarkets) {
        const pending = Number(m.pendingBalance ?? 0) + Number(m.scheduledPayouts ?? 0);
        pushPlatform({
          name: m.name ?? `Shopify Payments ${m.market ?? ""}`.trim(),
          balance: pending,
          currency: String(m.currency ?? "EUR"),
        });
      }
    }

    // PayPal balances
    const ppAccounts: any[] = Array.isArray(paypalBalances?.accounts) ? paypalBalances.accounts : [];
    if (ppAccounts.length === 0) {
      pushPlatform({ name: "PayPal", balance: 0, currency: "EUR" });
    } else {
      for (const a of ppAccounts) {
        pushPlatform({
          name: String(a.name ?? "PayPal"),
          balance: Number(a.balance ?? 0),
          currency: String(a.currency ?? "EUR"),
        });
      }
    }

    // Mollie balances
    const mlAccounts: any[] = Array.isArray(mollieBalances?.accounts) ? mollieBalances.accounts : [];
    if (mlAccounts.length === 0) {
      pushPlatform({ name: "Mollie", balance: 0, currency: "EUR" });
    } else {
      for (const a of mlAccounts) {
        pushPlatform({
          name: String(a.name ?? "Mollie"),
          balance: Number(a.balance ?? 0),
          currency: String(a.currency ?? "EUR"),
        });
      }
    }

    // Revolut Pay (merchant payouts) — placeholder until API is wired
    pushPlatform({ name: "Revolut Pay", balance: 0, currency: "EUR" });

    // The manual cash_positions table was retired; cash now comes
    // exclusively from Xero bankAccounts + Shopify/PayPal/Mollie payouts
    // pulled in above.

    const cashBank = bankAccountsBank.length
      ? bankAccountsBank.reduce((s, b) => s + (b.balance ?? 0), 0)
      : null;
    const cashPlatforms = platformPending.length
      ? platformPending.reduce((s, b) => s + (b.balance ?? 0), 0)
      : null;
    const cashTotal =
      cashBank == null && cashPlatforms == null
        ? xero?.cashBalance ?? null
        : (cashBank ?? 0) + (cashPlatforms ?? 0);

    // ── Inventory (Xero items: tracked) ──
    const items: any[] = Array.isArray(xero?.items) ? xero.items : [];
    const tracked = items.filter(
      (i) => i?.isTracked && (i?.qtyOnHand ?? 0) > 0 && (i?.purchasePrice ?? 0) > 0,
    );
    const inventoryItems = tracked
      .map((i) => {
        const qty = Number(i.qtyOnHand ?? 0);
        const cost = Number(i.purchasePrice ?? 0);
        const value = qty * cost;
        const code = String(i.code ?? "").toUpperCase();
        let location = "NL";
        if (/uk|gb/.test(code) || /uk/i.test(i.name ?? "")) location = "GB";
        else if (/us/.test(code) || /us/i.test(i.name ?? "")) location = "US";
        return {
          name: String(i.name ?? i.code ?? "Item"),
          location,
          unitCost: cost,
          pieces: qty,
          value,
        };
      })
      .sort((a, b) => b.value - a.value);

    // Augment with Picqer-sourced inventory. The dashboard loader publishes
    // these under `manual.inventoryPositions` for historical reasons — the
    // manual inventory table that used to also feed this array was retired,
    // so this is now Picqer rows only.
    const picqerInv: any[] = Array.isArray((data as any)?.manual?.inventoryPositions)
      ? (data as any).manual.inventoryPositions
      : [];
    for (const m of picqerInv) {
      const qty = Number(m.pieces ?? 0);
      const cost = Number(m.unit_cost_eur ?? 0);
      inventoryItems.push({
        name: String(m.name ?? m.sku ?? "Item"),
        location: String(m.location ?? "NL"),
        unitCost: cost,
        pieces: qty,
        value: qty * cost,
        imageUrl: typeof m.imageUrl === "string" ? m.imageUrl : null,
      });
    }
    inventoryItems.sort((a, b) => b.value - a.value);

    const inventoryTotal = inventoryItems.length
      ? inventoryItems.reduce((s, i) => s + i.value, 0)
      : null;

    // ── Receivables / payables / equity (Xero + Jortt fallbacks) ──
    // AR: Xero balance row, else sum of customers' outstanding, else Jortt unpaid invoices
    const customers: any[] = Array.isArray(xero?.customers) ? xero.customers : [];
    const customersOutstanding = customers.reduce(
      (s, c) => s + Number(c?.outstanding ?? 0),
      0,
    );
    const jorttUnpaid = Number(jortt?.unpaidAmount ?? jortt?.openInvoicesAmount ?? 0);
    const receivables =
      xero?.accountsReceivable ??
      (customersOutstanding > 0 ? customersOutstanding : null) ??
      (jorttUnpaid > 0 ? jorttUnpaid : null);

    const prepaidExpenses: number | null = null;
    const totalAssets = xero?.totalAssets ?? null;

    // Current assets: use Xero value, else sum bank balances + receivables + inventory
    const cashLikeFallback =
      cashTotal != null || (receivables != null) || (inventoryTotal != null)
        ? (cashTotal ?? 0) + (receivables ?? 0) + (inventoryTotal ?? 0)
        : null;
    const currentAssets = xero?.currentAssets ?? cashLikeFallback;

    // Fixed assets: Xero value, else derive (totalAssets - currentAssets)
    const fixedAssetsNet =
      xero?.fixedAssets ??
      (totalAssets != null && currentAssets != null ? totalAssets - currentAssets : null);
    const fixedAssetsCost: number | null = null;
    const accumDepreciation: number | null = null;

    // ── Outstanding payments (suppliers + bills awaiting) ──
    const suppliers: any[] = Array.isArray(xero?.suppliers) ? xero.suppliers : [];
    const apSupplierList = suppliers
      .filter((s) => (s.outstanding ?? 0) > 0)
      .filter((s) => !/(meta|facebook|google|tiktok|ads)/i.test(s.name ?? ""));
    const apMetaList = suppliers.filter(
      (s) => /(meta|facebook|google|tiktok|ads)/i.test(s.name ?? "") && (s.outstanding ?? 0) > 0,
    );

    // Supplier AP: prefer summed list, fall back to Xero bills awaiting + overdue
    const billsAwaiting = Number(xero?.billsAwaitingAmount ?? 0);
    const billsOverdue = Number(xero?.overdueBillsAmount ?? 0);
    const apSupplier = apSupplierList.length
      ? apSupplierList.reduce((s, x) => s + (x.outstanding ?? 0), 0)
      : billsAwaiting + billsOverdue > 0
        ? billsAwaiting + billsOverdue
        : null;
    const apMeta = apMetaList.length
      ? apMetaList.reduce((s, x) => s + (x.outstanding ?? 0), 0)
      : null;

    const totalCurrentLiabilities =
      xero?.currentLiabilities ?? xero?.totalLiabilities ?? null;

    // VAT / other payables — derive remainder of liabilities not allocated
    const knownAp = (apSupplier ?? 0) + (apMeta ?? 0);
    const vatPayable =
      totalCurrentLiabilities != null && Math.abs(totalCurrentLiabilities) > knownAp
        ? Math.abs(totalCurrentLiabilities) - knownAp
        : null;
    const otherPayables: number | null = null;
    const accruedExpenses: number | null = null;

    const equity = xero?.equity ?? null;
    const ytdResult = xero?.ytdNetProfit ?? null;
    // Retained earnings = total equity - current YTD result (when both known)
    const retainedEarnings =
      equity != null && ytdResult != null ? equity - ytdResult : null;
    const shareCapital: number | null = null;
    const totalEquity = equity;
    const totalLiabEquity =
      totalCurrentLiabilities != null && totalEquity != null
        ? totalCurrentLiabilities + totalEquity
        : null;

    // ── Outstanding breakdown ──
    const outstandingSum =
      (apSupplier ?? 0) + (apMeta ?? 0) + (vatPayable ?? 0) + (otherPayables ?? 0);
    const breakdownRaw = [
      { key: "supplier", label: "Supplier (supplier invoices)", color: "bg-orange-500", val: apSupplier },
      { key: "ad", label: "Ad network (billing)", color: "bg-violet-500", val: apMeta },
      { key: "vat", label: "VAT & corporate tax", color: "bg-amber-500", val: vatPayable },
      { key: "other", label: "Affiliates & partners", color: "bg-neutral-400", val: otherPayables },
    ];
    const totalForPct = outstandingSum > 0 ? outstandingSum : null;
    const outstandingBreakdown = breakdownRaw.map((b) => {
      const pct = totalForPct && b.val != null ? (b.val / totalForPct) * 100 : null;
      return { ...b, pct };
    });

    // ── Ratios (use absolute values to avoid Xero's sign convention skew) ──
    const ca = currentAssets != null ? Math.abs(currentAssets) : null;
    const cl = totalCurrentLiabilities != null ? Math.abs(totalCurrentLiabilities) : null;
    const currentRatio = ca != null && cl && cl !== 0 ? ca / cl : null;
    const quickRatio =
      ca != null && cl && cl !== 0 ? (ca - (inventoryTotal ?? 0)) / cl : null;

    // ── Inventory days = Inventory ÷ (Annual COGS / 365) ──
    // Prefer the real number when Xero reports both revenue and gross profit:
    // COGS = Revenue − Gross Profit, summed over the last 12 months. When
    // grossProfitByMonth is empty (Demo orgs / unconfigured charts of accounts
    // / new tenants) we extrapolate annual COGS from YTD revenue × the
    // industry-standard 45% COGS heuristic used elsewhere in the dashboard
    // (see daily-pnl pillar) so the tile still renders a useful estimate.
    const sumValues = (obj: any): number => {
      if (!obj || typeof obj !== "object") return 0;
      return Object.values(obj).reduce<number>(
        (s, v) => s + (typeof v === "number" && Number.isFinite(v) ? v : 0),
        0,
      );
    };
    const revTtm = sumValues((xero as any)?.revenueByMonth);
    const gpTtm = sumValues((xero as any)?.grossProfitByMonth);
    const monthsWithGp = Object.values((xero as any)?.grossProfitByMonth ?? {}).filter(
      (v) => typeof v === "number" && v !== 0,
    ).length;
    let cogsAnnual: number | null = null;
    if (monthsWithGp > 0 && revTtm > 0) {
      cogsAnnual = Math.max(0, revTtm - gpTtm);
    } else {
      const ytdRev = Number((xero as any)?.ytdRevenue ?? 0);
      const monthsElapsed = Math.max(1, new Date().getUTCMonth() + 1);
      if (ytdRev > 0) cogsAnnual = (ytdRev * 12) / monthsElapsed * 0.45;
    }
    const inventoryDays =
      cogsAnnual && cogsAnnual > 0 && inventoryTotal && inventoryTotal > 0
        ? inventoryTotal / (cogsAnnual / 365)
        : null;
    const inventoryDaysSource: "actual" | "estimated" | null =
      inventoryDays == null ? null : monthsWithGp > 0 ? "actual" : "estimated";

    // ── Supplier invoice line items (use Xero bills if exposed, else show top suppliers) ──
    const suppliersInvoices = apSupplierList
      .slice(0, 12)
      .map((s, idx) => ({
        ref: `INV-${String(idx + 1).padStart(4, "0")}`,
        date: null as string | null,
        name: s.name,
        amount: s.outstanding ?? 0,
      }));

    return {
      asOfDate,
      bankAccountsAll,
      bankAccountsBank,
      platformPending,
      cashBank,
      cashPlatforms,
      cashTotal,
      inventoryItems,
      inventoryTotal,
      receivables,
      prepaidExpenses,
      currentAssets,
      fixedAssetsCost,
      accumDepreciation,
      fixedAssetsNet,
      totalAssets,
      apSupplier,
      apMeta,
      vatPayable,
      otherPayables,
      accruedExpenses,
      totalCurrentLiabilities,
      shareCapital,
      retainedEarnings,
      ytdResult,
      totalEquity,
      totalLiabEquity,
      outstandingTotal: outstandingSum > 0 ? outstandingSum : null,
      outstandingBreakdown,
      currentRatio,
      quickRatio,
      inventoryDays,
      inventoryDaysSource,
      suppliersInvoices,
    };
  }, [xero, jortt, shopifyPayouts, paypalBalances, mollieBalances, syncedAt, data]);

  // ── Weekly trend (last 8 weeks) — derived from Xero monthly net profit ──
  type WeekRow = {
    label: string;
    range: string;
    cash: number | null;
    cashAfterDebt: number | null;
    cashPlusAssetsAfterDebt: number | null;
    wowAbs: number | null;
    wowPct: number | null;
  };
  const weeklyTrend = useMemo<WeekRow[]>(() => {
    if (cashTotal == null) return [];

    // Build a per-month EBITDA map from Xero (keys like "29 Apr 26")
    const npm: Record<string, number> = (xero?.netProfitByMonth ?? {}) as Record<string, number>;
    const monthEntries = Object.entries(npm)
      .map(([k, v]) => ({ date: new Date(k), value: Number(v) || 0 }))
      .filter((e) => !isNaN(e.date.getTime()))
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    const today = syncedAt ? new Date(syncedAt) : new Date();
    // Find Monday of the current week
    const dow = today.getDay(); // 0 Sun..6 Sat
    const offsetToMon = (dow + 6) % 7;
    const currentMon = new Date(today);
    currentMon.setHours(0, 0, 0, 0);
    currentMon.setDate(currentMon.getDate() - offsetToMon);

    // Build 8 week start dates (Mondays), oldest first
    const weeks: { start: Date; end: Date; weekNo: number }[] = [];
    for (let i = 7; i >= 0; i--) {
      const start = new Date(currentMon);
      start.setDate(start.getDate() - i * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      // ISO week number
      const tmp = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()));
      const dayNum = (tmp.getUTCDay() + 6) % 7;
      tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
      const firstThursday = tmp.valueOf();
      tmp.setUTCMonth(0, 1);
      if (tmp.getUTCDay() !== 4) tmp.setUTCMonth(0, 1 + ((4 - tmp.getUTCDay()) + 7) % 7);
      const weekNo = 1 + Math.ceil((firstThursday - tmp.valueOf()) / 604800000);
      weeks.push({ start, end, weekNo });
    }

    // Estimate cash position at each week-end:
    // Anchor "current" to today's cashTotal; walk backward subtracting weekly EBITDA
    // (weekly EBITDA = monthly EBITDA delta / ~4.33).
    const monthlyDeltas: number[] = [];
    for (let i = 1; i < monthEntries.length; i++) {
      monthlyDeltas.push(monthEntries[i].value - monthEntries[i - 1].value);
    }
    const avgMonthlyDelta =
      monthlyDeltas.length > 0
        ? monthlyDeltas.slice(-3).reduce((s, v) => s + v, 0) / Math.min(3, monthlyDeltas.length)
        : 0;
    const weeklyDelta = avgMonthlyDelta / 4.33;

    const cashByWeek: number[] = new Array(weeks.length).fill(0);
    cashByWeek[weeks.length - 1] = cashTotal;
    for (let i = weeks.length - 2; i >= 0; i--) {
      cashByWeek[i] = cashByWeek[i + 1] - weeklyDelta;
    }

    const debt = outstandingTotal ?? 0;
    const assetsExtra =
      totalAssets != null && cashTotal != null ? totalAssets - cashTotal : inventoryTotal ?? 0;

    const monthShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const fmtRange = (s: Date, e: Date) => {
      const sM = monthShort[s.getMonth()];
      const eM = monthShort[e.getMonth()];
      return sM === eM ? `${sM} ${s.getDate()}–${e.getDate()}` : `${sM} ${s.getDate()}–${eM} ${e.getDate()}`;
    };

    return weeks.map((w, i) => {
      const cash = cashByWeek[i];
      const prev = i > 0 ? cashByWeek[i - 1] : null;
      const wowAbs = prev != null ? cash - prev : null;
      const wowPct = prev != null && prev !== 0 ? (wowAbs! / Math.abs(prev)) * 100 : null;
      return {
        label: `W${w.weekNo}`,
        range: fmtRange(w.start, w.end),
        cash,
        cashAfterDebt: cash - debt,
        cashPlusAssetsAfterDebt: cash + assetsExtra - debt,
        wowAbs,
        wowPct,
      };
    });
  }, [xero, syncedAt, cashTotal, outstandingTotal, totalAssets, inventoryTotal]);


  if (loading) {
    return (
      <DashboardShell user={user} title="Balance Sheet">
        <div className="p-6 space-y-4">
          <SkeletonBox className="h-8 w-64" />
          <SkeletonBox className="h-4 w-96" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonBox key={i} className="h-28" />
            ))}
          </div>
          <SkeletonBox className="h-72 mt-3" />
        </div>
      </DashboardShell>
    );
  }

  const liquidityShortfall =
    cashTotal != null && outstandingTotal != null && cashTotal < outstandingTotal;

  return (
    <DashboardShell user={user} title="Balance Sheet">
      <div className="mx-auto max-w-[1200px] p-6 space-y-4">
        {/* Header */}
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[12px] font-medium text-neutral-400">Pillar 4</div>
            <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Balance Sheet</h1>
            <p className="mt-1 text-[13px] text-neutral-500">
              Financial position · as of {asOfDate} · all amounts in EUR
            </p>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-neutral-400">Total Assets</div>
            <div
              className={`mt-1 text-[26px] font-semibold tabular-nums ${
                (totalAssets ?? 0) < 0 ? "text-rose-600" : "text-neutral-900"
              }`}
            >
              {fmt(totalAssets)}
            </div>
          </div>
        </div>

        {/* Liquidity check banner */}
        {liquidityShortfall && (
          <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
            <AlertTriangle className="mt-0.5 shrink-0 text-amber-600" size={18} />
            <div className="text-[13px]">
              <div className="font-semibold text-amber-900">
                Liquidity check: {fmt(cashTotal)} cash vs {fmt(outstandingTotal)} outstanding
              </div>
              <div className="mt-1 text-amber-800/90">
                Not all payables are due immediately — Supplier has 60-day terms, META bills rolling, VAT includes
                accruing 2026 liabilities not yet due. See outstanding breakdown below for timing.
              </div>
            </div>
          </div>
        )}

        {/* Compact 4-block balance sheet — Cash · Inventory · To be Paid · To be Received */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {([
            {
              key: "cash" as const,
              label: "Cash",
              value: cashTotal,
              sub:
                cashBank != null || cashPlatforms != null
                  ? `Bank ${fmt(cashBank)} · Platforms ${fmt(cashPlatforms)}`
                  : "Bank + payment processors",
              tone: (cashTotal ?? 0) < 0 ? "text-rose-600" : "text-emerald-600",
              ring: "hover:border-emerald-400",
            },
            {
              key: "inventory" as const,
              label: "Inventory",
              value: inventoryTotal,
              sub: inventoryItems.length
                ? `${inventoryItems.length} SKUs at cost`
                : "Stock at cost",
              tone: "text-neutral-900",
              ring: "hover:border-neutral-900",
            },
            {
              key: "topay" as const,
              label: "To be Paid",
              value: outstandingTotal,
              sub:
                (apSupplier ?? 0) + (apMeta ?? 0) + (vatPayable ?? 0) > 0
                  ? `Suppliers · Ads · VAT`
                  : "AP + VAT + other",
              tone: "text-rose-600",
              ring: "hover:border-rose-300",
            },
            {
              key: "toreceive" as const,
              label: "To be Received",
              value:
                (receivables ?? 0) + (cashPlatforms ?? 0) > 0
                  ? (receivables ?? 0) + (cashPlatforms ?? 0)
                  : receivables,
              sub: "Customer AR + Shopify, PayPal, Mollie pending",
              tone: "text-neutral-900",
              ring: "hover:border-neutral-900",
            },
          ]).map((b) => {
            const isActive = activeBlock === b.key;
            return (
              <button
                key={b.key}
                onClick={() => setActiveBlock(isActive ? null : b.key)}
                className={`rounded-xl border bg-white p-5 text-left transition ${b.ring} ${
                  isActive ? "border-neutral-900 shadow-sm" : "border-neutral-200"
                }`}
              >
                <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  {b.label}
                </div>
                <div className={`mt-2 text-[24px] font-semibold tabular-nums leading-none ${b.tone}`}>
                  {fmt(b.value)}
                </div>
                <div className="mt-2 text-[11px] text-neutral-400">{b.sub}</div>
                <div className="mt-3 text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                  {isActive ? "▾ Showing line items" : "▸ Click for line items"}
                </div>
              </button>
            );
          })}
        </section>

        {/* Ratios */}
        <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Card className="p-5">
            <div className="text-[12px] text-neutral-500">Current ratio</div>
            <div className="mt-2 text-[34px] font-semibold tabular-nums leading-none">
              {currentRatio != null ? currentRatio.toFixed(1) : DASH}
            </div>
            <div className="mt-3 text-[11px] text-rose-600">Current assets vs current liabilities</div>
          </Card>
          <Card className="p-5">
            <div className="text-[12px] text-neutral-500">Quick ratio</div>
            <div className="mt-2 text-[34px] font-semibold tabular-nums leading-none">
              {quickRatio != null ? quickRatio.toFixed(1) : DASH}
            </div>
            <div className="mt-3 text-[11px] text-rose-600">Excludes inventory</div>
          </Card>
          <Card className="p-5">
            <div className="text-[12px] text-neutral-500">Cash position</div>
            <div className="mt-2 text-[28px] font-semibold tabular-nums leading-none">{fmt(cashTotal)}</div>
            <div className="mt-3 text-[11px] text-amber-600">Bank + platforms</div>
          </Card>
          <Card className="p-5">
            <div className="text-[12px] text-neutral-500">Inventory days</div>
            <div className="mt-2 text-[28px] font-semibold tabular-nums leading-none">
              {inventoryDays != null ? Math.round(inventoryDays).toLocaleString() : DASH}
            </div>
            <div className="mt-3 text-[11px] text-amber-600">
              Target: 30–45
              {inventoryDaysSource === "estimated" && (
                <span className="ml-1 text-neutral-400">· est. (Xero gross profit not set)</span>
              )}
            </div>
          </Card>
        </section>

        {/* Cash & platform positions */}
        {activeBlock === "cash" && (
        <div id="section-cash"><Card className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[15px] font-semibold">Cash &amp; platform positions</div>
              <div className="mt-1 text-[12px] text-neutral-500">
                Current balances across banks and payment processors
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-neutral-400">Total Liquid</div>
              <div className="mt-0.5 text-[20px] font-semibold tabular-nums">{fmt(cashTotal)}</div>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-x-10 gap-y-4 md:grid-cols-2">
            <div>
              <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                <Wallet size={13} /> Bank Accounts
              </div>
              {bankAccountsBank.length === 0 ? (
                xeroError && /auth|invalid_grant|refresh token|reconnect/i.test(xeroError) ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-[12px] text-red-800">
                    <div className="font-semibold mb-1">Xero is disconnected</div>
                    <div className="text-red-700/90 break-words">{xeroError}</div>
                    <a
                      href="/api/auth/xero"
                      className="mt-2 inline-flex items-center rounded-md border border-red-300 bg-white px-2.5 py-1 text-[11px] font-medium text-red-800 hover:bg-red-100"
                    >
                      Reconnect Xero
                    </a>
                  </div>
                ) : xeroError ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-800">
                    <div className="font-semibold mb-1">Xero sync error</div>
                    <div className="text-amber-700/90 break-words">{xeroError}</div>
                  </div>
                ) : (
                  <div className="text-[13px] text-neutral-400">{DASH}</div>
                )
              ) : (
                bankAccountsBank.map((b, i) => (
                  <BankRow key={`${b.name}-${i}`} row={b} fmt={fmt} />
                ))
              )}
            </div>

            <div>
              <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                <Plug size={13} /> Platform Payouts Pending
              </div>
              {platformPending.length === 0 ? (
                <div className="text-[13px] text-neutral-400">{DASH}</div>
              ) : (
                platformPending.map((b, i) => (
                  <BankRow key={`${b.name}-${i}`} row={b} fmt={fmt} subtitle="Pending payouts" />
                ))
              )}
            </div>
          </div>
        </Card></div>
        )}

        {/* Cash & assets · week over week */}
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <LineChart size={15} />
                <div className="text-[15px] font-semibold">Cash &amp; assets · week over week</div>
                <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600">
                  26 weeks trailing
                </span>
              </div>
              <div className="mt-1 text-[12px] text-neutral-500">
                How much does the business have: cash · cash after debt · cash + assets after debt
              </div>
            </div>
            <div className="text-[12px] text-neutral-500">
              Week <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1">current <ChevronDown size={12} /></span>
            </div>
          </div>

          <div className="mt-5 space-y-4">
            <div className="border-t border-neutral-100 pt-4">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                <span className="h-2 w-2 rounded-full bg-neutral-900" /> Total Cash
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <div className="text-[22px] font-semibold tabular-nums">{fmt(cashTotal)}</div>
                <div className="text-[12px] text-emerald-600">{DASH}</div>
              </div>
              <div className="text-[12px] text-neutral-500">Bank + platforms combined</div>
              <div className="mt-1 text-[11px] text-neutral-400">vs prev week: {DASH}</div>
            </div>

            <div className="border-t border-neutral-100 pt-4">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> Cash after Debt
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <div className="text-[22px] font-semibold tabular-nums">
                  {cashTotal != null && outstandingTotal != null ? fmt(cashTotal - outstandingTotal) : DASH}
                </div>
              </div>
              <div className="text-[12px] text-neutral-500">What's left after paying all outstanding</div>
              <div className="mt-1 text-[11px] text-neutral-400">vs prev week: {DASH}</div>
            </div>

            <div className="border-t border-neutral-100 pt-4">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> Cash + Assets after Debt
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <div className="text-[22px] font-semibold tabular-nums">
                  {totalAssets != null && outstandingTotal != null
                    ? fmt(totalAssets - outstandingTotal)
                    : DASH}
                </div>
              </div>
              <div className="text-[12px] text-neutral-500">Cash + inventory + receivables, after debt</div>
              <div className="mt-1 text-[11px] text-neutral-400">vs prev week: {DASH}</div>
            </div>

            <div className="border-t border-neutral-100 pt-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">26-Week Trend</div>
              <button
                onClick={() => setShowWeeks((v) => !v)}
                className="mt-3 flex w-full items-center justify-between rounded-md border border-neutral-100 px-3 py-2 text-[12px] text-neutral-500 hover:bg-neutral-50"
              >
                <span className="flex items-center gap-2">
                  <ChevronDown size={12} className={showWeeks ? "rotate-180 transition" : "transition"} />
                  LAST 8 WEEKS <span className="text-neutral-400">click to expand</span>
                </span>
                <span className="text-neutral-400">Click a row to select a week</span>
              </button>
              {showWeeks && (
                weeklyTrend.length === 0 ? (
                  <div className="mt-3 text-[12px] text-neutral-400">{DASH}</div>
                ) : (
                  <div className="mt-3 overflow-hidden rounded-lg border border-neutral-100">
                    <div className="grid grid-cols-[0.7fr_1fr_1fr_1.2fr_1fr] bg-neutral-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                      <div>Week</div>
                      <div className="text-right">Cash</div>
                      <div className="text-right">Cash after debt</div>
                      <div className="text-right">Cash + assets after debt</div>
                      <div className="text-right">Δ Cash WoW</div>
                    </div>
                    {weeklyTrend.map((w, i) => {
                      const isCurrent = i === weeklyTrend.length - 1;
                      const wowPos = w.wowAbs != null && w.wowAbs >= 0;
                      return (
                        <div
                          key={w.label}
                          className={`grid grid-cols-[0.7fr_1fr_1fr_1.2fr_1fr] items-center border-t border-neutral-100 px-4 py-3 text-[12px] ${
                            isCurrent ? "bg-neutral-50/60" : ""
                          }`}
                        >
                          <div>
                            <div className="font-medium text-neutral-900">
                              {w.label}{" "}
                              {isCurrent && (
                                <span className="ml-1 text-[10px] font-medium text-emerald-600">current</span>
                              )}
                            </div>
                            <div className="text-[10px] text-neutral-400">{w.range}</div>
                          </div>
                          <div className="text-right tabular-nums font-semibold">{fmt(w.cash)}</div>
                          <div className="text-right tabular-nums text-neutral-700">{fmt(w.cashAfterDebt)}</div>
                          <div className="text-right tabular-nums text-neutral-700">{fmt(w.cashPlusAssetsAfterDebt)}</div>
                          <div className="text-right tabular-nums">
                            <span className={wowPos ? "text-emerald-600 font-medium" : "text-rose-600 font-medium"}>
                              {w.wowAbs == null ? DASH : `${wowPos ? "+" : "-"}${fmt(Math.abs(w.wowAbs)).replace(/^[-]/, "")}`}
                            </span>{" "}
                            <span className="text-[10px] text-neutral-400">
                              {w.wowPct == null ? "" : `(${fmtPct(w.wowPct)})`}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </div>
          </div>
        </Card>

        {/* Outstanding payments — To be Paid drilldown */}
        {activeBlock === "topay" && (
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <AlertTriangle size={15} className="text-rose-500" />
                <div className="text-[15px] font-semibold">Outstanding payments</div>
              </div>
              <div className="mt-1 text-[12px] text-neutral-500">
                Open invoices and accruing obligations · sourced from Xero
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-neutral-400">Total Outstanding</div>
              <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-rose-600">{fmt(outstandingTotal)}</div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {outstandingBreakdown.map((b) => {
              const sev = b.pct != null ? severityBadge(b.pct) : { label: "—", cls: "bg-neutral-100 text-neutral-500" };
              const isActive = activeCat === b.key;
              return (
                <button
                  key={b.key}
                  onClick={() => setActiveCat(b.key)}
                  className={`rounded-xl border p-4 text-left transition ${
                    isActive ? "border-neutral-900" : "border-neutral-200 hover:border-neutral-300"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${b.color}`} />
                      <span className="text-[12px] text-neutral-600">{b.label}</span>
                    </div>
                  </div>
                  <div className="mt-2 text-[20px] font-semibold tabular-nums">{fmt(b.val)}</div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-[11px] text-neutral-400">
                      {b.pct != null ? `${b.pct.toFixed(1)}% of total` : DASH}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${sev.cls}`}>{sev.label}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Drilldown table */}
          <div className="mt-6 border-t border-neutral-100 pt-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[14px] font-semibold">
                  {outstandingBreakdown.find((b) => b.key === activeCat)?.label ?? "Selected category"}
                </div>
                <div className="mt-0.5 text-[12px] text-neutral-500">
                  Open purchase invoices · sourced from Xero
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-neutral-400">Category Total</div>
                <div className="mt-0.5 text-[16px] font-semibold tabular-nums">
                  {fmt(outstandingBreakdown.find((b) => b.key === activeCat)?.val)}
                </div>
              </div>
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-neutral-100">
              <div className="grid grid-cols-[1fr_1fr_1fr] bg-neutral-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                <div>Reference</div>
                <div>Date</div>
                <div className="text-right">Amount</div>
              </div>
              {activeCat === "supplier" && suppliersInvoices.length > 0 ? (
                <div className="max-h-[260px] overflow-y-auto">
                  {suppliersInvoices.map((inv, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[1fr_1fr_1fr] border-t border-neutral-100 px-4 py-2.5 text-[12px]"
                    >
                      <div className="font-mono text-neutral-700">{inv.ref}</div>
                      <div className="text-neutral-500">{inv.date ?? DASH}</div>
                      <div className="text-right tabular-nums font-medium">{fmt(inv.amount)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-6 text-center text-[12px] text-neutral-400">{DASH}</div>
              )}
            </div>
            <div className="mt-3 text-[11px] text-neutral-400">
              ⓘ Click a category above to drill into line items. Sourced from Xero contacts.
            </div>
          </div>
        </Card>
        )}

        {/* Inventory at cost — Inventory drilldown */}
        {activeBlock === "inventory" && (
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-neutral-100 p-2">
                <Box size={15} />
              </div>
              <div>
                <div className="text-[15px] font-semibold">
                  Inventory at cost{inventoryItems.length ? ` — ${inventoryItems.length} SKUs` : ""}
                </div>
                <div className="mt-0.5 text-[12px] text-neutral-500">
                  Stock positions across NL, UK, and US warehouses
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-neutral-400">Total Value</div>
              <div className="mt-0.5 text-[18px] font-semibold tabular-nums">{fmt(inventoryTotal)}</div>
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-lg">
            <div className="grid grid-cols-[44px_2fr_1fr_1fr_1fr_1fr_1.2fr] border-b border-neutral-100 px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              <div></div>
              <div>SKU</div>
              <div>Location</div>
              <div className="text-right">Unit Cost</div>
              <div className="text-right">Pieces</div>
              <div className="text-right">Value</div>
              <div className="text-right">% of Stock</div>
            </div>
            {inventoryItems.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12px] text-neutral-400">{DASH}</div>
            ) : (
              inventoryItems.map((it, i) => {
                const pct = inventoryTotal && inventoryTotal > 0 ? (it.value / inventoryTotal) * 100 : 0;
                return (
                  <div
                    key={`${it.name}-${i}`}
                    className="grid grid-cols-[44px_2fr_1fr_1fr_1fr_1fr_1.2fr] items-center gap-x-2 border-b border-neutral-50 px-2 py-2.5 text-[12px]"
                  >
                    <InventoryThumb src={it.imageUrl} alt={it.name} />
                    <div className="text-neutral-800">{it.name}</div>
                    <div>
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600">
                        {it.location}
                      </span>{" "}
                      <span className="text-neutral-500">{it.location}</span>
                    </div>
                    <div className="text-right tabular-nums text-neutral-700">{fmt(it.unitCost)}</div>
                    <div className="text-right tabular-nums text-neutral-700">{it.pieces}</div>
                    <div className="text-right tabular-nums font-medium">{fmt(it.value)}</div>
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-100">
                        <div className="h-full bg-neutral-800" style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                      <span className="text-[11px] tabular-nums text-neutral-500">{pct.toFixed(1)}%</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Card>
        )}

        {/* To be Received drilldown — Customer AR + Platform pending */}
        {activeBlock === "toreceive" && (
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[15px] font-semibold">To be Received</div>
              <div className="mt-1 text-[12px] text-neutral-500">
                Customer receivables and pending payouts from Shopify Payments, PayPal and Mollie
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-neutral-400">Total Incoming</div>
              <div className="mt-0.5 text-[20px] font-semibold tabular-nums">
                {fmt((receivables ?? 0) + (cashPlatforms ?? 0) || receivables)}
              </div>
            </div>
          </div>

          <div className="mt-4">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
              Customer receivables
            </div>
            <Row label="Accounts receivable" sub="Open customer invoices (Xero / Jortt)" value={fmt(receivables)} />

            <div className="mt-4 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
              Platform payouts pending
            </div>
            {platformPending.length === 0 ? (
              <div className="py-3 text-[12px] text-neutral-400">{DASH}</div>
            ) : (
              platformPending.map((b, i) => (
                <Row
                  key={`${b.name}-${i}`}
                  label={b.name}
                  sub="Pending payout"
                  value={fmt(b.balance, b.currency)}
                />
              ))
            )}
            <Row
              label="Total to be received"
              value={fmt((receivables ?? 0) + (cashPlatforms ?? 0) || receivables)}
              bold
              divider
            />
          </div>
        </Card>
        )}

        <div className="text-center text-[11px] text-neutral-400">
          Synced ·{" "}
          {syncedAt
            ? new Date(syncedAt).toLocaleString("en-GB", {
                day: "numeric",
                month: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            : DASH}{" "}
          · Live data from Xero & Jortt
        </div>
      </div>
    </DashboardShell>
  );
}

// Inventory thumbnail. Optimized for fast first paint:
//   - Fixed 36×36 footprint avoids layout shift while the image streams in.
//   - loading="lazy" lets the browser skip off-screen rows entirely.
//   - decoding="async" keeps decoding off the main render thread.
//   - referrerPolicy="no-referrer" so Picqer CDN can serve cross-origin
//     without leaking the dashboard URL.
//   - onError swap to placeholder so a dead image URL doesn't render broken.
function InventoryThumb({ src, alt }: { src?: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div
        className="flex h-9 w-9 items-center justify-center rounded border border-neutral-200 bg-neutral-50 text-[9px] font-medium text-neutral-400"
        aria-hidden
      >
        IMG
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      width={36}
      height={36}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-9 w-9 rounded border border-neutral-200 bg-neutral-50 object-cover"
    />
  );
}
