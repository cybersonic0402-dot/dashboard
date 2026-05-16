import { authedFetch } from "@/lib/authed-fetch";
import { useState, useEffect, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw, Plug, CircleAlert, ChevronRight, LayoutDashboard, ExternalLink, Bug, CheckCircle2, AlertTriangle, XCircle, MinusCircle } from "lucide-react";
import { getSyncDebug } from "@/server/debug.functions";

const SHOPIFY_STORES = [
  { id: "shopify_zapply-nl",      name: "Shopify NL", flag: "🇳🇱", shop: "zapply-nl.myshopify.com",      desc: "Netherlands · orders, revenue" },
  { id: "shopify_zapplyde",       name: "Shopify UK", flag: "🇬🇧", shop: "zapplyde.myshopify.com",       desc: "United Kingdom · orders, revenue" },
  { id: "shopify_zapply-usa",     name: "Shopify US", flag: "🇺🇸", shop: "zapply-usa.myshopify.com",     desc: "United States · orders, revenue" },
  
];

const API_KEY_SOURCES = [
  {
    id: "loop",
    name: "Loop Subscriptions",
    desc: "MRR, active subs, churn, repeat rates",
    api: "REST · LOOP_UK_API_KEY",
    color: "#7C3AED",
    docsUrl: "https://developers.loopreturns.com",
  },
  {
    id: "triplewhale",
    name: "Triple Whale",
    desc: "Ad spend, ROAS, NCPA, 90D/365D LTV",
    api: "REST v2 · TRIPLE_WHALE_API_KEY",
    color: "#6366f1",
    docsUrl: "https://developers.triplewhale.com",
  },
  {
    id: "jortt",
    name: "Jortt",
    desc: "Revenue reconciliation · invoice data",
    api: "client_credentials · JORTT_CLIENT_ID/SECRET",
    color: "#00A6A6",
    note: "Bridge connector · Xero replacing within ~1 month",
    docsUrl: "https://developer.jortt.nl",
  },
];

function StatusPill({ status }) {
  if (status === "connected")
    return (
      <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Connected
      </span>
    );
  return (
    <span className="flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500">
      <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />Not connected
    </span>
  );
}

// Compact badge that reflects ACTUAL cache liveness (not just "credentials present").
// status: "live" | "empty" | "error" | "missing"
function LiveStatusBadge({ status, errorMessage }) {
  if (status === "live") {
    return (
      <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12px] font-medium text-emerald-700">
        Live ✓
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        title={errorMessage ?? "Last sync failed"}
        className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-[12px] font-medium text-red-700"
      >
        Error
      </span>
    );
  }
  if (status === "empty") {
    return (
      <span
        title="API responded but returned no data"
        className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] font-medium text-amber-700"
      >
        No data
      </span>
    );
  }
  return (
    <span
      title="Cache not written yet — click Sync all now"
      className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[12px] font-medium text-neutral-500"
    >
      Not synced
    </span>
  );
}

