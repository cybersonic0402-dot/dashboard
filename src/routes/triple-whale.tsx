import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import type { DateRange } from "react-day-picker";
import { DashboardShell, RefreshButton } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { useInstantDashboardData } from "@/components/dashboard/useInstantDashboardData";
import { DateRangePicker, defaultRange, toIsoDate } from "@/components/dashboard/Filters";
import { getTripleWhaleDashboard } from "@/server/dashboard-pages.functions";
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

export const Route = createFileRoute("/triple-whale")({
  head: () => ({
    meta: [{ title: "Triple Whale Dashboard — Zapply" }],
  }),
  component: TripleWhalePage,
});

type TWData = Awaited<ReturnType<typeof getTripleWhaleDashboard>>;

function fmtMoney(n: number | null | undefined, currency = "EUR") {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${n.toFixed(0)} ${currency}`;
  }
}
function fmtNum(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString();
}
function fmtRoas(n: number | null | undefined) {
  if (n == null) return "—";
  return `${n.toFixed(2)}×`;
}

function TripleWhalePage() {
  const { user, loading } = useDashboardSession();
  const [range, setRange] = useState<DateRange>(defaultRange());
  const from = toIsoDate(range.from);
  const to = toIsoDate(range.to);
  const fetchDashboard = useCallback(
    (force: boolean) => getTripleWhaleDashboard({ data: { from, to, force } }),
    [from, to]
  );
  const { data, isLoading, load } = useInstantDashboardData<TWData>(
    `triple-whale.${from}.${to}`,
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

  const rows: any[] = Array.isArray(data?.data) ? (data!.data as any[]) : [];

  // Aggregate totals
  const total = rows.reduce(
    (acc, r) => {
      acc.revenue += r.revenue ?? 0;
      acc.adSpend += r.adSpend ?? 0;
      acc.orders += r.orders ?? 0;
      return acc;
    },
    { revenue: 0, adSpend: 0, orders: 0 }
  );

  return (
    <DashboardShell
      user={user}
      title="Triple Whale Dashboard"
      actions={
        <>
          <DateRangePicker value={range} onChange={setRange} />
          <RefreshButton onRefresh={() => load(true)} isLoading={isLoading} />
        </>
      }
    >
      <div className="p-6 space-y-6">
        {data?.source === "cache" && (
          <Card className="border-yellow-500/40 bg-yellow-500/5">
            <CardContent className="pt-6 text-sm">
              Showing cached data — Triple Whale live API didn't respond for this range.
            </CardContent>
          </Card>
        )}
        {data?.source === "none" && !isLoading && (
          <Card className="border-destructive/40">
            <CardContent className="pt-6 text-sm">No Triple Whale data available.</CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard label="Total Revenue" value={fmtMoney(total.revenue)} />
          <KpiCard label="Total Ad Spend" value={fmtMoney(total.adSpend)} />
          <KpiCard label="Blended ROAS" value={total.adSpend > 0 ? fmtRoas(total.revenue / total.adSpend) : "—"} />
          <KpiCard label="Orders" value={fmtNum(total.orders)} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Per-market breakdown</CardTitle>
            <CardDescription>Live metrics from Triple Whale</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Market</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Net Rev</TableHead>
                    <TableHead className="text-right">Ad Spend</TableHead>
                    <TableHead className="text-right">FB Spend</TableHead>
                    <TableHead className="text-right">Google Spend</TableHead>
                    <TableHead className="text-right">ROAS</TableHead>
                    <TableHead className="text-right">MER</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">AOV</TableHead>
                    <TableHead className="text-right">Net Profit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.market}>
                      <TableCell className="font-medium">
                        {r.flag} {r.market}
                      </TableCell>
                      <TableCell className="text-right">{fmtMoney(r.revenue)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(r.netRevenue)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(r.adSpend)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(r.facebookSpend)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(r.googleSpend)}</TableCell>
                      <TableCell className="text-right">{fmtRoas(r.roas)}</TableCell>
                      <TableCell className="text-right">{fmtRoas(r.mer)}</TableCell>
                      <TableCell className="text-right">{fmtNum(r.orders)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(r.aov)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(r.netProfit)}</TableCell>
                    </TableRow>
                  ))}
                  {!isLoading && rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                        No data
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
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}
