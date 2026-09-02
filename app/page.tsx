"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  Clock,
  History,
  IndianRupee,
  Inbox,
  Layers,
  ListChecks,
  Loader2,
  Percent,
  PlayCircle,
  Repeat,
  RotateCcw,
  Search,
  TrendingUp,
  Wallet,
  X,
  Zap,
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
import { BarList } from "@/components/bar-list";
import { SiteHeader } from "@/components/site-header";
import { StatusBadge } from "@/components/status-badge";
import { TransactionTrailSheet } from "@/components/transaction-trail-sheet";
import { BATCH_STAGE_LABELS, type BatchStage } from "@/lib/batch-progress";
import { formatINR, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Transaction, TransactionStatus } from "@/lib/types";

interface Summary {
  totalAtRisk: number;
  totalRecovered: number;
  remaining: number;
  recoveryRate: number;
  casesProcessed: number;
}

// Order shown in the "Run Agent" progress stepper - mirrors the pipeline
// run-batch/route.ts actually walks through (see lib/batch-progress.ts).
const PIPELINE_STAGES: BatchStage[] = [
  "scanning",
  "finding_revenue_at_risk",
  "analysing_customer_history",
  "calculating_scores",
  "finding_root_causes",
  "selecting_strategies",
  "executing_actions",
  "monitoring_payments",
  "completed",
];

interface RunSummary {
  transactionsAnalysed: number;
  totalAtRisk: number;
  totalRecovered: number;
  recoveryRate: number;
  recoveryCasesCreated: number;
  actionsExecuted: number;
  humanEscalations: number;
}

function RunStat({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-lg font-semibold text-foreground", valueClassName)}>{value}</p>
    </div>
  );
}

interface PreviousRecordsSummary {
  totalAtRisk: number;
  totalRecovered: number;
  remaining: number;
  recoveryRate: number;
  casesProcessed: number;
  recoveredCount: number;
  unrecoveredCount: number;
  avgAttempts: number;
  avgDelayHours: number | null;
  byChannel: { key: string; label: string; count: number }[];
}

