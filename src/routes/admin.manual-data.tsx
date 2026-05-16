import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Plus, Trash2, Save } from "lucide-react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import {
  listCashPositions,
  upsertCashPosition,
  deleteCashPosition,
  listInventoryPositions,
  upsertInventoryPosition,
  deleteInventoryPosition,
  getAppSettings,
  setAppSetting,
} from "@/server/manual-data.functions";
import {
  probePicqerConnection,
  triggerPicqerSyncNow,
} from "@/server/dashboard.functions";

export const Route = createFileRoute("/admin/manual-data")({
  head: () => ({ meta: [{ title: "Manual data — Zapply" }] }),
  component: ManualDataPage,
});

type Cash = {
  id?: string;
  account_name: string;
  account_type: string;
  currency: string;
  balance_eur: number;
  notes?: string | null;
};

type Inv = {
  id?: string;
  sku: string;
  name: string;
  location: string;
  pieces: number;
  unit_cost_eur: number;
  notes?: string | null;
};

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-neutral-200 bg-white ${className}`}>{children}</div>
  );
}

type MarketCost = { shippingPerOrder: number; paymentFeePct: number };
const MARKET_CODES = ["NL", "UK", "US", "EU", "DE"] as const;
const MARKET_FLAGS: Record<string, string> = { NL: "🇳🇱", UK: "🇬🇧", US: "🇺🇸", EU: "🇪🇺", DE: "🇩🇪" };
const DEFAULT_MARKET_COSTS: Record<string, MarketCost> = Object.fromEntries(
  MARKET_CODES.map((c) => [c, { shippingPerOrder: 0, paymentFeePct: 0 }]),
);

type PicqerStatus = {
  ok: boolean;
  status: number | null;
  reason: string | null;
  baseUrl: string | null;
  warehouseCount?: number;
};

function ManualDataPage() {
  const { user } = useDashboardSession();
  const [cash, setCash] = useState<Cash[]>([]);
  const [inv, setInv] = useState<Inv[]>([]);
  const [minBuffer, setMinBuffer] = useState<number>(50000);
  const [marketCosts, setMarketCosts] = useState<Record<string, MarketCost>>(DEFAULT_MARKET_COSTS);
  const [savingMsg, setSavingMsg] = useState<string>("");
  // Picqer connection probe — populated on mount, shown above the inventory
  // table so the user can see at a glance whether live data is flowing.
  const [picqer, setPicqer] = useState<PicqerStatus | null>(null);
  const [picqerSyncing, setPicqerSyncing] = useState(false);
  const [picqerLastRun, setPicqerLastRun] = useState<{ ok: boolean; rows?: number; error?: string | null } | null>(null);

  async function reload() {
    const [c, i, s] = await Promise.all([
      listCashPositions(),
      listInventoryPositions(),
      getAppSettings(),
    ]);
    setCash(c as any);
    setInv(i as any);
    if ((s as any)?.min_cash_buffer_eur?.amount != null) {
      setMinBuffer(Number((s as any).min_cash_buffer_eur.amount));
    }
    const mc = (s as any)?.market_costs;
    if (mc && typeof mc === "object") {
      const merged = { ...DEFAULT_MARKET_COSTS };
      for (const code of MARKET_CODES) {
        if (mc[code]) {
          merged[code] = {
            shippingPerOrder: Number(mc[code].shippingPerOrder ?? 0) || 0,
            paymentFeePct: Number(mc[code].paymentFeePct ?? 0) || 0,
          };
        }
      }
      setMarketCosts(merged);
    }
  }
  useEffect(() => {
    reload();
    // Probe Picqer once on mount — cheap call (/api/v1/warehouses), gives us
    // status + base URL + warehouse count for the banner.
    probePicqerConnection()
      .then((res: any) => setPicqer(res as PicqerStatus))
      .catch((err: any) =>
        setPicqer({ ok: false, status: null, reason: String(err?.message ?? err), baseUrl: null }),
      );
  }, []);

  async function runPicqerSync() {
    setPicqerSyncing(true);
    setPicqerLastRun(null);
    try {
      const res: any = await triggerPicqerSyncNow();
      setPicqerLastRun({ ok: !!res?.ok, rows: res?.rows, error: res?.error });
      // Re-probe so the banner reflects the latest state.
      const probe: any = await probePicqerConnection();
      setPicqer(probe as PicqerStatus);
      // Reload the manual rows table so the user sees any conflicts.
      await reload();
    } catch (err: any) {
      setPicqerLastRun({ ok: false, error: String(err?.message ?? err) });
    } finally {
      setPicqerSyncing(false);
    }
  }

  function flash(m: string) {
    setSavingMsg(m);
    setTimeout(() => setSavingMsg(""), 1500);
  }

  async function saveCash(row: Cash) {
    await upsertCashPosition({
      data: { ...row, balance_eur: Number(row.balance_eur) || 0 },
    });
    flash("Saved");
    reload();
  }
  async function removeCash(id?: string) {
    if (!id) return;
    await deleteCashPosition({ data: { id } });
    reload();
  }
  async function saveInv(row: Inv) {
    await upsertInventoryPosition({
      data: {
        ...row,
        pieces: Number(row.pieces) || 0,
        unit_cost_eur: Number(row.unit_cost_eur) || 0,
      },
    });
    flash("Saved");
    reload();
  }
  async function removeInv(id?: string) {
    if (!id) return;
    await deleteInventoryPosition({ data: { id } });
    reload();
  }
  async function saveBuffer() {
    await setAppSetting({
      data: { key: "min_cash_buffer_eur", value: { amount: Number(minBuffer) || 0 } },
    });
    flash("Buffer saved");
  }
  async function saveMarketCosts() {
    const clean: Record<string, MarketCost> = {};
    for (const code of MARKET_CODES) {
      clean[code] = {
        shippingPerOrder: Number(marketCosts[code]?.shippingPerOrder) || 0,
        paymentFeePct: Number(marketCosts[code]?.paymentFeePct) || 0,
      };
    }
    await setAppSetting({ data: { key: "market_costs", value: clean } });
    flash("Market costs saved");
  }

  return (
    <DashboardShell user={user} title="Manual data">
      <div className="mx-auto max-w-[1200px] p-6 space-y-6">
        <div>
          <div className="text-[12px] font-medium text-neutral-400">Admin</div>
          <h1 className="mt-1 text-[24px] font-semibold tracking-tight">Manual data</h1>
          <p className="mt-1 text-[13px] text-neutral-500">
            Cash positions, inventory/FFC stock and the minimum cash buffer used by Forecast & Balance Sheet.
          </p>
          {savingMsg && (
            <div className="mt-2 inline-block rounded-md bg-emerald-50 px-2 py-1 text-[12px] text-emerald-700">
              {savingMsg}
            </div>
          )}
        </div>

        {/* Min cash buffer */}
        <Card className="p-5">
          <div className="text-[14px] font-semibold">Minimum cash buffer</div>
          <div className="mt-1 text-[12px] text-neutral-500">
            Forecast warns when projected cash drops below this line.
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[13px] text-neutral-500">€</span>
            <input
              type="number"
              value={minBuffer}
              onChange={(e) => setMinBuffer(Number(e.target.value))}
              className="w-40 rounded-md border border-neutral-200 px-2 py-1.5 text-[13px] tabular-nums"
            />
            <button
              onClick={saveBuffer}
              className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-[12px] font-medium text-white"
            >
              <Save size={12} /> Save
            </button>
          </div>
        </Card>

        {/* Per-market costs */}
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[14px] font-semibold">Shipping & payment fees per market</div>
              <div className="mt-1 text-[12px] text-neutral-500">
                Used by Margin per Market to compute contribution margin. Shipping is per order; payment fee is a % of revenue.
              </div>
            </div>
            <button
              onClick={saveMarketCosts}
              className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-[12px] font-medium text-white"
            >
              <Save size={12} /> Save all
            </button>
          </div>
          <div className="mt-4 overflow-hidden rounded-lg border border-neutral-100">
            <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 bg-neutral-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              <div>Market</div>
              <div className="text-right">Shipping (€/order)</div>
              <div className="text-right">Payment fee (% of revenue)</div>
            </div>
            {MARKET_CODES.map((code) => (
              <div
                key={code}
                className="grid grid-cols-[1fr_1fr_1fr] items-center gap-2 border-t border-neutral-100 px-3 py-2 text-[12px]"
              >
                <div className="font-medium">
                  <span className="mr-2">{MARKET_FLAGS[code]}</span>
                  {code === "UK" ? "GB" : code}
                </div>
                <input
                  type="number"
                  step="0.01"
                  value={marketCosts[code]?.shippingPerOrder ?? 0}
                  onChange={(e) =>
                    setMarketCosts((m) => ({
                      ...m,
                      [code]: { ...m[code], shippingPerOrder: Number(e.target.value) },
                    }))
                  }
                  className="rounded-md border border-neutral-200 px-2 py-1 text-right tabular-nums"
                />
                <input
                  type="number"
                  step="0.01"
                  value={marketCosts[code]?.paymentFeePct ?? 0}
                  onChange={(e) =>
                    setMarketCosts((m) => ({
                      ...m,
                      [code]: { ...m[code], paymentFeePct: Number(e.target.value) },
                    }))
                  }
                  className="rounded-md border border-neutral-200 px-2 py-1 text-right tabular-nums"
                />
              </div>
            ))}
          </div>
        </Card>

        {/* Cash positions */}
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[14px] font-semibold">Cash positions</div>
              <div className="mt-1 text-[12px] text-neutral-500">
                Banks + payment processors not pulled live (Mollie, PayPal, Shopify Payments, etc.)
              </div>
            </div>
            <button
              onClick={() =>
                setCash((rows) => [
                  ...rows,
                  {
                    account_name: "",
                    account_type: "bank",
                    currency: "EUR",
                    balance_eur: 0,
                  },
                ])
              }
              className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-3 py-1.5 text-[12px] font-medium hover:bg-neutral-50"
            >
              <Plus size={12} /> Add account
            </button>
          </div>
          <div className="mt-4 overflow-hidden rounded-lg border border-neutral-100">
            <div className="grid grid-cols-[2fr_1fr_0.7fr_1fr_2fr_auto] gap-2 bg-neutral-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              <div>Account</div>
              <div>Type</div>
              <div>Ccy</div>
              <div className="text-right">Balance (EUR)</div>
              <div>Notes</div>
              <div></div>
            </div>
            {cash.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-neutral-400">
                No accounts yet. Click "Add account".
              </div>
            ) : (
              cash.map((row, i) => (
                <div
                  key={row.id ?? `new-${i}`}
                  className="grid grid-cols-[2fr_1fr_0.7fr_1fr_2fr_auto] items-center gap-2 border-t border-neutral-100 px-3 py-2 text-[12px]"
                >
                  <input
                    value={row.account_name}
                    onChange={(e) =>
                      setCash((r) =>
                        r.map((x, j) => (j === i ? { ...x, account_name: e.target.value } : x)),
                      )
                    }
                    placeholder="ING NL Business"
                    className="rounded-md border border-neutral-200 px-2 py-1"
                  />
                  <select
                    value={row.account_type}
                    onChange={(e) =>
                      setCash((r) =>
                        r.map((x, j) => (j === i ? { ...x, account_type: e.target.value } : x)),
                      )
                    }
                    className="rounded-md border border-neutral-200 px-2 py-1"
                  >
                    <option value="bank">bank</option>
                    <option value="mollie">mollie</option>
                    <option value="paypal">paypal</option>
                    <option value="shopify">shopify</option>
                    <option value="stripe">stripe</option>
                    <option value="receivable">receivable</option>
                    <option value="payable">payable</option>
                    <option value="other">other</option>
                  </select>
                  <select
                    value={row.currency}
                    onChange={(e) =>
                      setCash((r) =>
                        r.map((x, j) => (j === i ? { ...x, currency: e.target.value } : x)),
                      )
                    }
                    className="rounded-md border border-neutral-200 px-2 py-1"
                  >
                    <option>EUR</option>
                    <option>GBP</option>
                    <option>USD</option>
                  </select>
                  <input
                    type="number"
                    value={row.balance_eur}
                    onChange={(e) =>
                      setCash((r) =>
                        r.map((x, j) =>
                          j === i ? { ...x, balance_eur: Number(e.target.value) } : x,
                        ),
                      )
                    }
                    className="rounded-md border border-neutral-200 px-2 py-1 text-right tabular-nums"
                  />
                  <input
                    value={row.notes ?? ""}
                    onChange={(e) =>
                      setCash((r) =>
                        r.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)),
                      )
                    }
                    placeholder="optional"
                    className="rounded-md border border-neutral-200 px-2 py-1"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => saveCash(row)}
                      className="rounded-md bg-neutral-900 px-2 py-1 text-[11px] font-medium text-white"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => removeCash(row.id)}
                      className="rounded-md border border-neutral-200 p-1 text-neutral-500 hover:text-rose-600"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* Inventory */}
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[14px] font-semibold">Inventory / FFC stock</div>
              <div className="mt-1 text-[12px] text-neutral-500">
                Live stock comes from Picqer (TRL Fulfilment) when configured. Rows below are
                <em> manual overrides</em> — they win over Picqer on the same SKU + location, useful for
                damaged stock, off-warehouse positions, or annotations.
              </div>
            </div>
            <button
              onClick={() =>
                setInv((rows) => [
                  ...rows,
                  { sku: "", name: "", location: "NL", pieces: 0, unit_cost_eur: 0 },
                ])
              }
              className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-3 py-1.5 text-[12px] font-medium hover:bg-neutral-50"
            >
              <Plus size={12} /> Add manual override
            </button>
          </div>
          {/* Picqer status banner */}
          <div className="mt-4">
            {picqer === null ? (
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-[12px] text-neutral-500">
                Checking Picqer connection…
              </div>
            ) : picqer.ok ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
                <div>
                  <span className="font-semibold">Picqer connected</span>
                  {picqer.baseUrl && (
                    <span className="text-emerald-700/80"> · {picqer.baseUrl.replace(/^https?:\/\//, "")}</span>
                  )}
                  {typeof picqer.warehouseCount === "number" && (
                    <span className="text-emerald-700/80"> · {picqer.warehouseCount} warehouse{picqer.warehouseCount === 1 ? "" : "s"}</span>
                  )}
                  {picqerLastRun && (
                    <span className="ml-2 text-emerald-700/90">
                      ·
                      {picqerLastRun.ok
                        ? ` last sync ok${picqerLastRun.rows != null ? `, ${picqerLastRun.rows} rows` : ""}`
                        : ` last sync failed: ${picqerLastRun.error ?? "unknown"}`}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  disabled={picqerSyncing}
                  onClick={runPicqerSync}
                  className="shrink-0 rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-60"
                >
                  {picqerSyncing ? "Syncing…" : "Sync now"}
                </button>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                <div className="font-semibold">Picqer not connected</div>
                <div className="mt-0.5 text-amber-700/90 break-words">{picqer.reason ?? "Unknown error"}</div>
                <div className="mt-2 text-amber-700/80">
                  Set <code className="rounded bg-amber-100 px-1 py-0.5 text-[10px]">PICQER_SUBDOMAIN</code> and{" "}
                  <code className="rounded bg-amber-100 px-1 py-0.5 text-[10px]">PICQER_API_KEY</code> in <code>.env</code>, then restart the dev server.
                </div>
                {picqer.baseUrl && (
                  <div className="mt-1 text-amber-700/70">Currently trying: {picqer.baseUrl}</div>
                )}
                <button
                  type="button"
                  disabled={picqerSyncing}
                  onClick={runPicqerSync}
                  className="mt-2 inline-flex items-center rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60"
                >
                  {picqerSyncing ? "Retrying…" : "Retry"}
                </button>
              </div>
            )}
          </div>
          <div className="mt-4 overflow-hidden rounded-lg border border-neutral-100">
            <div className="grid grid-cols-[1fr_2fr_0.7fr_0.8fr_1fr_auto] gap-2 bg-neutral-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              <div>SKU</div>
              <div>Name</div>
              <div>Loc</div>
              <div className="text-right">Pieces</div>
              <div className="text-right">Unit cost (EUR)</div>
              <div></div>
            </div>
            {inv.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-neutral-400">
                No SKUs yet. Click "Add SKU".
              </div>
            ) : (
              inv.map((row, i) => (
                <div
                  key={row.id ?? `new-${i}`}
                  className="grid grid-cols-[1fr_2fr_0.7fr_0.8fr_1fr_auto] items-center gap-2 border-t border-neutral-100 px-3 py-2 text-[12px]"
                >
                  <input
                    value={row.sku}
                    onChange={(e) =>
                      setInv((r) => r.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))
                    }
                    placeholder="SKU-001"
                    className="rounded-md border border-neutral-200 px-2 py-1 font-mono"
                  />
                  <input
                    value={row.name}
                    onChange={(e) =>
                      setInv((r) => r.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                    }
                    placeholder="Product name"
                    className="rounded-md border border-neutral-200 px-2 py-1"
                  />
                  <select
                    value={row.location}
                    onChange={(e) =>
                      setInv((r) =>
                        r.map((x, j) => (j === i ? { ...x, location: e.target.value } : x)),
                      )
                    }
                    className="rounded-md border border-neutral-200 px-2 py-1"
                  >
                    <option>NL</option>
                    <option>UK</option>
                    <option>US</option>
                    <option>EU</option>
                  </select>
                  <input
                    type="number"
                    value={row.pieces}
                    onChange={(e) =>
                      setInv((r) =>
                        r.map((x, j) => (j === i ? { ...x, pieces: Number(e.target.value) } : x)),
                      )
                    }
                    className="rounded-md border border-neutral-200 px-2 py-1 text-right tabular-nums"
                  />
                  <input
                    type="number"
                    value={row.unit_cost_eur}
                    onChange={(e) =>
                      setInv((r) =>
                        r.map((x, j) =>
                          j === i ? { ...x, unit_cost_eur: Number(e.target.value) } : x,
                        ),
                      )
                    }
                    className="rounded-md border border-neutral-200 px-2 py-1 text-right tabular-nums"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => saveInv(row)}
                      className="rounded-md bg-neutral-900 px-2 py-1 text-[11px] font-medium text-white"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => removeInv(row.id)}
                      className="rounded-md border border-neutral-200 p-1 text-neutral-500 hover:text-rose-600"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </DashboardShell>
  );
}