export default function SyncView({ initialConnections = {} }) {
  const [connections, setConnections] = useState(initialConnections);
  const [syncing, setSyncing] = useState(false);

  const [xeroError, setXeroError] = useState(null);
  const [debug, setDebug] = useState(null);
  const [debugLoading, setDebugLoading] = useState(false);

  const fetchDebug = useServerFn(getSyncDebug);

  // Real per-source liveness derived from the debug cache snapshot.
  // Falls back to "missing" when the cache hasn't been written yet so we
  // never mis-label an integration as Live just because env keys exist.
  const PROVIDER_TO_ID = {
    loop: "loop/subscriptions",
    triplewhale: "triplewhale/summary",
    jortt: "jortt/invoices",
    juo: "juo/subscriptions",
    xero: "xero/accounting",
  };
  const liveMap = {};
  for (const p of debug?.providers ?? []) {
    liveMap[p.id] = p; // status: "live" | "empty" | "error" | "missing"
  }
  const shopifyStoreStatus = debug?.shopifyStores ?? {};
  const getSourceStatus = (sourceId) => {
    const cacheId = PROVIDER_TO_ID[sourceId];
    if (!cacheId) return "missing";
    return liveMap[cacheId]?.status ?? "missing";
  };
  const getSourceErrorMessage = (sourceId) => {
    const cacheId = PROVIDER_TO_ID[sourceId];
    if (!cacheId) return null;
    return liveMap[cacheId]?.errorMessage ?? null;
  };

  const refreshDebug = useCallback(async () => {
    setDebugLoading(true);
    try {
      const d = await fetchDebug();
      setDebug(d);
    } catch (err) {
      console.error("debug fetch failed", err);
    } finally {
      setDebugLoading(false);
    }
  }, [fetchDebug]);

  // Pick up ?connected= or ?error= from OAuth redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (connected) {
      setConnections((c) => ({ ...c, [connected]: "connected" }));
      window.history.replaceState({}, "", "/?view=sync");
    }
    if (params.get("error")) {
      window.history.replaceState({}, "", "/?view=sync");
    }
    // Xero-specific params
    if (params.get("xero_connected")) {
      setConnections((c) => ({ ...c, xero: "connected" }));
      window.history.replaceState({}, "", "/?view=sync");
    }
    if (params.get("xero_error")) {
      setXeroError(params.get("xero_error"));
      window.history.replaceState({}, "", "/?view=sync");
    }
    // Initial load
    void refreshDebug();
  }, [refreshDebug]);

  async function syncAll() {
    setSyncing(true);
    try {
      await authedFetch("/api/sync", { method: "POST" }).catch(() => null);
    } finally {
      // Poll the debug endpoint a few times so the panel updates as
      // background jobs finish writing to the cache.
      for (const delay of [1500, 4000, 8000]) {
        setTimeout(() => void refreshDebug(), delay);
      }
      setTimeout(() => setSyncing(false), 1500);
    }
  }

  return (
    <>
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Connections</div>
          <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Sync status</h1>
          <p className="mt-1 text-[13px] text-neutral-500">
            Connect your data sources to replace mock data with live numbers.
          </p>
        </div>
        <button
          onClick={syncAll}
          disabled={syncing}
          className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
        >
          <RefreshCw size={13} className={syncing ? "animate-spin" : ""} />
          Sync all now
        </button>
      </div>

      {/* Shopify stores */}
      <div className="mt-6">
        <div className="mb-2 text-[12px] font-semibold text-neutral-400 uppercase tracking-wide">Shopify stores</div>
        <div className="space-y-3">
          {SHOPIFY_STORES.map((src) => {
            const status = connections[src.id] ?? "disconnected";
            return (
              <div key={src.id} className="rounded-xl border border-neutral-200 bg-white p-5">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ backgroundColor: "#95BF4718" }}>
                      <span className="text-lg">{src.flag}</span>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-semibold">{src.name}</span>
                        <StatusPill status={status} />
                      </div>
                      <div className="mt-0.5 text-[12px] text-neutral-500">{src.desc}</div>
                      <div className="mt-0.5 text-[11px] text-neutral-400 font-mono">{src.shop}</div>
                    </div>
                  </div>
                  <div className="shrink-0">
                    {status === "connected" ? (
                      <LiveStatusBadge status={shopifyStoreStatus[src.id] ?? "missing"} />
                    ) : (
                      <a
                        href={`/api/shopify/install?shop=${src.shop}`}
                        className="rounded-lg border border-[#95BF47] bg-[#95BF47] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#85af37]"
                      >
                        Connect store
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* API-key based sources */}
      <div className="mt-6">
        <div className="mb-2 text-[12px] font-semibold text-neutral-400 uppercase tracking-wide">API key sources</div>
        <div className="space-y-3">
          {API_KEY_SOURCES.map((src) => {
            const status = connections[src.id] ?? "disconnected";
            return (
              <div key={src.id} className="rounded-xl border border-neutral-200 bg-white p-5">
                <div className="flex items-start justify-between gap-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ backgroundColor: `${src.color}18` }}>
                      <Plug size={18} style={{ color: src.color }} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[14px] font-semibold">{src.name}</span>
                        <StatusPill status={status} />
                      </div>
                      <div className="mt-0.5 text-[12px] text-neutral-500">{src.desc}</div>
                      <div className="mt-0.5 text-[11px] text-neutral-400">{src.api}</div>
                      {src.note && (
                        <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700">
                          <CircleAlert size={11} />
                          {src.note}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0">
                    {src.id === "jortt" ? (
                      status === "connected" ? (
                        <div className="flex flex-col items-end gap-1.5">
                          <LiveStatusBadge
                            status={getSourceStatus("jortt")}
                            errorMessage={getSourceErrorMessage("jortt")}
                          />
                          <a
                            href="/api/jortt/connect"
                            className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-600 hover:bg-neutral-50"
                          >
                            Re-check
                          </a>
                        </div>
                      ) : (
                        <a
                          href="/api/jortt/connect"
                          className="rounded-lg border px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
                          style={{ backgroundColor: src.color, borderColor: src.color }}
                        >
                          Connect Jortt
                        </a>
                      )
                    ) : status === "connected" ? (
                      <LiveStatusBadge
                        status={getSourceStatus(src.id)}
                        errorMessage={getSourceErrorMessage(src.id)}
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[12px] font-medium text-neutral-500">
                          Add keys to .env.local
                        </span>
                        <a
                          href={src.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 rounded-lg border border-neutral-200 px-3 py-1.5 text-[12px] font-medium text-neutral-600 hover:bg-neutral-50"
                        >
                          Docs <ExternalLink size={11} />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Xero accounting */}
      <div className="mt-6">
        <div className="mb-2 text-[12px] font-semibold text-neutral-400 uppercase tracking-wide">Accounting</div>
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="flex items-start justify-between gap-6">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ backgroundColor: "#13B5EA18" }}>
                <svg width="20" height="20" viewBox="0 0 32 32" fill="none">
                  <circle cx="16" cy="16" r="16" fill="#13B5EA" />
                  <text x="16" y="21" textAnchor="middle" fill="white" fontSize="13" fontWeight="700" fontFamily="sans-serif">X</text>
                </svg>
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[14px] font-semibold">Xero</span>
                  <StatusPill status={connections["xero"] ?? "disconnected"} />
                </div>
                <div className="mt-0.5 text-[12px] text-neutral-500">P&amp;L, Balance Sheet, Bank accounts, Invoices</div>
                <div className="mt-0.5 text-[11px] text-neutral-400">OAuth 2.0 · accounting.reports.read · accounting.transactions</div>
                {xeroError && (
                  <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700">
                    <CircleAlert size={11} />
                    Auth error: {xeroError}
                  </div>
                )}
              </div>
            </div>
            <div className="shrink-0">
              {connections["xero"] === "connected" ? (
                <div className="flex flex-col items-end gap-1.5">
                  <LiveStatusBadge
                    status={getSourceStatus("xero")}
                    errorMessage={getSourceErrorMessage("xero")}
                  />
                  <a
                    href="/api/auth/xero"
                    className="rounded-md border border-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-600 hover:bg-neutral-50"
                  >
                    Re-authorize
                  </a>
                </div>
              ) : (
                <a
                  href="/api/auth/xero"
                  className="rounded-lg border border-[#13B5EA] bg-[#13B5EA] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#0fa3d6]"
                >
                  Connect Xero
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Data flow diagram */}
      <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-6">
        <div className="mb-4">
          <div className="text-[13px] font-semibold">Data flow</div>
          <div className="text-[12px] text-neutral-400">How data moves from source to dashboard.</div>
        </div>
        <div className="flex items-center justify-between gap-2 overflow-x-auto py-4">
          {[
            { label: "Shopify", color: "#95BF47", desc: "4 stores" },
            { label: "Triple Whale", color: "#6366f1", desc: "Ad metrics" },
            { label: "Loop", color: "#7C3AED", desc: "Subscriptions" },
            { label: "Jortt", color: "#00A6A6", desc: "Accounting" },
            { label: "Xero", color: "#13B5EA", desc: "Accounting" },
          ].map((s, i, arr) => (
            <div key={s.label} className="flex items-center gap-2 flex-1 min-w-0">
              <div className="flex flex-col items-center min-w-[90px]">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl shadow-sm" style={{ backgroundColor: `${s.color}15` }}>
                  <Plug size={18} style={{ color: s.color }} />
                </div>
                <div className="mt-1.5 text-[11px] font-semibold text-center">{s.label}</div>
                <div className="text-[10px] text-neutral-400 text-center">{s.desc}</div>
                {s.sublabel && <div className="text-[10px] text-[#13B5EA] font-medium">{s.sublabel}</div>}
              </div>
              {i < arr.length - 1 && (
                <div className="flex flex-1 items-center">
                  <div className="h-px flex-1 bg-neutral-200" />
                  <ChevronRight size={12} className="text-neutral-300" />
                </div>
              )}
            </div>
          ))}
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center">
              <div className="h-px w-8 bg-neutral-200" />
              <ChevronRight size={12} className="text-neutral-300" />
            </div>
            <div className="flex flex-col items-center min-w-[90px]">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-900 text-white shadow-sm">
                <LayoutDashboard size={18} />
              </div>
              <div className="mt-1.5 text-[11px] font-semibold">Dashboard</div>
              <div className="text-[10px] text-neutral-400">Reconciled</div>
            </div>
          </div>
        </div>
      </div>

      {/* Sync debug panel */}
      <SyncDebugPanel debug={debug} loading={debugLoading} onRefresh={refreshDebug} />

      {/* Setup notes */}
      <div className="mt-4 space-y-3">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-[12px] text-blue-700">
          <div className="font-semibold mb-1">Shopify OAuth setup</div>
          In your <strong>Shopify Partner Dashboard</strong>, register the redirect URI:
          <code className="ml-1 rounded bg-blue-100 px-1 py-0.5 font-mono text-[11px]">http://localhost:3001/api/shopify/callback</code>.
          Then click <strong>Connect store</strong> above for each store.
        </div>
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-[12px] text-blue-700">
          <div className="font-semibold mb-1">First-time database setup</div>
          Run <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-[11px]">supabase/migrations/001_integrations.sql</code> in your Supabase SQL editor to create the integrations table.
        </div>
        <div className="rounded-xl border border-[#13B5EA30] bg-[#13B5EA08] p-4 text-[12px] text-[#0e8fb5]">
          <div className="font-semibold mb-1">Xero OAuth setup</div>
          In your <strong>Xero Developer portal</strong>, add this redirect URI:
          <code className="ml-1 rounded bg-[#13B5EA15] px-1 py-0.5 font-mono text-[11px]">http://localhost:3001/api/auth/xero/callback</code>
          <br />Then click <strong>Connect Xero</strong> above. You will be redirected to Xero to authorize, and tokens will be saved automatically.
        </div>
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------
// Sync Debug Panel
// ----------------------------------------------------------------------------

const PROVIDER_LABELS = {
  "shopify/markets":     "Shopify · Markets",
  "shopify/monthly":     "Shopify · Monthly",
  "shopify/today":       "Shopify · Today",
  "triplewhale/summary": "Triple Whale · Summary",
  "loop/subscriptions":  "Loop · Subscriptions",
  "juo/subscriptions":   "Juo · Subscriptions",
  "jortt/invoices":      "Jortt · Invoices",
  "xero/accounting":     "Xero · Accounting",
};

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatRelative(iso) {
  if (!iso) return "never";
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function StatusIcon({ status }) {
  if (status === "live")    return <CheckCircle2 size={14} className="text-emerald-600" />;
  if (status === "empty")   return <MinusCircle  size={14} className="text-amber-600" />;
  if (status === "error")   return <XCircle      size={14} className="text-red-600" />;
  return <AlertTriangle size={14} className="text-neutral-400" />;
}

function StatusBadge({ status }) {
  const map = {
    live:    { cls: "border-emerald-200 bg-emerald-50 text-emerald-700", label: "Live" },
    empty:   { cls: "border-amber-200 bg-amber-50 text-amber-700",       label: "Empty" },
    error:   { cls: "border-red-200 bg-red-50 text-red-700",             label: "Error" },
    missing: { cls: "border-neutral-200 bg-neutral-50 text-neutral-500", label: "Missing" },
  };
  const m = map[status] ?? map.missing;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${m.cls}`}>
      <StatusIcon status={status} />
      {m.label}
    </span>
  );
}

function SyncDebugPanel({ debug, loading, onRefresh }) {
  const providers = debug?.providers ?? [];

  const counts = providers.reduce(
    (acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    },
    { live: 0, empty: 0, error: 0, missing: 0 },
  );

  return (
    <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-neutral-900 text-white">
            <Bug size={16} />
          </div>
          <div>
            <div className="text-[14px] font-semibold">Sync debug</div>
            <div className="mt-0.5 text-[12px] text-neutral-500">
              Per-provider cache status · payload sizes · last write errors
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
              <span>Last successful write: <strong className="text-neutral-700">{formatRelative(debug?.lastSuccessAt)}</strong></span>
              <span className="text-neutral-300">·</span>
              <span>Last write attempt: <strong className="text-neutral-700">{formatRelative(debug?.lastWriteAt)}</strong></span>
              <span className="text-neutral-300">·</span>
              <span><span className="text-emerald-600 font-medium">{counts.live} live</span> · <span className="text-amber-600 font-medium">{counts.empty} empty</span> · <span className="text-red-600 font-medium">{counts.error} errored</span> · <span className="text-neutral-500 font-medium">{counts.missing} missing</span></span>
            </div>
          </div>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-[12px] font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200">
        <table className="w-full text-[12px]">
          <thead className="bg-neutral-50 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Payload</th>
              <th className="px-3 py-2 text-right">Last sync</th>
              <th className="px-3 py-2 text-left">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {providers.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-neutral-400">
                  {loading ? "Loading…" : "No cache data yet — click Sync all now."}
                </td>
              </tr>
            )}
            {providers.map((p) => (
              <tr key={p.id} className="hover:bg-neutral-50/60">
                <td className="px-3 py-2 font-medium text-neutral-800">
                  {PROVIDER_LABELS[p.id] ?? p.id}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={p.status} />
                </td>
                <td className="px-3 py-2 text-right font-mono text-[11.5px] text-neutral-600">
                  {p.fetchedAt ? formatBytes(p.payloadSize) : "—"}
                </td>
                <td className="px-3 py-2 text-right text-neutral-500">
                  {p.fetchedAt ? (
                    <span title={p.fetchedAt}>{formatRelative(p.fetchedAt)}</span>
                  ) : (
                    "never"
                  )}
                </td>
                <td className="px-3 py-2 text-[11.5px] text-neutral-500">
                  {p.writeError ? (
                    <span className="font-mono text-red-600" title={p.writeError.at}>
                      write error: {p.writeError.message}
                    </span>
                  ) : p.errorMarker ? (
                    <span className="font-mono text-red-600" title="Fetcher threw">
                      fetcher error: {p.errorMessage ?? "unknown"}
                    </span>
                  ) : p.emptyMarker ? (
                    <span className="text-amber-700">API returned no data</span>
                  ) : p.status === "missing" ? (
                    <span className="text-neutral-400">never written</span>
                  ) : (
                    <span className="text-neutral-400">ok</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 text-[10.5px] text-neutral-400">
        Generated {debug?.generatedAt ? formatRelative(debug.generatedAt) : "—"}.
        Tracking <code>__empty</code> / <code>__error</code> markers from the cache, plus in-memory write errors.
      </div>
    </div>
  );
}
