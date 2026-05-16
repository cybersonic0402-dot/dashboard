import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import type { DateRange } from "react-day-picker";
import { format } from "date-fns";
import { DashboardShell, RefreshButton } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { useInstantDashboardData } from "@/components/dashboard/useInstantDashboardData";
import { DateRangePicker, defaultRange, toIsoDate } from "@/components/dashboard/Filters";
import { getInvoiceDashboard } from "@/server/dashboard-pages.functions";
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

export const Route = createFileRoute("/invoices")({
  head: () => ({
    meta: [{ title: "Invoices Dashboard — Zapply" }],
  }),
  component: InvoicesPage,
});

type InvData = Awaited<ReturnType<typeof getInvoiceDashboard>>;

function fmtMoney(n: number | null | undefined, currency = "EUR") {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${n.toFixed(0)} ${currency}`;
  }
}

function InvoicesPage() {
  const { user, loading } = useDashboardSession();
  const [range, setRange] = useState<DateRange>(defaultRange());
  const from = toIsoDate(range.from);
  const to = toIsoDate(range.to);
  const fetchDashboard = useCallback(
    (force: boolean) => getInvoiceDashboard({ data: { from, to, force } }),
    [from, to]
  );
  const { data, isLoading, load } = useInstantDashboardData<InvData>(
    `invoices.${from}.${to}`,
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
  const totals = result?.totals ?? {};
  const invoices: any[] = result?.invoices ?? [];
  const unpaid: any[] = result?.unpaid ?? [];
  const diag: any = result?.diagnostics ?? null;

  return (
    <DashboardShell
      user={user}
      title="Invoices (Jortt)"
      actions={
        <>
          <DateRangePicker value={range} onChange={setRange} />
          <RefreshButton onRefresh={() => load(true)} isLoading={isLoading} />
        </>
      }
    >
      <div className="p-6 space-y-6">
        {result?.error && (
          <Card className="border-destructive/40">
            <CardContent className="pt-6 text-sm text-destructive">{result.error}</CardContent>
          </Card>
        )}

        {!isLoading && diag && invoices.length === 0 && (diag.totalSentFetched + diag.totalPaidFetched) > 0 && (
          <Card className="border-yellow-500/40 bg-yellow-500/5">
            <CardContent className="pt-6 text-sm">
              No invoices in selected range ({diag.dateRange.from} → {diag.dateRange.to}).
              Found {diag.totalSentFetched + diag.totalPaidFetched} invoices in Jortt overall —
              try widening the date range.
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard label="Revenue (sent)" value={fmtMoney(totals.revenue)} />
          <KpiCard label="Invoices" value={(totals.invoiceCount ?? 0).toLocaleString()} />
          <KpiCard label="Accounts receivable" value={fmtMoney(totals.accountsReceivable)} />
          <KpiCard
            label="Overdue"
            value={`${(totals.overdueCount ?? 0).toLocaleString()} · ${fmtMoney(totals.overdueAmount)}`}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Invoices in range</CardTitle>
            <CardDescription>{invoices.length} invoices</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border max-h-[480px] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.slice(0, 200).map((i) => (
                    <TableRow key={i.id || i.number}>
                      <TableCell className="font-medium">{i.number}</TableCell>
                      <TableCell>{i.customer}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {i.invoiceDate ? format(new Date(i.invoiceDate), "MMM d, yyyy") : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {i.dueDate ? format(new Date(i.dueDate), "MMM d, yyyy") : "—"}
                      </TableCell>
                      <TableCell className="text-xs">{i.status}</TableCell>
                      <TableCell className="text-right font-medium">{fmtMoney(i.total, i.currency)}</TableCell>
                    </TableRow>
                  ))}
                  {!isLoading && invoices.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        No invoices in this range
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
            <CardTitle>Unpaid invoices</CardTitle>
            <CardDescription>{unpaid.length} outstanding</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border max-h-[400px] overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unpaid.slice(0, 200).map((i) => (
                    <TableRow key={i.id || i.number}>
                      <TableCell className="font-medium">{i.number}</TableCell>
                      <TableCell>{i.customer}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {i.dueDate ? format(new Date(i.dueDate), "MMM d, yyyy") : "—"}
                      </TableCell>
                      <TableCell className="text-right font-medium">{fmtMoney(i.due, i.currency)}</TableCell>
                    </TableRow>
                  ))}
                  {!isLoading && unpaid.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                        Nothing outstanding
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
