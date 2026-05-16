import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import type { DateRange } from "react-day-picker";
import { format } from "date-fns";
import { DashboardShell, RefreshButton } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { useInstantDashboardData } from "@/components/dashboard/useInstantDashboardData";
import { StoreSelect, DateRangePicker, defaultRange, toIsoDate, type StoreOption } from "@/components/dashboard/Filters";
import { getSubscriptionDashboard } from "@/server/dashboard-pages.functions";
import { STORE_OPTIONS } from "@/lib/dashboard-stores";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

export const Route = createFileRoute("/subscriptions")({
  head: () => ({
    meta: [{ title: "Subscriptions Dashboard — Zapply" }],
  }),
  component: SubscriptionsPage,
});

type SubData = Awaited<ReturnType<typeof getSubscriptionDashboard>>;

function fmtMoney(n: number | null | undefined, currency = "EUR") {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${n.toFixed(0)} ${currency}`;
  }
}

function statusColor(status: string | null) {
  const s = (status ?? "").toUpperCase();
  if (s === "ACTIVE") return "text-emerald-600 bg-emerald-50";
  if (s === "PAUSED") return "text-yellow-600 bg-yellow-50";
  if (s === "CANCELLED" || s === "CANCELED") return "text-rose-600 bg-rose-50";
  return "text-muted-foreground bg-muted";
}

function SubscriptionsPage() {
  const { user, loading } = useDashboardSession();
  const [storeCode, setStoreCode] = useState<string>("NL");
  const [range, setRange] = useState<DateRange>(defaultRange());
  const from = toIsoDate(range.from);
  const to = toIsoDate(range.to);
  const fetchDashboard = useCallback(
    (force: boolean) => getSubscriptionDashboard({ data: { storeCode: storeCode as any, from, to, force } }),
    [storeCode, from, to]
  );
  const { data, isLoading, load } = useInstantDashboardData<SubData>(
    `subscriptions.${storeCode}.${from}.${to}`,
    fetchDashboard,
    !!user
  );

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const result: any = data?.data ?? null;
  const platform = data?.platform;
  const totals = result?.totals ?? {};
  const subs: any[] = result?.subscriptions ?? [];
  const currency = result?.currency ?? "EUR";
  const summaryOnly = result?.summaryOnly === true;

  return (
    <DashboardShell
      user={user}
      title="Subscriptions Dashboard"
      actions={
        <>
          <StoreSelect value={storeCode} onChange={setStoreCode} options={[...STORE_OPTIONS]} />
          <DateRangePicker value={range} onChange={setRange} />
          <RefreshButton onRefresh={() => load(true)} isLoading={isLoading} />
        </>
      }
    >
      <div className="p-6 space-y-6">
        {data?.source === "cache" && (
          <div className="text-xs text-muted-foreground">
            Cached · updated {Math.round((data as any).ageMinutes ?? 0)} min ago · click Refresh for live data
          </div>
        )}
        <Card className="bg-card/50">
          <CardContent className="pt-6 flex items-center gap-3 text-sm">
            <span className="font-medium">Source:</span>
            <span className="px-2 py-0.5 rounded-md bg-primary/10 text-primary font-mono text-xs">
              {platform?.toUpperCase() ?? "—"}
            </span>
            <span className="text-muted-foreground">
              {storeCode === "NL" ? "Juo subscription platform (NL store)" : `Loop Subscriptions (${storeCode})`}
            </span>
          </CardContent>
        </Card>

        {result?.error && (
          <Card className="border-destructive/40">
            <CardContent className="pt-6 text-sm text-destructive">{result.error}</CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <KpiCard label="MRR" value={fmtMoney(totals.mrr, currency)} />
          <KpiCard label="Active subs" value={(totals.active ?? 0).toLocaleString()} />
          <KpiCard label="Canceled" value={(totals.canceled ?? 0).toLocaleString()} />
          <KpiCard label="ARPU" value={fmtMoney(totals.arpu, currency)} />
          <KpiCard label="New in range" value={(totals.newInRange ?? 0).toLocaleString()} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Subscriptions</CardTitle>
            <CardDescription>
              {summaryOnly ? "Store totals loaded · subscription rows are syncing" : `${subs.length} subscriptions on file · `}
              {!summaryOnly && (
                <span className="text-foreground font-medium">{totals.newInRange ?? 0}</span>
              )}{" "}
              {!summaryOnly && "created in selected range"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border max-h-[600px] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Next billing</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subs.slice(0, 200).map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <div className="text-sm font-medium">{s.customerName ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{s.customerEmail ?? ""}</div>
                      </TableCell>
                      <TableCell>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor(s.status)}`}>
                          {s.status ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {s.createdAt ? format(new Date(s.createdAt), "MMM d, yyyy") : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {s.nextBillingDate ? format(new Date(s.nextBillingDate), "MMM d, yyyy") : "—"}
                      </TableCell>
                      <TableCell className="text-right font-medium">{fmtMoney(s.price, s.currency)}</TableCell>
                    </TableRow>
                  ))}
                  {!isLoading && subs.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                        {summaryOnly ? "Detailed subscription rows are still syncing for this store" : "No subscriptions in this range"}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="text-xs">{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}
