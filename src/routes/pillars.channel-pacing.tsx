import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DashboardShell } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import {
  getChannelPacingFn,
  setChannelTargetFn,
  deleteChannelTargetFn,
} from "@/server/dashboard.functions";

export const Route = createFileRoute("/pillars/channel-pacing")({
  head: () => ({ meta: [{ title: "Channel pacing — Zapply" }] }),
  component: ChannelPacingPage,
});

const MARKETS = ["NL", "UK", "US"] as const;
const CHANNELS = ["meta", "google", "tiktok"] as const;
type Market = (typeof MARKETS)[number];
type Channel = (typeof CHANNELS)[number];

type PacingRow = {
  market: Market;
  channel: Channel;
  monthStart: string;
  daysInMonth: number;
  daysElapsed: number;
  spendTarget: number | null;
  roasTarget: number | null;
  spendActual: number;
  roasActual: number | null;
  expectedSpendToDate: number | null;
  spendPacingPct: number | null;
  roasPacingPct: number | null;
  projectedMonthEndSpend: number | null;
  spendFlag: "green" | "yellow" | "red" | null;
  roasFlag: "green" | "yellow" | "red" | null;
  notes: string | null;
  targetId: string | null;
};

const CHANNEL_LABEL: Record<Channel, string> = {
  meta: "Meta",
  google: "Google",
  tiktok: "TikTok",
};
const MARKET_FLAG: Record<Market, string> = {
  NL: "🇳🇱",
  UK: "🇬🇧",
  US: "🇺🇸",
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function startOfThisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`;
}
function fmtMoney(n: number | null | undefined, currency = "EUR") {
  if (n == null || !isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(n);
}
function fmtPct(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return "—";
  const sign = n >= 100 ? "+" : "";
  return `${sign}${(n - 100).toFixed(1)}%`;
}
function fmtRoas(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return "—";
  return n.toFixed(2);
}
function monthLabel(monthStart: string) {
  const [y, m] = monthStart.split("-").map(Number);
  const d = new Date(y, (m ?? 1) - 1, 1);
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function flagClasses(f: "green" | "yellow" | "red" | null) {
  if (f === "green") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (f === "yellow") return "bg-amber-100 text-amber-800 border-amber-200";
  if (f === "red") return "bg-rose-100 text-rose-800 border-rose-200";
  return "bg-neutral-100 text-neutral-500 border-neutral-200";
}

function ChannelPacingPage() {
  const { user } = useDashboardSession();
  const [monthStart, setMonthStart] = useState<string>(startOfThisMonth());
  const [rows, setRows] = useState<PacingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await getChannelPacingFn({ data: { monthStart } })) as any;
      if (!res?.ok) {
        setError(res?.error ?? "Failed to load pacing data");
        setRows([]);
        return;
      }
      setRows(res.rows as PacingRow[]);
      setToday(res.today);
      setFetchedAt(res.fetchedAt);
      setWarning(res.warning ?? null);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load pacing data");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [monthStart]);

  useEffect(() => {
    void load();
  }, [load]);

  const rowsByMarket = useMemo(() => {
    const grouped = new Map<Market, PacingRow[]>();
    for (const m of MARKETS) grouped.set(m, []);
    for (const r of rows) grouped.get(r.market)?.push(r);
    return grouped;
  }, [rows]);

  return (
    <DashboardShell user={user}>
      <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">
              Channel pacing
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Month-to-date spend and ROAS vs target for Meta, Google, TikTok
              across NL · UK · US.{" "}
              {today ? (
                <span className="text-muted-foreground/80">
                  As of {today}
                  {fetchedAt
                    ? ` · refreshed ${new Date(fetchedAt).toLocaleTimeString()}`
                    : ""}
                </span>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground" htmlFor="month">
              Month
            </label>
            <input
              id="month"
              type="month"
              value={monthStart.slice(0, 7)}
              onChange={(e) => {
                const v = e.target.value;
                if (/^\d{4}-\d{2}$/.test(v)) setMonthStart(`${v}-01`);
              }}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </header>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {warning ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {warning}
          </div>
        ) : null}

        <div className="text-xs text-muted-foreground">
          Showing {monthLabel(monthStart)}. Flags: green &lt; 10% deviation,
          yellow 10–15%, red &gt; 15%.
        </div>

        <div className="space-y-6">
          {MARKETS.map((market) => {
            const mRows = rowsByMarket.get(market) ?? [];
            return (
              <MarketCard
                key={market}
                market={market}
                rows={mRows}
                editKey={editKey}
                onEdit={(key) => setEditKey(key)}
                onSaved={() => {
                  setEditKey(null);
                  void load();
                }}
                onCancel={() => setEditKey(null)}
                monthStart={monthStart}
              />
            );
          })}
        </div>
      </div>
    </DashboardShell>
  );
}

function MarketCard({
  market,
  rows,
  editKey,
  onEdit,
  onSaved,
  onCancel,
  monthStart,
}: {
  market: Market;
  rows: PacingRow[];
  editKey: string | null;
  onEdit: (key: string) => void;
  onSaved: () => void;
  onCancel: () => void;
  monthStart: string;
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-lg font-semibold text-foreground">
          <span className="mr-2">{MARKET_FLAG[market]}</span>
          {market}
        </h2>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left">Channel</th>
              <th className="px-4 py-2 text-right">Spend target</th>
              <th className="px-4 py-2 text-right">MTD spend</th>
              <th className="px-4 py-2 text-right">Expected MTD</th>
              <th className="px-4 py-2 text-right">Spend pacing</th>
              <th className="px-4 py-2 text-right">Projected end</th>
              <th className="px-4 py-2 text-right">ROAS target</th>
              <th className="px-4 py-2 text-right">ROAS actual</th>
              <th className="px-4 py-2 text-right">ROAS pacing</th>
              <th className="px-4 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = `${r.market}|${r.channel}`;
              const isEditing = editKey === key;
              if (isEditing) {
                return (
                  <TargetEditRow
                    key={key}
                    row={r}
                    monthStart={monthStart}
                    onSaved={onSaved}
                    onCancel={onCancel}
                  />
                );
              }
              return (
                <tr key={key} className="border-t border-border">
                  <td className="px-4 py-2 font-medium text-foreground">
                    {CHANNEL_LABEL[r.channel]}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtMoney(r.spendTarget)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtMoney(r.spendActual)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                    {fmtMoney(r.expectedSpendToDate)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <PacingChip
                      pct={r.spendPacingPct}
                      flag={r.spendFlag}
                      direction="spend"
                    />
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtMoney(r.projectedMonthEndSpend)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtRoas(r.roasTarget)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtRoas(r.roasActual)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <PacingChip
                      pct={r.roasPacingPct}
                      flag={r.roasFlag}
                      direction="roas"
                    />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onEdit(key)}
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs font-medium hover:bg-muted"
                    >
                      {r.targetId ? "Edit target" : "Set target"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PacingChip({
  pct,
  flag,
  direction,
}: {
  pct: number | null;
  flag: "green" | "yellow" | "red" | null;
  direction: "spend" | "roas";
}) {
  if (pct == null) {
    return <span className="text-xs text-muted-foreground">no target</span>;
  }
  const dev = pct - 100;
  const label = `${dev >= 0 ? "+" : ""}${dev.toFixed(1)}%`;
  const hint =
    direction === "spend"
      ? dev > 0
        ? "ahead on spend"
        : "behind on spend"
      : dev > 0
        ? "beating ROAS"
        : "below ROAS";
  return (
    <span
      title={`${pct.toFixed(1)}% of target · ${hint}`}
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${flagClasses(flag)}`}
    >
      {label}
    </span>
  );
}

