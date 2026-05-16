import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RefreshCw, Plug, AlertCircle, ChevronRight, LayoutGrid } from "lucide-react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { getSyncStatus, getDashboardData, triggerSyncNow, triggerXeroSyncNow, triggerPicqerSyncNow, getLoopStoreStatus, getLoopApiPendingCount, triggerLoopFullSync, runLoopSyncChunk } from "@/server/dashboard.functions";

export const Route = createFileRoute("/operations/sync-status")({
  head: () => ({ meta: [{ title: "Sync status — Zapply" }] }),
  component: SyncStatusPage,
});

type SourceRow = {
  provider: string;
  key: string;
  label: string;
  expected: string;
  connected: boolean;
  status: "healthy" | "degraded" | "error" | "disconnected";
  lastSyncedAt: number | null;
  ageMinutes: number | null;
  rowCount: number | null;
  error: string | null;
};

function fmtAge(min: number | null) {
  if (min == null) return "—";
  if (min < 1) return "just now";
  if (min < 60) return `${Math.round(min)} min ago`;
  const h = min / 60;
  if (h < 24) return `${h < 1.5 ? 1 : Math.round(h)} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

const STATUS_LABEL: Record<SourceRow["status"], string> = {
  healthy: "Healthy",
  degraded: "Stale",
  error: "Error",
  disconnected: "Disconnected",
};
const STATUS_DOT: Record<SourceRow["status"], string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  error: "bg-rose-500",
  disconnected: "bg-neutral-400",
};
const STATUS_TXT: Record<SourceRow["status"], string> = {
  healthy: "text-emerald-600",
  degraded: "text-amber-600",
  error: "text-rose-600",
  disconnected: "text-neutral-500",
};

type Connector = {
  id: string;
  name: string;
  api: string;
  iconBg: string;
  iconColor: string;
  // Which sync status entries belong to this connector (provider names)
  providerKeys: string[];
  // How to derive the "X items" suffix
  unit: (data: any, sources: SourceRow[]) => string;
  // Optional bridge / warning chip
  badge?: string;
};

const CONNECTORS: Connector[] = [
  {
    id: "shopify",
    name: "Shopify Plus",
    api: "GraphQL Admin",
    iconBg: "bg-emerald-50",
    iconColor: "text-emerald-600",
    providerKeys: ["shopify"],
    unit: (data) => {
      const today = Number(data?.shopifyToday?.orders ?? 0);
      if (today > 0) return `${today.toLocaleString("en-GB")} orders`;
      const monthly: any[] = Array.isArray(data?.shopifyMonthly) ? data.shopifyMonthly : [];
      const last = monthly[monthly.length - 1];
      const ord = Number(last?.orders ?? 0);
      return ord > 0 ? `${ord.toLocaleString("en-GB")} orders` : "—";
    },
  },
  {
    id: "triplewhale",
    name: "Triple Whale",
    api: "REST v2",
    iconBg: "bg-violet-50",
    iconColor: "text-violet-600",
    providerKeys: ["triplewhale"],
    unit: (data) => {
      const tw = data?.tripleWhale;
      const markets = Array.isArray(tw?.markets) ? tw.markets.length : 0;
      const metrics = markets > 0 ? markets * 5 : 0;
      return metrics > 0 ? `${metrics} metrics` : "—";
    },
  },
  {
    id: "loop",
    name: "Loop",
    api: "REST",
    iconBg: "bg-violet-50",
    iconColor: "text-violet-600",
    providerKeys: ["loop"],
    unit: (data) => {
      const loop = Number(data?.loop?.activeSubscribers ?? data?.loop?.subscribers ?? 0);
      return loop > 0 ? `${loop.toLocaleString("en-GB")} subscribers` : "—";
    },
  },
  {
    id: "juo",
    name: "Juo",
    api: "REST",
    iconBg: "bg-fuchsia-50",
    iconColor: "text-fuchsia-600",
    providerKeys: ["juo"],
    unit: (data) => {
      const juo = Number(data?.juo?.activeSubscribers ?? data?.juo?.subscribers ?? 0);
      return juo > 0 ? `${juo.toLocaleString("en-GB")} subscribers` : "—";
    },
  },
  {
    id: "paypal",
    name: "PayPal",
    api: "REST · Reporting",
    iconBg: "bg-sky-50",
    iconColor: "text-sky-700",
    providerKeys: ["paypal"],
    unit: (data) => {
      const accts = Array.isArray(data?.paypalBalances?.accounts)
        ? data.paypalBalances.accounts.length
        : 0;
      return accts > 0 ? `${accts} ${accts === 1 ? "balance" : "balances"}` : "—";
    },
  },
  {
    id: "mollie",
    name: "Mollie",
    api: "REST v2",
    iconBg: "bg-indigo-50",
    iconColor: "text-indigo-600",
    providerKeys: ["mollie"],
    unit: (data) => {
      const accts = Array.isArray(data?.mollieBalances?.accounts)
        ? data.mollieBalances.accounts.length
        : 0;
      return accts > 0 ? `${accts} ${accts === 1 ? "balance" : "balances"}` : "—";
    },
  },
  {
    id: "fulfillment",
    name: "Fulfillment partner",
    api: "Picqer REST v1",
    iconBg: "bg-amber-50",
    iconColor: "text-amber-600",
    providerKeys: ["picqer"],
    unit: (data) => {
      const p = data?.picqer;
      if (!p || typeof p !== "object" || (p as any).__error || (p as any).__empty) return "—";
      const products = Number((p as any).totalProducts ?? 0);
      const rows = Number((p as any).totalRows ?? 0);
      if (products === 0 && rows === 0) return "—";
      return `${products.toLocaleString("en-GB")} SKU${products === 1 ? "" : "s"} · ${rows.toLocaleString("en-GB")} stock row${rows === 1 ? "" : "s"}`;
    },
    badge: "TRL Fulfilment · Picqer",
  },
  {
    id: "jortt",
    name: "Jortt",
    api: "REST",
    iconBg: "bg-teal-50",
    iconColor: "text-teal-600",
    providerKeys: ["jortt"],
    unit: (data) => {
      const inv = Number(data?.jortt?.invoiceCount ?? 0);
      const exp = Number(data?.jortt?.expenseCount ?? 0);
      const tx = Number(data?.jortt?.bankTransactionsCount ?? 0);
      const total = inv + exp + tx;
      return total > 0 ? `${total.toLocaleString("en-GB")} transactions` : "—";
    },
    badge: "Bridge connector · Xero replacing within ~1 month",
  },
  {
    id: "xero",
    name: "Xero",
    api: "REST v2",
    iconBg: "bg-sky-50",
    iconColor: "text-sky-600",
    providerKeys: ["xero"],
    unit: (data) => {
      const inv = Number(data?.xero?.invoiceCount ?? 0);
      const exp = Number(data?.xero?.expenseCount ?? 0);
      const tx = Number(data?.xero?.bankTransactionsCount ?? 0);
      const total = inv + exp + tx;
      return total > 0 ? `${total.toLocaleString("en-GB")} transactions` : "—";
    },
    badge: "Incoming · Will replace Jortt within ~1 month",
  },
];

function aggregateStatus(rows: SourceRow[]): SourceRow["status"] {
  if (rows.length === 0) return "disconnected";
  if (rows.some((r) => r.status === "error")) return "error";
  if (rows.some((r) => r.status === "disconnected")) return "disconnected";
  if (rows.some((r) => r.status === "degraded")) return "degraded";
  return "healthy";
}

function freshestAge(rows: SourceRow[]): number | null {
  const ages = rows.map((r) => r.ageMinutes).filter((a): a is number => a != null);
  return ages.length === 0 ? null : Math.min(...ages);
}

function SyncStatusPage() {
  const { user } = useDashboardSession();
  const [status, setStatus] = useState<{ sources: SourceRow[]; checkedAt: number } | null>(null);
  const [data, setData] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loopDb, setLoopDb] = useState<any>(null);
  const [loopPending, setLoopPending] = useState<{ results: any[]; checkedAt: number } | null>(null);
  const [loopChecking, setLoopChecking] = useState(false);
  const [loopSyncing, setLoopSyncing] = useState(false);
  const [loopAdminError, setLoopAdminError] = useState<string | null>(null);
  const [loopProgress, setLoopProgress] = useState<Record<string, { page: number; total: number; done: boolean; status: string; error?: string } | null>>({ UK: null, US: null });

  const load = async () => {
    setRefreshing(true);
    try {
      const [s, d, ld] = await Promise.all([
        getSyncStatus(),
        getDashboardData(),
        getLoopStoreStatus().catch((err: any) => {
          setLoopAdminError(err?.message ?? "Admin access required");
          return null;
        }),
      ]);
      setStatus(s as any);
      setData(d);
      if (ld) {
        setLoopAdminError(null);
        setLoopDb(ld as any);
      }
    } finally {
      setRefreshing(false);
    }
  };

  const syncNow = async () => {
    setRefreshing(true);
    try {
      await triggerSyncNow();
      const [s, d, ld] = await Promise.all([getSyncStatus(), getDashboardData(), getLoopStoreStatus().catch(() => null)]);
      setStatus(s as any);
      setData(d);
      if (ld) setLoopDb(ld as any);
    } catch (err: any) {
      setLoopAdminError(err?.message ?? "Admin access required");
    } finally {
      setRefreshing(false);
    }
  };

  const checkLoopApi = async () => {
    setLoopChecking(true);
    try {
      const r = await getLoopApiPendingCount();
      setLoopPending(r as any);
      setLoopAdminError(null);
    } catch (err: any) {
      setLoopAdminError(err?.message ?? "Admin access required");
    } finally {
      setLoopChecking(false);
    }
  };

  // Full sync now delegates to the standalone Loop → Supabase microservice
  // (LOOP_SYNC_SERVICE_URL, deployed on Railway). The first chunk call kicks
  // off the remote sync and returns allDone=true immediately, so this loop
  // exits after one iteration per market. Progress is observed by polling
  // getLoopStoreStatus, which reads live row counts from Supabase as the
  // microservice writes them — UK takes ~10–15 minutes to finish.
  const fullSyncLoop = async () => {
    setLoopSyncing(true);
    setLoopProgress({ UK: null, US: null });
    try {
      const markets: Array<"UK" | "US"> = ["UK", "US"];
      const doneMap: Record<string, boolean> = { UK: false, US: false };
      // First call: reset both
      let firstPass = true;
      // Drive both markets in parallel with bounded iterations.
      for (let i = 0; i < 200; i++) {
        if (doneMap.UK && doneMap.US) break;
        const calls = markets.map(async (m) => {
          if (doneMap[m]) return null;
          const res: any = await runLoopSyncChunk({ data: { market: m, reset: firstPass } });
          doneMap[m] = !!res.allDone;
          // pick the currently-active status to show
          const entries = Object.entries(res.perStatus ?? {}) as Array<[string, any]>;
          const active = entries.find(([, v]) => !v.done) ?? entries[entries.length - 1];
          setLoopProgress((p) => ({
            ...p,
            [m]: active
              ? { status: active[0], page: active[1].page, total: active[1].total, done: !!res.allDone, error: res.lastError }
              : { status: "—", page: 0, total: 0, done: !!res.allDone, error: res.lastError },
          }));
          // Refresh DB counts after each chunk
          try {
            const ld = await getLoopStoreStatus();
            setLoopDb(ld as any);
          } catch {}
          if (res.lastError) doneMap[m] = true; // stop looping on error
          return res;
        });
        await Promise.all(calls);
        firstPass = false;
      }
      setLoopPending(null);
      const ld = await getLoopStoreStatus().catch(() => null);
      if (ld) setLoopDb(ld as any);
      setLoopAdminError(null);
    } catch (err: any) {
      setLoopAdminError(err?.message ?? "Admin access required");
    } finally {
      setLoopSyncing(false);
    }
  };


  const syncConnector = async (id: string) => {
    setRefreshing(true);
    try {
      if (id === "xero") await triggerXeroSyncNow();
      else if (id === "fulfillment") await triggerPicqerSyncNow();
      else await triggerSyncNow();
      const [s, d] = await Promise.all([getSyncStatus(), getDashboardData()]);
      setStatus(s as any);
      setData(d);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <DashboardShell user={user} title="Sync status">
      <div className="px-6 py-6 space-y-4 max-w-[1240px] mx-auto w-full">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[12px] text-neutral-500">Connections</div>
            <h1 className="text-[22px] font-semibold tracking-tight mt-0.5">Sync status</h1>
            <p className="text-[13px] text-neutral-500 mt-1">Health of each data source and last successful pull.</p>
          </div>
          <button
            onClick={syncNow}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-[13px] font-medium hover:bg-neutral-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Sync all now
          </button>
        </div>

        {/* Connector cards */}
        <div className="space-y-3">
          {CONNECTORS.map((c) => {
            const matching = (status?.sources ?? []).filter((s) => c.providerKeys.includes(s.provider));
            const st = aggregateStatus(matching);
            const age = freshestAge(matching);
            const items = data ? c.unit(data, matching) : "—";
            const apiLabel = c.api;
            const isPending = !status;

            return (
              <div key={c.id} className="rounded-xl border border-neutral-200 bg-white">
                <div className="flex items-start justify-between gap-3 p-4 flex-wrap">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`grid h-10 w-10 place-items-center rounded-lg ${c.iconBg}`}>
                      <Plug className={`h-4 w-4 ${c.iconColor}`} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[14px] font-semibold text-neutral-900">{c.name}</span>
                        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
                          <span className={`h-1.5 w-1.5 rounded-full ${isPending ? "bg-neutral-300 animate-pulse" : STATUS_DOT[st]}`} />
                          <span className={isPending ? "text-neutral-400" : STATUS_TXT[st]}>
                            {isPending ? "Checking…" : STATUS_LABEL[st]}
                          </span>
                        </span>
                      </div>
                      <div className="text-[12px] text-neutral-500 mt-0.5">
                        {apiLabel} · Last sync {fmtAge(age)} · {items}
                      </div>
                      {c.badge && (
                        <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-50 ring-1 ring-amber-200 px-2 py-1 text-[11px] text-amber-700">
                          <AlertCircle className="h-3 w-3" />
                          {c.badge}
                        </div>
                      )}
                      {matching.some((m) => m.error) && (
                        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-rose-50 ring-1 ring-rose-200 px-2 py-1 text-[11px] text-rose-700 max-w-[680px]">
                          <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                          <span className="break-words whitespace-pre-wrap">
                            {matching.find((m) => m.error)?.error}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="inline-flex items-center rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-[12px] font-medium hover:bg-neutral-50">
                      Logs
                    </button>
                    {c.id === "xero" && (
                      <a
                        href="/api/auth/xero"
                        className="inline-flex items-center rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-[12px] font-medium text-sky-700 hover:bg-sky-100"
                      >
                        Connect Xero
                      </a>
                    )}
                    <button
                      onClick={() => syncConnector(c.id)}
                      disabled={refreshing}
                      className="inline-flex items-center rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-[12px] font-medium hover:bg-neutral-50 disabled:opacity-50"
                    >
                      Resync
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Loop DB sync panel */}
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[14px] font-semibold">Loop subscriptions · Database</div>
              <div className="text-[12px] text-neutral-500 mt-0.5">
                Dashboard reads from Supabase tables <code>UK_loop</code> / <code>US_loop</code>. Click{" "}
                <span className="font-medium">Full sync</span> to refresh from the Loop API.
              </div>
              {loopAdminError && (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-50 ring-1 ring-amber-200 px-2 py-1 text-[11px] text-amber-700">
                  <AlertCircle className="h-3 w-3" /> Admin access required for Loop sync status and controls.
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={checkLoopApi}
                disabled={loopChecking || loopSyncing}
                className="inline-flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-[12px] font-medium hover:bg-neutral-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loopChecking ? "animate-spin" : ""}`} />
                {loopChecking ? "Checking API…" : "Check API for new"}
              </button>
              <button
                onClick={fullSyncLoop}
                disabled={loopSyncing}
                className="inline-flex items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-[12px] font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loopSyncing ? "animate-spin" : ""}`} />
                {loopSyncing ? "Syncing…" : "Full sync"}
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            {(loopDb?.stores ?? [{ market: "UK" }, { market: "US" }]).map((s: any) => {
              const pending = loopPending?.results?.find((r: any) => r.market === s.market);
              return (
                <div key={s.market} className="rounded-lg ring-1 ring-neutral-100 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-[13px] font-semibold text-neutral-900">{s.market} store</div>
                    <span className="text-[11px] text-neutral-500 font-mono">{s.table ?? `${s.market}_loop`}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
                    <div>
                      <div className="text-neutral-500">In database</div>
                      <div className="text-[18px] font-semibold text-neutral-900">
                        {(s.dbCount ?? 0).toLocaleString("en-GB")}
                      </div>
                    </div>
                    <div>
                      <div className="text-neutral-500">New on API</div>
                      <div className="text-[18px] font-semibold text-neutral-900">
                        {pending?.error ? (
                          <span className="text-rose-600 text-[13px]">{pending.error}</span>
                        ) : pending ? (
                          pending.pending > 0 ? (
                            <span className="text-amber-600">+{pending.pending.toLocaleString("en-GB")}</span>
                          ) : (
                            <span className="text-emerald-600">Up to date</span>
                          )
                        ) : (
                          <span className="text-neutral-400 text-[13px]">—</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {s.byStatus && (
                    <div className="mt-2 flex gap-2 flex-wrap text-[11px] text-neutral-500">
                      {Object.entries(s.byStatus).map(([k, v]) => (
                        <span key={k} className="rounded bg-neutral-100 px-1.5 py-0.5">
                          {k}: {(v as number).toLocaleString("en-GB")}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 text-[11px] text-neutral-500">
                    Last synced: {s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : "—"}
                  </div>
                  {loopProgress[s.market] && (
                    <div className="mt-2 text-[11px] flex items-center gap-2">
                      {loopProgress[s.market]!.error ? (
                        <span className="text-rose-600">Error: {loopProgress[s.market]!.error}</span>
                      ) : loopProgress[s.market]!.done ? (
                        <span className="text-emerald-600">✓ Sync complete</span>
                      ) : (
                        <span className="text-violet-600 inline-flex items-center gap-1.5">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          Syncing {loopProgress[s.market]!.status} · page {loopProgress[s.market]!.page} · {loopProgress[s.market]!.total.toLocaleString("en-GB")} fetched
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {loopPending && (
            <div className="mt-3 text-[11px] text-neutral-400">
              API checked at {new Date(loopPending.checkedAt).toLocaleTimeString()} · click Full sync to merge new rows into the database.
            </div>
          )}
          {(loopDb?.runs?.length > 0 || loopDb?.errors?.length > 0) && (
            <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-lg ring-1 ring-neutral-100 p-4">
                <div className="text-[13px] font-semibold text-neutral-900">Sync history</div>
                <div className="mt-3 space-y-2">
                  {(loopDb?.runs ?? []).slice(0, 8).map((run: any) => (
                    <div key={run.id} className="flex items-start justify-between gap-3 text-[11px] border-b border-neutral-100 pb-2 last:border-0">
                      <div>
                        <div className="font-medium text-neutral-800">{run.market} · {run.outcome}</div>
                        <div className="text-neutral-500">{new Date(run.started_at).toLocaleString()}</div>
                      </div>
                      <div className="text-right text-neutral-500">
                        <div>{Number(run.total_fetched ?? 0).toLocaleString("en-GB")} fetched</div>
                        <div>{run.duration_ms ? `${Math.round(run.duration_ms / 1000)}s` : "—"}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg ring-1 ring-neutral-100 p-4">
                <div className="text-[13px] font-semibold text-neutral-900">Sync error log</div>
                <div className="mt-3 space-y-2">
                  {(loopDb?.errors ?? []).map((err: any) => (
                    <div key={`${err.market}-${err.status}`} className="text-[11px] rounded-md bg-rose-50 ring-1 ring-rose-100 px-2 py-2 text-rose-700">
                      <div className="font-medium">{err.market} · {err.status} · {err.retry_count ?? 0} retries</div>
                      <div className="mt-0.5 break-words">{err.last_error ?? "—"}</div>
                      <div className="mt-1 text-rose-500">{err.last_seen_at ? new Date(err.last_seen_at).toLocaleString() : "—"}</div>
                    </div>
                  ))}
                  {(loopDb?.errors ?? []).length === 0 && <div className="text-[11px] text-neutral-400">No recorded Loop sync errors.</div>}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Data flow */}
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="text-[14px] font-semibold">Data flow</div>
          <div className="text-[12px] text-neutral-500 mt-0.5">How data moves from each source to the dashboard.</div>

          <div className="mt-6 grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-6 items-center">
            {/* Sources column */}
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-neutral-400 font-medium mb-2">Data sources</div>
              {[
                { name: "Shopify Plus",  providerKeys: ["shopify"],     bg: "bg-emerald-50",  fg: "text-emerald-600" },
                { name: "Triple Whale",  providerKeys: ["triplewhale"], bg: "bg-violet-50",   fg: "text-violet-600" },
                { name: "Loop",          providerKeys: ["loop"],        bg: "bg-violet-50",   fg: "text-violet-600" },
                { name: "Juo",           providerKeys: ["juo"],         bg: "bg-fuchsia-50",  fg: "text-fuchsia-600" },
                { name: "PayPal",        providerKeys: ["paypal"],      bg: "bg-sky-50",      fg: "text-sky-700" },
                { name: "Mollie",        providerKeys: ["mollie"],      bg: "bg-indigo-50",   fg: "text-indigo-600" },
                { name: "Jortt",         providerKeys: ["jortt"],       bg: "bg-teal-50",     fg: "text-teal-600", suffix: "→ Xero" },
                { name: "Xero",          providerKeys: ["xero"],        bg: "bg-sky-50",      fg: "text-sky-600",  suffix: "incoming" },
              ].map((node) => {
                const matching = (status?.sources ?? []).filter((s) => node.providerKeys.includes(s.provider));
                const st = aggregateStatus(matching);
                const isPending = !status;
                return (
                  <div key={node.name} className="flex items-center justify-between gap-3 rounded-lg ring-1 ring-neutral-100 px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`grid h-7 w-7 place-items-center rounded-md ${node.bg}`}>
                        <Plug className={`h-3.5 w-3.5 ${node.fg}`} />
                      </span>
                      <span className="text-[13px] font-medium text-neutral-900 truncate">{node.name}</span>
                      {node.suffix && (
                        <span className="text-[11px] text-neutral-400">{node.suffix}</span>
                      )}
                    </div>
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium">
                      <span className={`h-1.5 w-1.5 rounded-full ${isPending ? "bg-neutral-300 animate-pulse" : STATUS_DOT[st]}`} />
                      <span className={isPending ? "text-neutral-400" : STATUS_TXT[st]}>
                        {isPending ? "…" : STATUS_LABEL[st]}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Arrow */}
            <div className="hidden md:flex items-center justify-center">
              <ChevronRight className="h-6 w-6 text-neutral-300" />
            </div>

            {/* Dashboard target */}
            <div className="flex flex-col items-center text-center">
              <div className="grid h-16 w-16 place-items-center rounded-xl bg-neutral-900">
                <LayoutGrid className="h-6 w-6 text-white" />
              </div>
              <div className="mt-2 text-[14px] font-semibold text-neutral-900">Dashboard</div>
              <div className="text-[12px] text-neutral-500">Reconciled view</div>
            </div>
          </div>
        </div>

        <div className="text-center text-[11px] text-neutral-400 pt-2">
          Synced · {status ? new Date(status.checkedAt).toLocaleString() : "—"} · Live status from connector cache
        </div>
      </div>
    </DashboardShell>
  );
}
