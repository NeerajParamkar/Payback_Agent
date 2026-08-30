"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  IndianRupee,
  Inbox,
  ListChecks,
  Loader2,
  Percent,
  PlayCircle,
  RotateCcw,
  TrendingUp,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SiteHeader } from "@/components/site-header";
import { StatusBadge } from "@/components/status-badge";
import { TransactionTrailSheet } from "@/components/transaction-trail-sheet";
import { formatINR, humanize } from "@/lib/format";
import type { Transaction, TransactionStatus } from "@/lib/types";

interface Summary {
  totalAtRisk: number;
  totalRecovered: number;
  recoveryRate: number;
  casesProcessed: number;
}

function computeSummary(transactions: Transaction[]): Summary {
  const totalAtRisk = transactions.reduce((sum, t) => sum + t.amount, 0);
  const totalRecovered = transactions
    .filter((t) => t.status === "recovered")
    .reduce((sum, t) => sum + t.amount, 0);
  const recoveryRate = totalAtRisk > 0 ? (totalRecovered / totalAtRisk) * 100 : 0;
  return {
    totalAtRisk,
    totalRecovered,
    recoveryRate: Math.round(recoveryRate * 10) / 10,
    casesProcessed: transactions.length,
  };
}

interface SummaryCardProps {
  label: string;
  value: string;
  valueClassName: string;
  icon: React.ComponentType<{ className?: string }>;
  loading: boolean;
}

function SummaryCard({
  label,
  value,
  valueClassName,
  icon: Icon,
  loading,
}: SummaryCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-4" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <p className={`text-2xl font-semibold ${valueClassName}`}>{value}</p>
        )}
      </CardContent>
    </Card>
  );
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3 py-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

type SortKey = "id" | "customerName" | "amount" | "type" | "status" | "attempts";
type SortDirection = "asc" | "desc";

// Groups "needs attention" cases together, then finished-good, then finished-bad.
const STATUS_SORT_RANK: Record<TransactionStatus, number> = {
  pending: 0,
  waiting_for_response: 1,
  awaiting_payment: 2,
  in_progress: 3,
  recovered: 4,
  unrecovered: 5,
};

interface SortableHeadProps {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
  className?: string;
}

function SortableHead({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  className,
}: SortableHeadProps) {
  const isActive = sortKey === activeKey;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {isActive ? (
          direction === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 text-muted-foreground/50" />
        )}
      </button>
    </TableHead>
  );
}