function formatDuration(hours: number | null): string {
  if (hours === null) return "No data yet";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours)}h (~${(hours / 24).toFixed(1)}d)`;
}

// Same "when did money actually arrive" logic as lib/customer-recovery.ts -
// duplicated here (not imported) because that module isn't safe to bundle
// into a client component; see lib/match-quality.ts for the same pattern.
function resolvedAt(transaction: Transaction): string | null {
  const paidAttempt = transaction.attempts.find((a) => a.outcome === "paid");
  return paidAttempt?.respondedAt ?? paidAttempt?.timestamp ?? null;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface FilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  dateFrom: string;
  onDateFromChange: (value: string) => void;
  dateTo: string;
  onDateToChange: (value: string) => void;
  resultCount: number;
  totalCount: number;
}

// Find (search) + a date range filter, shared by both tables. Narrowing
// either one scopes what's "visible" - and, on Current Records, what "Run
// Batch" actually analyses (see currentFilterActive in Home()).
function FilterBar({
  search,
  onSearchChange,
  dateFrom,
  onDateFromChange,
  dateTo,
  onDateToChange,
  resultCount,
  totalCount,
}: FilterBarProps) {
  const hasFilter = search.trim() !== "" || dateFrom !== "" || dateTo !== "";
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative min-w-[220px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Find by customer or ID..."
          className="w-full rounded-md border border-border bg-card py-1.5 pl-8 pr-3 text-sm text-foreground"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => onDateFromChange(e.target.value)}
          aria-label="From date"
          className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => onDateToChange(e.target.value)}
          aria-label="To date"
          className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground"
        />
      </div>
      {hasFilter && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onSearchChange("");
            onDateFromChange("");
            onDateToChange("");
          }}
        >
          <X className="size-3.5" />
          Clear
        </Button>
      )}
      {hasFilter && (
        <span className="text-xs text-muted-foreground">
          Showing {resultCount} of {totalCount}
        </span>
      )}
    </div>
  );
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
    remaining: totalAtRisk - totalRecovered,
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

type SortKey = "id" | "customerName" | "amount" | "type" | "status" | "attempts" | "createdAt";
type PreviousSortKey = "id" | "customerName" | "amount" | "status" | "createdAt" | "recoveredAt" | "attempts";
type SortDirection = "asc" | "desc";

// Groups "needs attention" cases together, then finished-good, then finished-bad.
const STATUS_SORT_RANK: Record<TransactionStatus, number> = {
  pending: 0,
  waiting_for_response: 1,
  awaiting_payment: 2,
  escalated: 3,
  promise_to_pay: 4,
  in_progress: 5,
  recovered: 6,
  unrecovered: 7,
};

interface SortableHeadProps<K extends string> {
  label: string;
  sortKey: K;
  activeKey: K;
  direction: SortDirection;
  onSort: (key: K) => void;
  className?: string;
}

function SortableHead<K extends string>({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  className,
}: SortableHeadProps<K>) {
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
    stage: BatchStage;
  } | null>(null);
  const [lastRunSummary, setLastRunSummary] = useState<RunSummary | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [selectedTransaction, setSelectedTransaction] =
    useState<Transaction | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("id");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [currentSearch, setCurrentSearch] = useState("");
  const [currentDateFrom, setCurrentDateFrom] = useState("");
  const [currentDateTo, setCurrentDateTo] = useState("");

  const [previousTransactions, setPreviousTransactions] = useState<Transaction[] | null>(null);
  const [previousSummary, setPreviousSummary] = useState<PreviousRecordsSummary | null>(null);
  const [previousLoading, setPreviousLoading] = useState(true);
  const [previousError, setPreviousError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"current" | "previous">("current");
  const [previousSortKey, setPreviousSortKey] = useState<PreviousSortKey>("createdAt");
  const [previousSortDirection, setPreviousSortDirection] = useState<SortDirection>("desc");
  const [previousSearch, setPreviousSearch] = useState("");
  const [previousDateFrom, setPreviousDateFrom] = useState("");
  const [previousDateTo, setPreviousDateTo] = useState("");

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

  useEffect(() => {
    async function loadHistory() {
      try {
        const res = await fetch("/api/customer-history");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load previous records.");
        setPreviousTransactions(data.transactions);
        setPreviousSummary(data.summary);
      } catch (err) {
        setPreviousError(err instanceof Error ? err.message : "Failed to load previous records.");
      } finally {
        setPreviousLoading(false);
      }
    }
    loadHistory();
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
          setBatchProgress({ total: data.total, completed: data.completed, stage: data.stage });
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
    // Explicit checkbox selection always wins. Otherwise, if the table is
    // currently narrowed by the find/date filter, the agent only analyses
    // what's actually visible - not the full unfiltered batch.
    const idsToRun =
      selectedIds.size > 0
        ? Array.from(selectedIds)
        : currentFilterActive && sortedTransactions
          ? sortedTransactions.map((t) => t.id)
          : undefined;
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
      setLastRunSummary(data.summary ?? null);
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
    setLastRunSummary(null);
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

  function handlePreviousSort(key: PreviousSortKey) {
    if (key === previousSortKey) {
      setPreviousSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setPreviousSortKey(key);
      setPreviousSortDirection("asc");
    }
  }

  // Selects/deselects only the currently VISIBLE (filtered + sorted) rows,
  // not the whole underlying set - "select all" means all-in-view, matching
  // how the find/date filter scopes what Run Batch analyses.
  function toggleSelectAll(checked: boolean) {
    if (!sortedTransactions) return;
    setSelectedIds(checked ? new Set(sortedTransactions.map((t) => t.id)) : new Set());
  }

  function toggleSelectRow(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const currentFilterActive =
    currentSearch.trim() !== "" || currentDateFrom !== "" || currentDateTo !== "";

  // Plain derived value, not useMemo - the dataset is small (tens of rows),
  // so recomputing on every render costs nothing, and it sidesteps the React
  // Compiler's memoization-preservation check entirely for this one (which
  // it couldn't reconcile once this fed into several other closures below).
  function computeSortedTransactions(): Transaction[] | null {
    if (!transactions) return null;
    const query = currentSearch.trim().toLowerCase();
    const fromTime = currentDateFrom ? new Date(currentDateFrom).getTime() : null;
    const toTime = currentDateTo ? new Date(`${currentDateTo}T23:59:59.999`).getTime() : null;
    const list = transactions.filter((t) => {
      if (query && !`${t.customerName} ${t.id}`.toLowerCase().includes(query)) return false;
      const createdAtTime = new Date(t.createdAt).getTime();
      if (fromTime !== null && createdAtTime < fromTime) return false;
      if (toTime !== null && createdAtTime > toTime) return false;
      return true;
    });
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
        case "createdAt":
          cmp = a.createdAt.localeCompare(b.createdAt);
          break;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return list;
  }
  const sortedTransactions = computeSortedTransactions();

  const sortedPreviousTransactions = useMemo(() => {
    if (!previousTransactions) return null;
    const query = previousSearch.trim().toLowerCase();
    const fromTime = previousDateFrom ? new Date(previousDateFrom).getTime() : null;
    const toTime = previousDateTo ? new Date(`${previousDateTo}T23:59:59.999`).getTime() : null;
    const list = previousTransactions.filter((t) => {
      if (query && !`${t.customerName} ${t.id}`.toLowerCase().includes(query)) return false;
      const createdAtTime = new Date(t.createdAt).getTime();
      if (fromTime !== null && createdAtTime < fromTime) return false;
      if (toTime !== null && createdAtTime > toTime) return false;
      return true;
    });
    list.sort((a, b) => {
      let cmp = 0;
      switch (previousSortKey) {
        case "id":
          cmp = a.id.localeCompare(b.id);
          break;
        case "customerName":
          cmp = a.customerName.localeCompare(b.customerName);
          break;
        case "amount":
          cmp = a.amount - b.amount;
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "createdAt":
          cmp = a.createdAt.localeCompare(b.createdAt);
          break;
        case "recoveredAt":
          cmp = (resolvedAt(a) ?? "").localeCompare(resolvedAt(b) ?? "");
          break;
        case "attempts":
          cmp = a.attempts.length - b.attempts.length;
          break;
      }
      return previousSortDirection === "asc" ? cmp : -cmp;
    });
    return list;
  }, [
    previousTransactions,
    previousSearch,
    previousDateFrom,
    previousDateTo,
    previousSortKey,
    previousSortDirection,
  ]);

  const summary = computeSummary(transactions ?? []);
  const errorCount = Object.keys(runErrors).length;
  const busy = running || resetting || loading;
  const allSelected =
    !!sortedTransactions &&
    sortedTransactions.length > 0 &&
    sortedTransactions.every((t) => selectedIds.has(t.id));
  const someSelected =
    !!sortedTransactions && sortedTransactions.some((t) => selectedIds.has(t.id)) && !allSelected;
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
          {activeTab === "current" && (
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
                ) : currentFilterActive && sortedTransactions ? (
                  <>
                    <PlayCircle />
                    Run Filtered ({sortedTransactions.length})
                  </>
                ) : (
                  <>
                    <PlayCircle />
                    Run Batch
                  </>
                )}
              </Button>
            </div>
          )}
        </div>

        {running && (
          <div className="mb-6 rounded-lg border border-border bg-card px-4 py-4">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium text-foreground">
                {batchProgress ? BATCH_STAGE_LABELS[batchProgress.stage] : "Starting..."}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {batchProgress
                  ? `${batchProgress.completed} of ${batchProgress.total} (${progressPercent}%)`
                  : ""}
              </span>
            </div>
            <Progress value={batchProgress ? progressPercent : 0} className="mb-4" />
            <ol className="flex flex-wrap items-center gap-y-2 text-xs">
              {PIPELINE_STAGES.map((stage, i) => {
                const currentIndex = batchProgress
                  ? PIPELINE_STAGES.indexOf(batchProgress.stage)
                  : -1;
                const state = i < currentIndex ? "done" : i === currentIndex ? "active" : "pending";
                return (
                  <li key={stage} className="flex items-center">
                    {i > 0 && <span className="mx-1.5 text-muted-foreground/40">&rarr;</span>}
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-1 whitespace-nowrap",
                        state === "done" && "bg-success/10 text-success",
                        state === "active" && "bg-brand-blue/10 text-brand-blue",
                        state === "pending" && "text-muted-foreground/50"
                      )}
                    >
                      {state === "done" && <CheckCircle2 className="size-3" />}
                      {state === "active" && <Loader2 className="size-3 animate-spin" />}
                      {BATCH_STAGE_LABELS[stage].replace(/\.\.\.$|\.$/, "")}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {lastRunSummary && !running && (
          <div className="mb-6 rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
              <Zap className="size-4 text-brand-blue" />
              Agent Run Report
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
              <RunStat
                label="Transactions Analysed"
                value={String(lastRunSummary.transactionsAnalysed)}
              />
              <RunStat label="Revenue at Risk" value={formatINR(lastRunSummary.totalAtRisk)} />
              <RunStat
                label="Recovery Cases Created"
                value={String(lastRunSummary.recoveryCasesCreated)}
              />
              <RunStat label="Actions Executed" value={String(lastRunSummary.actionsExecuted)} />
              <RunStat
                label="Human Escalations"
                value={String(lastRunSummary.humanEscalations)}
                valueClassName={lastRunSummary.humanEscalations > 0 ? "text-warning" : undefined}
              />
              <RunStat
                label="Revenue Recovered"
                value={formatINR(lastRunSummary.totalRecovered)}
                valueClassName="text-success"
              />
              <RunStat
                label="Recovery Rate"
                value={`${lastRunSummary.recoveryRate}%`}
                valueClassName="text-brand-blue"
              />
            </div>
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

        <div className="relative mb-8 inline-grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted p-1">
          <span
            aria-hidden="true"
            className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-md bg-card shadow-sm transition-transform duration-200 ease-out"
            style={{ transform: activeTab === "previous" ? "translateX(calc(100% + 4px))" : "translateX(0)" }}
          />
          <button
            type="button"
            onClick={() => setActiveTab("current")}
            className={cn(
              "relative z-10 rounded-md px-5 py-2 text-sm font-medium transition-colors",
              activeTab === "current" ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Current Records
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("previous")}
            className={cn(
              "relative z-10 rounded-md px-5 py-2 text-sm font-medium transition-colors",
              activeTab === "previous" ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Previous Records
          </button>
        </div>

        {activeTab === "current" && (
        <>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-foreground">Current Records</h2>
          <p className="text-sm text-muted-foreground">
            The active batch — transactions the agent is working right now.
          </p>
        </div>

        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
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
            label="Remaining"
            value={formatINR(summary.remaining)}
            valueClassName="text-warning"
            icon={Wallet}
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
            {!loading && transactions && (
              <FilterBar
                search={currentSearch}
                onSearchChange={setCurrentSearch}
                dateFrom={currentDateFrom}
                onDateFromChange={setCurrentDateFrom}
                dateTo={currentDateTo}
                onDateToChange={setCurrentDateTo}
                resultCount={sortedTransactions?.length ?? 0}
                totalCount={transactions.length}
              />
            )}
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
                        aria-label="Select all visible transactions"
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
                      label="Created"
                      sortKey="createdAt"
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
                      <TableCell className="text-muted-foreground whitespace-nowrap">
                        {formatDateTime(t.createdAt)}
                      </TableCell>
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
        </>
        )}

        {activeTab === "previous" && (
        <>
        <div className="mb-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <History className="size-4 text-muted-foreground" />
            Previous Records
          </h2>
          <p className="text-sm text-muted-foreground">
            Historical, already-resolved transactions — the track record the agent
            scores each customer against. Survives Reset Demo Data.
          </p>
        </div>

        {previousError && (
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{previousError}</span>
          </div>
        )}

        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <SummaryCard
            label="Total At Risk"
            value={formatINR(previousSummary?.totalAtRisk ?? 0)}
            valueClassName="text-navy"
            icon={IndianRupee}
            loading={previousLoading}
          />
          <SummaryCard
            label="Total Recovered"
            value={formatINR(previousSummary?.totalRecovered ?? 0)}
            valueClassName="text-success"
            icon={TrendingUp}
            loading={previousLoading}
          />
          <SummaryCard
            label="Remaining"
            value={formatINR(previousSummary?.remaining ?? 0)}
            valueClassName="text-warning"
            icon={Wallet}
            loading={previousLoading}
          />
          <SummaryCard
            label="Recovery Rate"
            value={`${previousSummary?.recoveryRate ?? 0}%`}
            valueClassName="text-brand-blue"
            icon={Percent}
            loading={previousLoading}
          />
          <SummaryCard
            label="Cases Processed"
            value={String(previousSummary?.casesProcessed ?? 0)}
            valueClassName="text-foreground"
            icon={ListChecks}
            loading={previousLoading}
          />
        </div>

        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SummaryCard
            label="Avg Attempts to Resolve"
            value={previousSummary ? previousSummary.avgAttempts.toFixed(1) : "0"}
            valueClassName="text-foreground"
            icon={Repeat}
            loading={previousLoading}
          />
          <SummaryCard
            label="Avg Time to Recover"
            value={formatDuration(previousSummary?.avgDelayHours ?? null)}
            valueClassName="text-foreground"
            icon={Clock}
            loading={previousLoading}
          />
          <SummaryCard
            label="Recovered vs Never Recovered"
            value={
              previousSummary
                ? `${previousSummary.recoveredCount} / ${previousSummary.unrecoveredCount}`
                : "0 / 0"
            }
            valueClassName="text-foreground"
            icon={Layers}
            loading={previousLoading}
          />
        </div>

        <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.4fr]">
          <Card>
            <CardHeader>
              <CardTitle>Recovered via</CardTitle>
            </CardHeader>
            <CardContent>
              {previousLoading ? (
                <TableSkeleton />
              ) : (
                <BarList
                  items={(previousSummary?.byChannel ?? []).map((b) => ({
                    key: b.key,
                    label: b.label,
                    fraction:
                      previousSummary && previousSummary.casesProcessed > 0
                        ? b.count / previousSummary.casesProcessed
                        : 0,
                    valueLabel: `${b.count} case${b.count === 1 ? "" : "s"}`,
                    ...(b.key === "unrecovered" ? { barClassName: "bg-destructive" } : {}),
                  }))}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What this tells the agent</CardTitle>
            </CardHeader>
            <CardContent>
              {previousLoading || !previousSummary ? (
                <TableSkeleton />
              ) : (
                <ul className="flex flex-col gap-2 text-sm text-foreground">
                  <li>
                    • {previousSummary.recoveredCount} of {previousSummary.casesProcessed} past
                    cases ({previousSummary.recoveryRate}%) eventually paid — that base rate is
                    what a customer with no other signal defaults toward.
                  </li>
                  <li>
                    • On average it took {previousSummary.avgAttempts.toFixed(1)} attempt
                    {previousSummary.avgAttempts === 1 ? "" : "s"} and{" "}
                    {formatDuration(previousSummary.avgDelayHours)} to actually collect payment
                    once recovered — attempts that drag on longer than that are a signal to
                    escalate rather than keep waiting.
                  </li>
                  <li>
                    • Most recoveries closed via{" "}
                    {previousSummary.byChannel.slice().sort((a, b) => b.count - a.count)[0]?.label.toLowerCase()},
                    which is why the scoring model weights a customer&apos;s own preferred
                    channel rather than assuming one.
                  </li>
                  <li>
                    • {previousSummary.unrecoveredCount} case
                    {previousSummary.unrecoveredCount === 1 ? "" : "s"} never recovered even
                    after 3 attempts — those customers start future recovery cases with a lower
                    Recovery Score.
                  </li>
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Previous Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            {!previousLoading && previousTransactions && (
              <FilterBar
                search={previousSearch}
                onSearchChange={setPreviousSearch}
                dateFrom={previousDateFrom}
                onDateFromChange={setPreviousDateFrom}
                dateTo={previousDateTo}
                onDateToChange={setPreviousDateTo}
                resultCount={sortedPreviousTransactions?.length ?? 0}
                totalCount={previousTransactions.length}
              />
            )}
            {previousLoading ? (
              <TableSkeleton />
            ) : !sortedPreviousTransactions || sortedPreviousTransactions.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                <Inbox className="size-6" />
                No previous records found.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead
                      label="ID"
                      sortKey="id"
                      activeKey={previousSortKey}
                      direction={previousSortDirection}
                      onSort={handlePreviousSort}
                    />
                    <SortableHead
                      label="Customer"
                      sortKey="customerName"
                      activeKey={previousSortKey}
                      direction={previousSortDirection}
                      onSort={handlePreviousSort}
                    />
                    <SortableHead
                      label="Amount"
                      sortKey="amount"
                      activeKey={previousSortKey}
                      direction={previousSortDirection}
                      onSort={handlePreviousSort}
                    />
                    <SortableHead
                      label="Status"
                      sortKey="status"
                      activeKey={previousSortKey}
                      direction={previousSortDirection}
                      onSort={handlePreviousSort}
                    />
                    <SortableHead
                      label="Failed On"
                      sortKey="createdAt"
                      activeKey={previousSortKey}
                      direction={previousSortDirection}
                      onSort={handlePreviousSort}
                    />
                    <SortableHead
                      label="Recovered On"
                      sortKey="recoveredAt"
                      activeKey={previousSortKey}
                      direction={previousSortDirection}
                      onSort={handlePreviousSort}
                    />
                    <SortableHead
                      label="Attempts"
                      sortKey="attempts"
                      activeKey={previousSortKey}
                      direction={previousSortDirection}
                      onSort={handlePreviousSort}
                      className="text-right"
                    />
                    <TableHead className="text-right">Trail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedPreviousTransactions.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="font-medium">{t.id}</TableCell>
                      <TableCell>{t.customerName}</TableCell>
                      <TableCell>{formatINR(t.amount)}</TableCell>
                      <TableCell>
                        <StatusBadge status={t.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap">
                        {formatDateTime(t.createdAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground whitespace-nowrap">
                        {formatDateTime(resolvedAt(t))}
                      </TableCell>
                      <TableCell className="text-right">{t.attempts.length}</TableCell>
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
        </>
        )}
      </main>

      <TransactionTrailSheet
        transaction={selectedTransaction}
        onOpenChange={(open) => {
          if (!open) setSelectedTransaction(null);
        }}
        onTransactionUpdated={(updated) => {
          setTransactions((prev) =>
            prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev
          );
          setSelectedTransaction(updated);
        }}
      />
    </div>
  );
}
