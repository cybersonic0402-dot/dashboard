// @ts-nocheck
import { authedFetch } from "@/lib/authed-fetch";
import { useState, useEffect } from "react";
import { RefreshCw, Plug, CircleAlert, ChevronRight, LayoutDashboard, ExternalLink } from "lucide-react";

const SHOPIFY_STORES = [
  { id: "shopify_zapply-nl",      name: "Shopify NL", flag: "🇳🇱", shop: "zapply-nl.myshopify.com",      desc: "Netherlands · orders, revenue" },
  { id: "shopify_zapplyde",       name: "Shopify UK", flag: "🇬🇧", shop: "zapplyde.myshopify.com",       desc: "United Kingdom · orders, revenue" },
  { id: "shopify_zapply-usa",     name: "Shopify US", flag: "🇺🇸", shop: "zapply-usa.myshopify.com",     desc: "United States · orders, revenue" },
  
];

const API_KEY_SOURCES = [
  {
    id: "triplewhale",
    name: "Triple Whale",
    desc: "Ad spend, ROAS, NCPA, 90D/365D LTV",
    api: "REST v2 · TRIPLE_WHALE_API_KEY",
    color: "#6366f1",
    docsUrl: "https://developers.triplewhale.com",
  },
  {
    id: "loop",
    name: "Loop Subscriptions",
    desc: "MRR, active subs, churn, repeat rates",
    api: "REST · LOOP_UK_API_KEY",
    color: "#7C3AED",
    docsUrl: "https://developers.loopreturns.com",
  },
  {
    id: "juo",
    name: "Juo",
    desc: "Subscription analytics · retention cohorts",
    api: "REST · JUO_API_KEY",
    color: "#EC4899",
    docsUrl: "https://docs.juo.io",
  },
  {
    id: "fulfillment",
    name: "Fulfillment partner",
    desc: "3PL inventory · shipments · stock levels",
    api: "REST · FULFILLMENT_API_KEY",
    color: "#F59E0B",
    note: "Fulfillment partner",
    docsUrl: "#",
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
  {
    id: "xero",
    name: "Xero",
    desc: "Accounting · GL · invoices · bank feeds",
    api: "OAuth2 · XERO_CLIENT_ID/SECRET",
    color: "#13B5EA",
    note: "Incoming · Will replace Jortt within ~1 month",
    docsUrl: "https://developer.xero.com/documentation/api/accounting/overview",
  },
  {
    id: "paypal",
    name: "PayPal",
    desc: "Live account balances · 'To be Received'",
    api: "OAuth2 · PAYPAL_CLIENT_ID/SECRET",
    color: "#003087",
    docsUrl: "https://developer.paypal.com/api/rest/",
  },
  {
    id: "mollie",
    name: "Mollie",
    desc: "Live balances (available + pending) · 'To be Received'",
    api: "REST v2 · MOLLIE_API_KEY",
    color: "#0F2D40",
    docsUrl: "https://docs.mollie.com/reference/v2/balances-api/list-balances",
  },
  {
    id: "klaviyo",
    name: "Klaviyo",
    desc: "Email/SMS flows · campaign attribution",
    api: "REST · KLAVIYO_API_KEY",
    color: "#1E1E1E",
    docsUrl: "https://developers.klaviyo.com",
  },
  {
    id: "meta_ads",
    name: "Meta Ads",
    desc: "Facebook & Instagram ad spend, ROAS",
    api: "Graph API · META_ACCESS_TOKEN",
    color: "#1877F2",
    docsUrl: "https://developers.facebook.com/docs/marketing-apis",
  },
  {
    id: "google_ads",
    name: "Google Ads",
    desc: "Search/Shopping spend, conversions",
    api: "OAuth2 · GOOGLE_ADS_*",
    color: "#4285F4",
    docsUrl: "https://developers.google.com/google-ads/api/docs/start",
  },
  {
    id: "tiktok_ads",
    name: "TikTok Ads",
    desc: "Ad spend, CPM, conversions",
    api: "REST · TIKTOK_ACCESS_TOKEN",
    color: "#000000",
    docsUrl: "https://business-api.tiktok.com/portal/docs",
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

export default function SyncView({ initialConnections = {} }) {
  const [connections, setConnections] = useState(initialConnections);
  const [syncing, setSyncing] = useState(false);

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
  }, []);

  async function syncAll() {
    setSyncing(true);
    await authedFetch("/api/jortt").catch(() => {});
    setTimeout(() => setSyncing(false), 1500);
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
                      <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12px] font-medium text-emerald-700">
                        Live ✓
                      </span>
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
                    {status === "connected" ? (
                      <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12px] font-medium text-emerald-700">
                        Live ✓
                      </span>
                    ) : (
                      <div className="flex items-center gap-2">
                        {src.id === "jortt" ? (
                          <a
                            href="/api/jortt/connect"
                            className="rounded-lg border px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
                            style={{ backgroundColor: src.color, borderColor: src.color }}
                          >
                            Connect Jortt
                          </a>
                        ) : (
                          <span className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[12px] font-medium text-neutral-500">
                            Add keys to .env.local
                          </span>
                        )}
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
            { label: "Jortt", color: "#00A6A6", desc: "Accounting", sublabel: "→ Xero soon" },
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
      </div>
    </>
  );
}
