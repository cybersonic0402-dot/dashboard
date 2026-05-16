import { authedFetch } from "@/lib/authed-fetch";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { getDashboardData } from "@/server/dashboard.functions";
import { getManualDataSnapshot } from "@/server/manual-data.functions";
import { MarketsView } from "@/components/FinanceDashboard.tsx";

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
      <div className="p-6">
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
      </div>
    </DashboardShell>
  );
}