export default function Home() {
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    total: number;
    completed: number;
  } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [selectedTransaction, setSelectedTransaction] =
    useState<Transaction | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("id");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  useEffect(() => {
    async function loadTransactions() {
      try {
        const res = await fetch("/api/transactions");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load transactions.");
        setTransactions(data.transactions);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load transactions.");
      } finally {
        setLoading(false);
      }
    }
    loadTransactions();
  }, []);

  // Poll batch progress while a run is in flight. Progress display is gated
  // behind `running`, so there's nothing to reset when a run ends - just stop
  // polling.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/run-batch/progress");
        const data = await res.json();
        if (!cancelled) {
          setBatchProgress({ total: data.total, completed: data.completed });
        }
      } catch {
        // polling failure isn't critical - just skip this tick
      }
    }, 600);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [running]);

  async function handleRunBatch() {
    setRunning(true);
    setBatchProgress(null);
    setError(null);
    setRunErrors({});
    const idsToRun = selectedIds.size > 0 ? Array.from(selectedIds) : undefined;
    try {
      const res = await fetch("/api/run-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(idsToRun ? { transactionIds: idsToRun } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Batch run failed.");
      setTransactions(data.transactions);
      setRunErrors(data.errors ?? {});
      setSelectedIds(new Set());
      setSelectedTransaction((prev) =>
        prev
          ? (data.transactions.find((t: Transaction) => t.id === prev.id) ?? null)
          : null
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Batch run failed.");
    } finally {
      setRunning(false);
    }
  }

  async function handleReset() {
    setResetDialogOpen(false);
    setResetting(true);
    setError(null);
    setRunErrors({});
    setSelectedTransaction(null);
    setSelectedIds(new Set());
    try {
      const res = await fetch("/api/reset", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Reset failed.");
      setTransactions(data.transactions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed.");
    } finally {
      setResetting(false);
    }
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  }

  function toggleSelectAll(checked: boolean) {
    if (!transactions) return;
    setSelectedIds(checked ? new Set(transactions.map((t) => t.id)) : new Set());
  }

  function toggleSelectRow(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const sortedTransactions = useMemo(() => {
    if (!transactions) return null;
    const list = [...transactions];
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "id":
          cmp = a.id.localeCompare(b.id);
          break;
        case "customerName":
          cmp = a.customerName.localeCompare(b.customerName);
          break;
        case "amount":
          cmp = a.amount - b.amount;
          break;
        case "type":
          cmp = a.type.localeCompare(b.type);
          break;
        case "status":
          cmp = STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status];
          break;
        case "attempts":
          cmp = a.attempts.length - b.attempts.length;
          break;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return list;
  }, [transactions, sortKey, sortDirection]);

  const summary = computeSummary(transactions ?? []);
  const errorCount = Object.keys(runErrors).length;
  const busy = running || resetting || loading;
  const allSelected =
    !!transactions && transactions.length > 0 && selectedIds.size === transactions.length;
  const someSelected = selectedIds.size > 0 && !allSelected;
  const progressPercent = batchProgress
    ? Math.round((batchProgress.completed / Math.max(batchProgress.total, 1)) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              AI-driven detection, diagnosis, and recovery of at-risk revenue.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
              <AlertDialogTrigger
                render={<Button variant="outline" size="sm" disabled={busy} />}
              >
                {resetting ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Resetting...
                  </>
                ) : (
                  <>
                    <RotateCcw />
                    Reset Demo Data
                  </>
                )}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset demo data?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will erase all recovery progress and reset every
                    transaction to pending. Continue?
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleReset}>Reset</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button onClick={handleRunBatch} disabled={busy}>
              {running ? (
                <>
                  <Loader2 className="animate-spin" />
                  Running...{" "}
                  {batchProgress
                    ? `${batchProgress.completed}/${batchProgress.total}`
                    : ""}
                </>
              ) : selectedIds.size > 0 ? (
                <>
                  <PlayCircle />
                  Run Selected ({selectedIds.size})
                </>
              ) : (
                <>
                  <PlayCircle />
                  Run Batch
                </>
              )}
            </Button>
          </div>
        </div>

        {running && (
          <div className="mb-6 rounded-lg border border-border bg-card px-4 py-3">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-foreground">Processing transactions...</span>
              <span className="tabular-nums text-muted-foreground">
                {batchProgress
                  ? `${batchProgress.completed} of ${batchProgress.total} (${progressPercent}%)`
                  : "Starting..."}
              </span>
            </div>
            <Progress value={batchProgress ? progressPercent : 0} />
          </div>
        )}

        {error && (
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {errorCount > 0 && (
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {errorCount} transaction{errorCount === 1 ? "" : "s"} hit an error
              during the last run and were left unresolved.
            </span>
          </div>
        )}

        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard
            label="Total At Risk"
            value={formatINR(summary.totalAtRisk)}
            valueClassName="text-navy"
            icon={IndianRupee}
            loading={loading}
          />
          <SummaryCard
            label="Total Recovered"
            value={formatINR(summary.totalRecovered)}
            valueClassName="text-success"
            icon={TrendingUp}
            loading={loading}
          />
          <SummaryCard
            label="Recovery Rate"
            value={`${summary.recoveryRate}%`}
            valueClassName="text-brand-blue"
            icon={Percent}
            loading={loading}
          />
          <SummaryCard
            label="Cases Processed"
            value={String(summary.casesProcessed)}
            valueClassName="text-foreground"
            icon={ListChecks}
            loading={loading}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Transactions
              {selectedIds.size > 0 && (
                <span className="text-xs font-normal text-muted-foreground">
                  {selectedIds.size} selected
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton />
            ) : !sortedTransactions || sortedTransactions.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                <Inbox className="size-6" />
                No transactions found.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox
                        checked={allSelected}
                        indeterminate={someSelected}
                        onCheckedChange={(checked) => toggleSelectAll(!!checked)}
                        disabled={busy}
                        aria-label="Select all transactions"
                      />
                    </TableHead>
                    <SortableHead
                      label="ID"
                      sortKey="id"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={handleSort}
                    />
                    <SortableHead
                      label="Customer"
                      sortKey="customerName"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={handleSort}
                    />
                    <SortableHead
                      label="Amount"
                      sortKey="amount"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={handleSort}
                    />
                    <SortableHead
                      label="Type"
                      sortKey="type"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={handleSort}
                    />
                    <SortableHead
                      label="Status"
                      sortKey="status"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={handleSort}
                    />
                    <SortableHead
                      label="Attempts"
                      sortKey="attempts"
                      activeKey={sortKey}
                      direction={sortDirection}
                      onSort={handleSort}
                      className="text-right"
                    />
                    <TableHead className="text-right">Trail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedTransactions.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(t.id)}
                          onCheckedChange={(checked) =>
                            toggleSelectRow(t.id, !!checked)
                          }
                          disabled={busy}
                          aria-label={`Select ${t.id}`}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{t.id}</TableCell>
                      <TableCell>{t.customerName}</TableCell>
                      <TableCell>{formatINR(t.amount)}</TableCell>
                      <TableCell>{humanize(t.type)}</TableCell>
                      <TableCell>
                        <StatusBadge status={t.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        {t.attempts.length}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedTransaction(t)}
                        >
                          View Trail
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>

      <TransactionTrailSheet
        transaction={selectedTransaction}
        onOpenChange={(open) => {
          if (!open) setSelectedTransaction(null);
        }}
      />
    </div>
  );
}
