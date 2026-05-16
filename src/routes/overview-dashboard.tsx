import { authedFetch } from "@/lib/authed-fetch";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { getDashboardData } from "@/server/dashboard.functions";
import { getManualDataSnapshot } from "@/server/manual-data.functions";
import { OverviewView } from "@/components/FinanceDashboard.tsx";

export const Route = createFileRoute("/overview-dashboard")({
  // Accept any incoming search params (legacy preset/from/to) without erroring
  validateSearch: (input: Record<string, unknown>) => input,
  head: () => ({
    meta: [
      { title: "Overview — Zapply" },
      { name: "description", content: "Live revenue, ad performance and reconciled finance overview." },
    ],
  }),
  component: OverviewPage,
});

// Match drStartOfMonth() / drToday() in FinanceDashboard.tsx (YYYY-MM-DD strings)
function startOfMonthStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgoStr(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return todayStr(d);
}

function SkeletonBox({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-neutral-200/70 ${className}`} />;
}

function OverviewSkeleton() {
  return (
    <div className="p-6 space-y-4">
      <SkeletonBox className="h-8 w-64" />
      <SkeletonBox className="h-4 w-96" />
      <SkeletonBox className="h-32 mt-6" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 mt-3">
        {Array.from({ length: 3 }).map((_, i) => <SkeletonBox key={i} className="h-24" />)}
      </div>
      <SkeletonBox className="h-72 mt-3" />
    </div>
  );
}

function OverviewPage() {
  const { user } = useDashboardSession();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [dateRange, setDateRange] = useState({ from: daysAgoStr(7), to: todayStr() });
  const [rangeData, setRangeData] = useState<any>(null);
  const [rangeSyncing, setRangeSyncing] = useState(false);
  const [manualData, setManualData] = useState<any>(null);

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

  // Auto-load the default 7D range on first mount (cached data is "this month").
  useEffect(() => {
    let alive = true;
    setRangeSyncing(true);
    authedFetch(`/api/sync?from=${daysAgoStr(7)}&to=${todayStr()}`, { method: "POST" })
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

  // Normalize live data into the shapes OverviewView expects
  const asArr = (v: any) => (Array.isArray(v) ? v : []);
  const shopifyMarketsArr = asArr(data?.shopifyMarkets);
  const liveMarkets = shopifyMarketsArr.some((m: any) => m?.live) ? shopifyMarketsArr : null;
  const twData = asArr(data?.tripleWhale).filter((m: any) => m?.live);
  const juoArr = asArr(data?.juo).filter((m: any) => (m?.calcVersion ?? 0) >= 2);
  const loopArr = asArr(data?.loop).filter((m: any) => (m?.calcVersion ?? 0) >= 3);
  const allSubData = [...juoArr, ...loopArr].filter((m: any) => m?.live);
  const shopifyMonthly = asArr(data?.shopifyMonthly);
  const jorttObj =
    data?.jortt && typeof data.jortt === "object" && !data.jortt.__empty && !data.jortt.__error
      ? data.jortt
      : null;
  // Xero is the OpEx source — the OpEx / day and EBITDA tiles in OverviewView
  // both read from it. Previously this route skipped passing Xero, so the
  // tiles always showed "Xero data not loaded into this view" even when the
  // sync was healthy. The raw payload + extracted error message let the tile
  // distinguish auth failure, __empty sentinel, and "actually no data".
  const xeroObj =
    data?.xero && typeof data.xero === "object" && !data.xero.__empty && !data.xero.__error
      ? data.xero
      : null;
  const xeroErrorMessage =
    data?.xero && typeof data.xero === "object" && (data.xero as any).__error
      ? String((data.xero as any).message ?? "Xero sync failed")
      : null;

  return (
    <DashboardShell user={user ?? { email: "", name: "Loading…", avatar: null }} title="Overview">
      {loading ? (
        <OverviewSkeleton />
      ) : (
        <div
          className="p-6 bg-neutral-50 min-h-full"
          style={{ fontFamily: '"Geist", ui-sans-serif, system-ui, sans-serif' }}
        >
          {data?.errors && Object.keys(data.errors).length > 0 && (
            <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-[12px] text-amber-900">
              <div className="font-semibold mb-1">Some sources didn't sync cleanly</div>
              <ul className="space-y-0.5 list-disc pl-5">
                {Object.entries(data.errors).map(([k, v]) => (
                  <li key={k}>
                    <span className="font-mono">{k}</span>: {String(v)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <OverviewView
            dateRange={dateRange}
            onDateChange={handleDateChange}
            liveMarkets={liveMarkets}
            twData={twData}
            subData={allSubData}
            shopifyMonthly={shopifyMonthly}
            jorttData={jorttObj}
            xeroData={xeroObj}
            xeroError={xeroErrorMessage}
            xeroRaw={data?.xero ?? null}
            rangeData={rangeData}
            rangeSyncing={rangeSyncing}
            shopifyDaily={data?.shopifyDaily ?? null}
            tripleWhaleCustomerEconomics={data?.tripleWhaleCustomerEconomics ?? null}
            tripleWhaleDaily={data?.tripleWhaleDaily ?? null}
            shopifyRepeatFunnel={(() => {
              const sub = data?.subscriptionRepeatFunnel;
              if (sub && !sub.__empty && !sub.__error && (sub.cohortSize ?? 0) > 0) return sub;
              return data?.shopifyRepeatFunnel?.calcVersion >= 6 ? data.shopifyRepeatFunnel : null;
            })()}
            sourceStatus={data?.sourceStatus ?? null}
            manualData={manualData}
          />
          <div className="mt-10 text-center text-[11px] text-neutral-400">
            {data?.syncedAt ? `Synced · ${new Date(data.syncedAt).toLocaleString()}` : "No live sources connected"}
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
