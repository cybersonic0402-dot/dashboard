import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { getDashboardData, triggerXeroSyncNow } from "@/server/dashboard.functions";
import { MonthlyView } from "@/components/FinanceDashboard.tsx";

export const Route = createFileRoute("/pillars/monthly-overview")({
  head: () => ({ meta: [{ title: "Monthly Overview — Zapply" }] }),
  component: MonthlyOverviewPage,
});

function SkeletonBox({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-neutral-200/70 ${className}`} />;
}

function PillarSkeleton() {
  return (
    <div className="p-6 space-y-4">
      <SkeletonBox className="h-8 w-64" />
      <SkeletonBox className="h-4 w-96" />
      <SkeletonBox className="h-32 mt-6" />
      <SkeletonBox className="h-72 mt-3" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 mt-3">
        {Array.from({ length: 4 }).map((_, i) => <SkeletonBox key={i} className="h-20" />)}
      </div>
    </div>
  );
}

function MonthlyOverviewPage() {
  const { user } = useDashboardSession();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);

  async function handleRetryXero() {
    setRetrying(true);
    setRetryMsg(null);
    try {
      const res = await triggerXeroSyncNow();
      if (res?.ok) {
        const fresh = await getDashboardData();
        setData(fresh);
        setRetryMsg(null);
      } else {
        setRetryMsg(res?.error ?? "Xero sync failed");
      }
    } catch (err: any) {
      setRetryMsg(err?.message ?? "Xero sync failed");
    } finally {
      setRetrying(false);
    }
  }

  useEffect(() => {
    let alive = true;
    getDashboardData()
      .then((d) => alive && setData(d))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  if (loading) {
    return (
      <DashboardShell user={user} title="Monthly Overview">
        <PillarSkeleton />
      </DashboardShell>
    );
  }

  const jorttObj = data?.jortt && typeof data.jortt === "object" && !data.jortt.__empty && !data.jortt.__error ? data.jortt : null;
  const xeroObj = data?.xero && typeof data.xero === "object" && !data.xero.__empty && !data.xero.__error ? data.xero : null;
  // Detect Xero failure state so we can warn the user instead of silently falling back to Jortt.
  const xeroRaw = data?.xero;
  const xeroError: string | null =
    xeroRaw && typeof xeroRaw === "object" && xeroRaw.__error
      ? String(xeroRaw.message ?? "Xero sync failed").slice(0, 500)
      : null;
  // OpEx is sourced exclusively from Xero P&L. Jortt is no longer used for OpEx.
  const xeroOpexByMonth = Array.isArray(xeroObj?.opexByMonth) && xeroObj.opexByMonth.length > 0 ? xeroObj.opexByMonth : null;
  const xeroOpexDetail = xeroObj?.opexDetail ?? null;
  const opexByMonth = xeroOpexByMonth;
  const opexDetail = xeroOpexDetail;
  const opexSource: "xero" | "none" = xeroOpexByMonth ? "xero" : "none";
  const jorttLive = !!(jorttObj?.live) || !!(xeroObj?.live);
  const deniedScopes = Array.isArray(jorttObj?.deniedScopes) ? jorttObj.deniedScopes : [];
  const shopifyMonthly = Array.isArray(data?.shopifyMonthly) ? data.shopifyMonthly : [];
  const twData = (Array.isArray(data?.tripleWhale) ? data.tripleWhale : []).filter((m: any) => m?.live);
  const subFunnel = data?.subscriptionRepeatFunnel;
  const subFunnelValid =
    subFunnel && !subFunnel.__empty && !subFunnel.__error && (subFunnel.cohortSize ?? 0) > 0;
  const shopifyRepeatFunnel = subFunnelValid
    ? subFunnel
    : data?.shopifyRepeatFunnel && !data.shopifyRepeatFunnel.__empty && !data.shopifyRepeatFunnel.__error
      ? data.shopifyRepeatFunnel
      : null;
  const shopifyLive = shopifyMonthly.length > 0;

  return (
    <DashboardShell user={user} title="Monthly Overview">
      <div className="p-6 space-y-4">
        {xeroError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-[13px] text-red-800">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-semibold mb-1">Xero sync failed</div>
                <div className="text-red-700/90 break-words">{xeroError}</div>
                <div className="mt-2 text-red-700/80">
                  OpEx cannot be displayed until Xero sync succeeds.
                </div>
                {retryMsg && <div className="mt-2 text-red-700">Retry failed: {retryMsg}</div>}
              </div>
              <button
                type="button"
                onClick={handleRetryXero}
                disabled={retrying}
                className="shrink-0 rounded-md border border-red-300 bg-white px-3 py-1.5 text-[12px] font-medium text-red-800 hover:bg-red-100 disabled:opacity-60"
              >
                {retrying ? "Retrying…" : "Retry Xero sync"}
              </button>
            </div>
          </div>
        )}
        {(shopifyLive || jorttLive) ? (
          <MonthlyView
            opexByMonth={opexByMonth}
            opexDetail={opexDetail}
            opexDetailByMonth={(xeroObj as any)?.opexDetailByMonth ?? null}
            jorttLive={jorttLive}
            xeroDiag={{
              error: xeroError,
              profitAndLoss: (xeroObj as any)?._diagnostics?.profitAndLoss ?? null,
              bankSummary: (xeroObj as any)?._diagnostics?.bankSummary ?? null,
            }}
            deniedScopes={deniedScopes}
            shopifyMonthly={shopifyMonthly}
            twData={twData}
            jortt={jorttObj}
            shopifyRepeatFunnel={shopifyRepeatFunnel}
            shippingByMonth={data?.tripleWhaleShippingMonthly ?? null}
            paymentFeesByMonth={data?.paymentFeesMonthly?.byMonth ?? null}
            interestTaxByMonth={(xeroObj as any)?.interestTaxByMonth ?? null}
          />
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center text-[13px] text-amber-800">
            <strong>Monthly Overview</strong> requires Shopify or Jortt data.
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
