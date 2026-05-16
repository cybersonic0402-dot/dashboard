import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { DashboardShell, RefreshButton } from "@/components/DashboardShell";
import { useDashboardSession } from "@/components/dashboard/useDashboardSession";
import { useInstantDashboardData } from "@/components/dashboard/useInstantDashboardData";
import { getAccountingDashboard, syncXeroAll } from "@/server/dashboard-pages.functions";
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
import { Button } from "@/components/ui/button";
import { LogIn, RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import type { XeroReportStatus } from "@/server/dashboard-pages.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/accounting")({
  head: () => ({
    meta: [{ title: "Accounting Dashboard — Zapply" }],
  }),
  component: AccountingPage,
});

type XData = Awaited<ReturnType<typeof getAccountingDashboard>>;

function fmtMoney(n: number | null | undefined, currency = "EUR") {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${n.toFixed(0)} ${currency}`;
  }
}

function AccountingPage() {
  const { user, loading } = useDashboardSession();
  const fetchDashboard = useCallback(
    (force: boolean) => getAccountingDashboard({ data: { force } }),
    []
  );
  const { data, isLoading, load } = useInstantDashboardData<XData>("accounting", fetchDashboard, !!user);
  const [syncing, setSyncing] = useState(false);
  const [syncReports, setSyncReports] = useState<XeroReportStatus[] | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncOk, setSyncOk] = useState(false);

  const handleSyncAll = useCallback(async () => {
    setSyncing(true);
    setSyncOk(false);
    setSyncError(null);
    setSyncReports(null);
    const t = toast.loading("Syncing all Xero reports…");
    try {
      const res: any = await syncXeroAll();
      setSyncReports(res?.reports ?? null);
      if (res?.ok) {
        setSyncOk(true);
        toast.success("Xero sync complete — all 4 reports updated.", { id: t });
        await load(true);
      } else {
        setSyncError(res?.error ?? "Xero sync failed.");
        const failedLabels = (res?.reports ?? [])
          .filter((r: XeroReportStatus) => !r.ok)
          .map((r: XeroReportStatus) => r.label)
          .join(", ");
        toast.error(
          failedLabels
            ? `Failed: ${failedLabels}. Cache not updated.`
            : res?.error ?? "Xero sync failed.",
          { id: t }
        );
      }
    } catch (err: any) {
      setSyncError(err?.message ?? "Xero sync failed.");
      toast.error(err?.message ?? "Xero sync failed.", { id: t });
    } finally {
      setSyncing(false);
    }
  }, [load]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const x: any = data?.data ?? null;
  const currency = x?.currency ?? "EUR";

  const monthEntries = (obj: Record<string, number> | undefined) =>
    obj ? Object.entries(obj) : [];

  return (
    <DashboardShell
      user={user}
      title="Accounting (Xero)"
      actions={
        <>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="gap-2"
          >
            <a href="/api/auth/xero">
              <LogIn className="w-4 h-4" />
              Connect Xero
            </a>
          </Button>
          <Button
            variant="default"
            size="sm"
            className="gap-2"
            onClick={handleSyncAll}
            disabled={syncing}
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing all Xero data…" : "Sync all Xero data"}
          </Button>
          <RefreshButton onRefresh={() => load(true)} isLoading={isLoading} />
        </>
      }
    >
      <div className="p-6 space-y-6">
        {syncReports && (
          <Card
            className={
              syncOk
                ? "border-emerald-500/40 bg-emerald-500/5"
                : "border-destructive/40 bg-destructive/5"
            }
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {syncOk
                  ? "Xero sync complete"
                  : "Xero sync incomplete — cache not updated"}
              </CardTitle>
              {syncError && !syncOk && (
                <CardDescription>{syncError}</CardDescription>
              )}
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm">
                {syncReports.map((r) => (
                  <li key={r.key} className="space-y-1.5">
                    <div className="flex items-start gap-2">
                      {r.ok ? (
                        <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-500 shrink-0" />
                      ) : (
                        <XCircle className="w-4 h-4 mt-0.5 text-destructive shrink-0" />
                      )}
                      <span className="font-medium">{r.label}:</span>
                      <span className={r.ok ? "text-muted-foreground" : "text-destructive"}>
                        {r.ok ? "OK" : r.reason ?? "failed"}
                      </span>
                    </div>
                    {r.diagnostics && (r.key === "profitAndLoss" || r.key === "balanceSheet") && (
                      <ReportDiagnostics reportKey={r.key} diagnostics={r.diagnostics} />
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}


        {data?.source === "cache" && (
          <Card className="border-yellow-500/40 bg-yellow-500/5">
            <CardContent className="pt-6 text-sm">
              Showing cached Xero data — live API didn't respond.
            </CardContent>
          </Card>
        )}

        {data?.source === "none" && !isLoading && (
          <Card className="border-destructive/40">
            <CardContent className="pt-6 text-sm">
              No Xero data — visit{" "}
              <a className="underline" href="/api/auth/xero">
                /api/auth/xero
              </a>{" "}
              to connect your organization.
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <KpiCard label="YTD Revenue" value={fmtMoney(x?.ytdRevenue, currency)} />
          <KpiCard label="YTD Expenses" value={fmtMoney(x?.ytdExpenses, currency)} />
          <KpiCard label="YTD Net Profit" value={fmtMoney(x?.ytdNetProfit, currency)} />
          <KpiCard label="Cash" value={fmtMoney(x?.cashBalance, currency)} />
          <KpiCard label="A/R" value={fmtMoney(x?.accountsReceivable, currency)} />
          <KpiCard label="Overdue A/R" value={fmtMoney(x?.overdueAmount, currency)} />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <KpiCard label="Bills awaiting" value={fmtMoney(x?.billsAwaitingAmount, currency)} sub={`${x?.billsAwaitingCount ?? 0} bills`} />
          <KpiCard label="Bills overdue" value={fmtMoney(x?.overdueBillsAmount, currency)} sub={`${x?.overdueBillsCount ?? 0} bills`} />
          <KpiCard label="Draft invoices" value={fmtMoney(x?.draftsAmount, currency)} sub={`${x?.draftsCount ?? 0} drafts`} />
          <KpiCard label="Unpaid invoices" value={String(x?.unpaidInvoiceCount ?? 0)} />
          <KpiCard label="Overdue invoices" value={String(x?.overdueInvoiceCount ?? 0)} />
          <KpiCard label="Bank accounts" value={String((x?.bankAccounts ?? []).length)} />
        </div>


        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Balance Sheet</CardTitle>
              <CardDescription>As of today</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableBody>
                  <TableRow>
                    <TableCell>Total Assets</TableCell>
                    <TableCell className="text-right font-medium">{fmtMoney(x?.totalAssets, currency)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Current Assets</TableCell>
                    <TableCell className="text-right">{fmtMoney(x?.currentAssets, currency)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Fixed Assets</TableCell>
                    <TableCell className="text-right">{fmtMoney(x?.fixedAssets, currency)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Total Liabilities</TableCell>
                    <TableCell className="text-right font-medium">{fmtMoney(x?.totalLiabilities, currency)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Current Liabilities</TableCell>
                    <TableCell className="text-right">{fmtMoney(x?.currentLiabilities, currency)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Equity</TableCell>
                    <TableCell className="text-right font-medium">{fmtMoney(x?.equity, currency)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Bank Accounts</CardTitle>
              <CardDescription>Cash positions</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(x?.bankAccounts ?? []).map((b: any) => (
                    <TableRow key={b.name}>
                      <TableCell>{b.name}</TableCell>
                      <TableCell className="text-right font-medium">{fmtMoney(b.balance, b.currency)}</TableCell>
                    </TableRow>
                  ))}
                  {(!x || (x.bankAccounts ?? []).length === 0) && (
                    <TableRow>
                      <TableCell colSpan={2} className="text-center text-muted-foreground py-6">
                        No bank accounts
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>P&L by Month</CardTitle>
            <CardDescription>Last 12 months</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Expenses</TableHead>
                    <TableHead className="text-right">Gross Profit</TableHead>
                    <TableHead className="text-right">Net Profit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthEntries(x?.revenueByMonth).map(([m, rev]) => (
                    <TableRow key={m}>
                      <TableCell className="font-medium">{m}</TableCell>
                      <TableCell className="text-right">{fmtMoney(rev as number, currency)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(x?.expensesByMonth?.[m], currency)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(x?.grossProfitByMonth?.[m], currency)}</TableCell>
                      <TableCell className="text-right font-medium">
                        {fmtMoney(x?.netProfitByMonth?.[m], currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {monthEntries(x?.revenueByMonth).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                        No P&L data
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Customers (top by outstanding A/R) */}
        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Top Customers</CardTitle>
              <CardDescription>By outstanding receivable</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="text-right">Overdue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(x?.customers ?? []).slice(0, 10).map((c: any) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.name}</TableCell>
                        <TableCell className="text-right">{fmtMoney(c.outstanding, currency)}</TableCell>
                        <TableCell className="text-right text-destructive">{fmtMoney(c.overdue, currency)}</TableCell>
                      </TableRow>
                    ))}
                    {(!x || (x.customers ?? []).length === 0) && (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-muted-foreground py-6">
                          No customers
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="text-xs text-muted-foreground mt-2">
                {(x?.customers ?? []).length} customers total
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Top Suppliers</CardTitle>
              <CardDescription>By outstanding payable</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="text-right">Overdue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(x?.suppliers ?? []).slice(0, 10).map((s: any) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        <TableCell className="text-right">{fmtMoney(s.outstanding, currency)}</TableCell>
                        <TableCell className="text-right text-destructive">{fmtMoney(s.overdue, currency)}</TableCell>
                      </TableRow>
                    ))}
                    {(!x || (x.suppliers ?? []).length === 0) && (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-muted-foreground py-6">
                          No suppliers
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="text-xs text-muted-foreground mt-2">
                {(x?.suppliers ?? []).length} suppliers total
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Items / Products */}
        <Card>
          <CardHeader>
            <CardTitle>Items / Products</CardTitle>
            <CardDescription>Catalog from Xero</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Sales price</TableHead>
                    <TableHead className="text-right">Purchase price</TableHead>
                    <TableHead className="text-right">Qty on hand</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(x?.items ?? []).slice(0, 50).map((i: any) => (
                    <TableRow key={i.id}>
                      <TableCell className="font-mono text-xs">{i.code}</TableCell>
                      <TableCell>{i.name}</TableCell>
                      <TableCell className="text-right">{i.salesPrice != null ? fmtMoney(i.salesPrice, currency) : "—"}</TableCell>
                      <TableCell className="text-right">{i.purchasePrice != null ? fmtMoney(i.purchasePrice, currency) : "—"}</TableCell>
                      <TableCell className="text-right">{i.isTracked ? (i.qtyOnHand ?? 0) : "—"}</TableCell>
                    </TableRow>
                  ))}
                  {(!x || (x.items ?? []).length === 0) && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                        No items
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              {(x?.items ?? []).length} items total
            </div>
          </CardContent>
        </Card>

        {/* Bank Transactions */}
        <Card>
          <CardHeader>
            <CardTitle>Bank Transactions</CardTitle>
            <CardDescription>Last 90 days (most recent 100)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(x?.bankTransactions ?? []).map((t: any) => (
                    <TableRow key={t.id}>
                      <TableCell className="font-mono text-xs">{String(t.date ?? "").slice(0, 10)}</TableCell>
                      <TableCell className="text-xs">{t.type}</TableCell>
                      <TableCell>{t.account}</TableCell>
                      <TableCell>{t.contact}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{t.reference}</TableCell>
                      <TableCell className={`text-right font-medium ${t.type?.startsWith("SPEND") ? "text-destructive" : "text-emerald-500"}`}>
                        {fmtMoney(t.total, t.currency || currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(!x || (x.bankTransactions ?? []).length === 0) && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                        No bank transactions
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Manual Journals + Tracking Categories */}
        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Manual Journals</CardTitle>
              <CardDescription>Most recent</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Narration</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(x?.manualJournals ?? []).map((j: any) => (
                      <TableRow key={j.id}>
                        <TableCell className="font-mono text-xs">{String(j.date ?? "").slice(0, 10)}</TableCell>
                        <TableCell className="text-xs">{j.narration}</TableCell>
                        <TableCell className="text-xs">{j.status}</TableCell>
                        <TableCell className="text-right">{fmtMoney(j.total, currency)}</TableCell>
                      </TableRow>
                    ))}
                    {(!x || (x.manualJournals ?? []).length === 0) && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                          No manual journals
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
              <CardTitle>Tracking Categories</CardTitle>
              <CardDescription>Reporting dimensions</CardDescription>
            </CardHeader>
            <CardContent>
              {(x?.trackingCategories ?? []).length === 0 && (
                <div className="text-center text-muted-foreground py-6 text-sm">
                  No tracking categories
                </div>
              )}
              <div className="space-y-4">
                {(x?.trackingCategories ?? []).map((tc: any) => (
                  <div key={tc.id}>
                    <div className="font-medium text-sm mb-1">
                      {tc.name}
                      <span className="ml-2 text-xs text-muted-foreground">({tc.status})</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {tc.options.map((o: any) => (
                        <span key={o.id} className="px-2 py-0.5 rounded bg-muted text-xs">
                          {o.name}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardShell>
  );
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="text-xs">{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function ReportDiagnostics({
  reportKey,
  diagnostics,
}: {
  reportKey: "profitAndLoss" | "balanceSheet";
  diagnostics: any;
}) {
  const [open, setOpen] = useState(false);
  if (!diagnostics) return null;

  return (
    <div className="ml-6 rounded-md border border-border/60 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-muted/40 transition-colors"
      >
        {open ? "▾" : "▸"} Show Xero labels & matches
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3 text-xs">
          {!diagnostics.reportPresent && (
            <div className="text-destructive">Xero did not return this report.</div>
          )}

          {diagnostics.sectionTitles?.length > 0 && (
            <div>
              <div className="font-semibold mb-1">Section titles returned by Xero:</div>
              <div className="flex flex-wrap gap-1">
                {diagnostics.sectionTitles.map((s: string, i: number) => (
                  <span key={i} className="px-1.5 py-0.5 rounded bg-muted text-foreground/80">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {diagnostics.rowLabels?.length > 0 && (
            <div>
              <div className="font-semibold mb-1">
                Row labels found ({diagnostics.rowLabels.length}):
              </div>
              <div className="flex flex-wrap gap-1 max-h-40 overflow-auto">
                {diagnostics.rowLabels.map((s: string, i: number) => (
                  <span key={i} className="px-1.5 py-0.5 rounded bg-muted/60 text-foreground/70">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {reportKey === "profitAndLoss" && (
            <div className="space-y-1">
              <div>
                <span className="font-semibold">Revenue months parsed:</span>{" "}
                {diagnostics.parsedRevenueMonths?.length > 0
                  ? diagnostics.parsedRevenueMonths.join(", ")
                  : <span className="text-destructive">none</span>}
              </div>
              <div>
                <span className="font-semibold">Expense months parsed:</span>{" "}
                {diagnostics.parsedExpenseMonths?.length > 0
                  ? diagnostics.parsedExpenseMonths.join(", ")
                  : <span className="text-destructive">none</span>}
              </div>
              <div>
                <span className="font-semibold">Net profit months parsed:</span>{" "}
                {diagnostics.parsedNetProfitMonths?.length > 0
                  ? diagnostics.parsedNetProfitMonths.join(", ")
                  : <span className="text-destructive">none</span>}
              </div>
            </div>
          )}

          {reportKey === "balanceSheet" && diagnostics.lookups?.length > 0 && (
            <div>
              <div className="font-semibold mb-1">Balance Sheet lookups attempted:</div>
              <table className="w-full text-left">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="pr-2 font-medium">Field</th>
                    <th className="pr-2 font-medium">Type</th>
                    <th className="pr-2 font-medium">Query</th>
                    <th className="pr-2 font-medium">Match</th>
                    <th className="font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnostics.lookups.map((l: any, i: number) => (
                    <tr key={i} className="border-t border-border/40">
                      <td className="pr-2 py-0.5">{l.field}</td>
                      <td className="pr-2 py-0.5 text-muted-foreground">{l.type}</td>
                      <td className="pr-2 py-0.5 font-mono">"{l.query}"</td>
                      <td className={`pr-2 py-0.5 ${l.matched ? "text-emerald-500" : "text-destructive"}`}>
                        {l.matched ? "✓" : "✗"}
                      </td>
                      <td className="py-0.5">{l.value ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