function TargetEditRow({
  row,
  monthStart,
  onSaved,
  onCancel,
}: {
  row: PacingRow;
  monthStart: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [spend, setSpend] = useState<string>(
    row.spendTarget != null ? String(row.spendTarget) : "",
  );
  const [roas, setRoas] = useState<string>(
    row.roasTarget != null ? String(row.roasTarget) : "",
  );
  const [notes, setNotes] = useState<string>(row.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setErr(null);
    try {
      const sp = Number(spend);
      const rs = Number(roas);
      if (!isFinite(sp) || sp < 0) throw new Error("Spend must be a number ≥ 0");
      if (!isFinite(rs) || rs < 0) throw new Error("ROAS must be a number ≥ 0");
      const res = (await setChannelTargetFn({
        data: {
          market: row.market,
          channel: row.channel,
          month: monthStart,
          spend_target: sp,
          roas_target: rs,
          notes: notes.trim() ? notes.trim() : null,
        },
      })) as any;
      if (!res?.ok) throw new Error(res?.error ?? "Save failed");
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!row.targetId) return;
    if (!confirm(`Delete the ${CHANNEL_LABEL[row.channel]} target for ${row.market}?`)) return;
    setSaving(true);
    setErr(null);
    try {
      const res = (await deleteChannelTargetFn({
        data: { id: row.targetId },
      })) as any;
      if (!res?.ok) throw new Error(res?.error ?? "Delete failed");
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-t border-border bg-muted/20">
      <td className="px-4 py-2 font-medium text-foreground">
        {CHANNEL_LABEL[row.channel]}
      </td>
      <td className="px-4 py-2 text-right" colSpan={3}>
        <div className="flex items-center justify-end gap-2">
          <label className="text-xs text-muted-foreground">Spend €</label>
          <input
            type="number"
            min="0"
            step="100"
            value={spend}
            onChange={(e) => setSpend(e.target.value)}
            className="w-28 rounded-md border border-input bg-background px-2 py-1 text-right text-sm tabular-nums"
          />
        </div>
      </td>
      <td className="px-4 py-2" colSpan={2}>
        <input
          type="text"
          placeholder="notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
        />
      </td>
      <td className="px-4 py-2 text-right" colSpan={2}>
        <div className="flex items-center justify-end gap-2">
          <label className="text-xs text-muted-foreground">ROAS</label>
          <input
            type="number"
            min="0"
            step="0.05"
            value={roas}
            onChange={(e) => setRoas(e.target.value)}
            className="w-20 rounded-md border border-input bg-background px-2 py-1 text-right text-sm tabular-nums"
          />
        </div>
      </td>
      <td className="px-4 py-2 text-right" colSpan={2}>
        <div className="flex items-center justify-end gap-2">
          {row.targetId ? (
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={saving}
              className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
            >
              Delete
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {err ? (
          <div className="mt-1 text-right text-xs text-destructive">{err}</div>
        ) : null}
      </td>
    </tr>
  );
}
