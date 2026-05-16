import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import type { DateRange } from "react-day-picker";
import { DashboardShell, RefreshButton } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { useInstantDashboardData } from "@/components/dashboard/useInstantDashboardData";
import { StoreSelect, DateRangePicker, defaultRange, toIsoDate, type StoreOption } from "@/components/dashboard/Filters";
import { getStoreDashboard } from "@/server/dashboard-pages.functions";
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
import { format } from "date-fns";

export const Route = createFileRoute("/store")({
  head: () => ({
    meta: [{ title: "Store Dashboard — Zapply" }],
  }),
  component: StoreDashboardPage,
});

type StoreData = Awaited<ReturnType<typeof getStoreDashboard>>;

function fmtMoney(n: number, currency = "EUR") {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${n.toFixed(0)} ${currency}`;
  }
}

function StoreDashboardPage() {
  const { user, loading } = useDashboardSession();
  const [storeCode, setStoreCode] = useState<string>("NL");
  const [range, setRange] = useState<DateRange>(defaultRange());
  const from = toIsoDate(range.from);
  const to = toIsoDate(range.to);
  const fetchDashboard = useCallback(
    (force: boolean) => getStoreDashboard({ data: { storeCode: storeCode as any, from, to, force } }),
    [storeCode, from, to]
  );
  const { data, isLoading, load } = useInstantDashboardData<StoreData>(
    `store.${storeCode}.${from}.${to}`,
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

  const detail = data?.detail ?? null;
  const totals = detail?.totals;
  const currency = detail?.currency ?? "EUR";

  return (
    <DashboardShell
      user={user}
      title="Store Dashboard"
      actions={
        <>
          <StoreSelect value={storeCode} onChange={setStoreCode} options={[...STORE_OPTIONS]} />
          <DateRangePicker value={range} onChange={setRange} />
          <RefreshButton onRefresh={() => load(true)} isLoading={isLoading} />
        </>
      }
    >
      <div className="p-6 space-y-6">
        {data?.source === "cache" && data?.fetchedAt && (
          <div className="text-xs text-muted-foreground">
            Cached · updated {Math.round(data.ageMinutes ?? 0)} min ago · click Refresh for live data
          </div>
        )}
        {data?.error && (
          <Card className="border-destructive">
            <CardContent className="pt-6 text-sm text-destructive">Error: {data.error}</CardContent>
          </Card>
        )}

        {detail?.error && (
          <Card className="border-yellow-500">
            <CardContent className="pt-6 text-sm">{detail.error}</CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <KpiCard label="Revenue" value={totals ? fmtMoney(totals.revenue, currency) : "—"} loading={isLoading} />
          <KpiCard label="Orders" value={totals ? totals.orders.toLocaleString() : "—"} loading={isLoading} />
          <KpiCard label="AOV" value={totals ? fmtMoney(totals.aov, currency) : "—"} loading={isLoading} />
          <KpiCard label="Refunds" value={totals ? fmtMoney(totals.refunds, currency) : "—"} loading={isLoading} />
          <KpiCard label="Discounts" value={totals ? fmtMoney(totals.discounts, currency) : "—"} loading={isLoading} />
          <KpiCard label="Customers" value={totals ? totals.uniqueCustomers.toLocaleString() : "—"} loading={isLoading} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Orders</CardTitle>
            <CardDescription>
              {detail?.orders.length ?? 0} orders in selected range
              {detail?.truncated && " (more available — narrow the range to see all)"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border max-h-[480px] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail?.orders.slice(0, 200).map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">{o.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(o.createdAt), "MMM d, HH:mm")}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{o.customerName ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{o.customerEmail ?? ""}</div>
                      </TableCell>
                      <TableCell className="text-xs">{o.financialStatus ?? "—"}</TableCell>
                      <TableCell className="text-right">{o.itemCount}</TableCell>
                      <TableCell className="text-right font-medium">{fmtMoney(o.total, o.currency)}</TableCell>
                    </TableRow>
                  ))}
                  {!isLoading && (!detail || detail.orders.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        No orders for this range
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Customers</CardTitle>
            <CardDescription>
              Top {Math.min(detail?.customers.length ?? 0, 100)} customers by spend
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border max-h-[480px] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">Total Spent</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail?.customers.slice(0, 100).map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-muted-foreground">{c.email ?? "—"}</TableCell>
                      <TableCell className="text-right">{c.ordersCount}</TableCell>
                      <TableCell className="text-right font-medium">{fmtMoney(c.totalSpent, currency)}</TableCell>
                    </TableRow>
                  ))}
                  {!isLoading && (!detail || detail.customers.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                        No customers for this range
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

function KpiCard({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="text-xs">{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold">{loading ? "…" : value}</div>
      </CardContent>
    </Card>
  );
}
