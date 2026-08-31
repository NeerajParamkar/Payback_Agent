"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Inbox, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { formatINR, humanize } from "@/lib/format";
import type { EscalationQueueEntry, RecoveryAttempt, Transaction } from "@/lib/types";

interface EscalationRow {
  entry: EscalationQueueEntry;
  transaction: Transaction;
}

function useEscalations() {
  const [rows, setRows] = useState<EscalationRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/escalations");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load the escalation queue.");
        if (!cancelled) setRows(data.rows);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load the escalation queue.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return { rows, loading, error, reload: () => setReloadKey((k) => k + 1) };
}

function queueStatusBadgeClassName(status: EscalationQueueEntry["status"]): string {
  if (status === "resolved") return "border-success/30 bg-success/15 text-success";
  if (status === "owned") return "border-brand-blue/30 bg-brand-blue/15 text-brand-blue";
  return "border-warning/30 bg-warning/15 text-warning";
}

function scoreBadgeClassName(score: number): string {
  if (score >= 70) return "border-success/30 bg-success/15 text-success";
  if (score >= 40) return "border-warning/30 bg-warning/15 text-warning";
  return "border-destructive/30 bg-destructive/15 text-destructive";
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3 py-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

const ACTIONS: Array<{
  key: "resolve" | "stop_recovery" | "mark_recovered" | "record_offline_payment" | "send_payment_link" | "take_ownership";
  label: string;
  variant: "default" | "outline" | "destructive";
  needsNote?: boolean;
}> = [
  { key: "take_ownership", label: "Take Ownership", variant: "outline" },
  { key: "send_payment_link", label: "Send Payment Link", variant: "outline" },
  { key: "record_offline_payment", label: "Record Offline Payment", variant: "outline", needsNote: true },
  { key: "mark_recovered", label: "Mark Payment Recovered", variant: "default", needsNote: true },
  { key: "resolve", label: "Resolve Case", variant: "outline", needsNote: true },
  { key: "stop_recovery", label: "Stop Recovery", variant: "destructive", needsNote: true },
];

export default function EscalationsPage() {
  const { rows, loading, error, reload } = useEscalations();
  const [selected, setSelected] = useState<EscalationRow | null>(null);
  const [adminName, setAdminName] = useState("Admin");
  const [note, setNote] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function runAction(actionKey: string) {
    if (!selected) return;
    setBusyAction(actionKey);
    setActionError(null);
    try {
      const res = await fetch(`/api/escalations/${selected.entry.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionKey, adminName, note: note || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message ?? data.error ?? "Action failed.");
      setNote("");
      await reload();
      setSelected(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusyAction(null);
    }
  }

  const openCount = rows?.filter((r) => r.entry.status !== "resolved").length ?? 0;

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-foreground">Human Escalation Queue</h1>
          <p className="text-sm text-muted-foreground">
            Cases automation has handed off — {openCount} open right now.
          </p>
        </div>

        {error && (
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Queue</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton />
            ) : !rows || rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                <Inbox className="size-6" />
                No escalations. Automation is handling everything on its own.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Order</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Root Cause</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead>Reasons</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows
                    .slice()
                    .sort((a, b) => {
                      const rank = { open: 0, owned: 1, resolved: 2 };
                      return rank[a.entry.status] - rank[b.entry.status] || b.entry.amount - a.entry.amount;
                    })
                    .map(({ entry, transaction }) => (
                      <TableRow
                        key={entry.id}
                        className="cursor-pointer"
                        onClick={() => {
                          setSelected({ entry, transaction });
                          setActionError(null);
                          setNote("");
                        }}
                      >
                        <TableCell>
                          <div className="font-medium text-foreground">{entry.customerName}</div>
                          {entry.customerEmail && (
                            <div className="text-xs text-muted-foreground">{entry.customerEmail}</div>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{entry.transactionId}</TableCell>
                        <TableCell className="text-right">{formatINR(entry.amount)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {entry.rootCause ? humanize(entry.rootCause) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant="outline" className={scoreBadgeClassName(entry.recoveryScore)}>
                            {entry.recoveryScore}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {entry.reasons.length === 0 ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : (
                              entry.reasons.map((r) => (
                                <Badge
                                  key={r}
                                  variant="outline"
                                  className="border-border bg-muted text-muted-foreground"
                                >
                                  {humanize(r)}
                                </Badge>
                              ))
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={queueStatusBadgeClassName(entry.status)}>
                            {humanize(entry.status)}
                            {entry.ownedBy && entry.status === "owned" ? ` · ${entry.ownedBy}` : ""}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2 text-base">
                  {selected.entry.customerName}
                  <Badge variant="outline" className={queueStatusBadgeClassName(selected.entry.status)}>
                    {humanize(selected.entry.status)}
                  </Badge>
                </SheetTitle>
                <SheetDescription>
                  {selected.entry.transactionId} &middot; {formatINR(selected.entry.amount)}
                </SheetDescription>
              </SheetHeader>

              <div className="flex flex-col gap-4 px-4 pb-4">
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Root cause</dt>
                  <dd className="text-right text-foreground">
                    {selected.entry.rootCause ? humanize(selected.entry.rootCause) : "Unknown"}
                  </dd>
                  <dt className="text-muted-foreground">Recovery score</dt>
                  <dd className="text-right text-foreground">{selected.entry.recoveryScore}/100</dd>
                  <dt className="text-muted-foreground">Recovery probability</dt>
                  <dd className="text-right text-foreground">
                    {Math.round(selected.entry.recoveryProbability * 100)}%
                  </dd>
                  <dt className="text-muted-foreground">Attempts made</dt>
                  <dd className="text-right text-foreground">{selected.transaction.attempts.length}</dd>
                  {selected.entry.ownedBy && (
                    <>
                      <dt className="text-muted-foreground">Owned by</dt>
                      <dd className="text-right text-foreground">{selected.entry.ownedBy}</dd>
                    </>
                  )}
                </dl>

                <div>
                  <p className="mb-2 text-sm font-semibold text-navy">Reason for escalation</p>
                  <div className="flex flex-wrap gap-1">
                    {selected.entry.reasons.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        Not tagged to a specific reason — see the timeline below.
                      </span>
                    ) : (
                      selected.entry.reasons.map((r) => (
                        <Badge key={r} variant="outline" className="border-destructive/30 bg-destructive/15 text-destructive">
                          {humanize(r)}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>

                {selected.entry.resolution && (
                  <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2">
                    <p className="mb-1 text-xs font-medium text-success">
                      Resolved — {humanize(selected.entry.resolution.action)} by{" "}
                      {selected.entry.resolution.resolvedBy}
                    </p>
                    {selected.entry.resolution.note && (
                      <p className="text-sm text-foreground">{selected.entry.resolution.note}</p>
                    )}
                  </div>
                )}

                <div>
                  <p className="mb-2 text-sm font-semibold text-navy">
                    Complete recovery timeline ({selected.transaction.attempts.length})
                  </p>
                  <div className="flex flex-col gap-2">
                    {selected.transaction.attempts.map((a: RecoveryAttempt) => (
                      <div key={a.attemptNumber} className="rounded-md border border-border bg-muted/30 px-3 py-2">
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="font-medium text-foreground">
                            #{a.attemptNumber} · {humanize(a.decisionAction)}
                          </span>
                          <span className="text-muted-foreground">
                            {new Date(a.timestamp).toLocaleString("en-IN")}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Diagnosed: {humanize(a.diagnosedReason)} &middot; Outcome: {humanize(a.outcome)}
                        </p>
                        <p className="mt-1 flex items-start gap-1 text-sm text-foreground">
                          <MessageSquare className="mt-0.5 size-3 shrink-0" />
                          {a.actionDetail}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {selected.entry.status !== "resolved" && (
                  <div className="border-t border-border pt-4">
                    <p className="mb-2 text-sm font-semibold text-navy">Take action</p>
                    <div className="mb-3 flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        value={adminName}
                        onChange={(e) => setAdminName(e.target.value)}
                        placeholder="Your name"
                        className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground sm:w-40"
                      />
                      <input
                        type="text"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Optional note"
                        className="flex-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground"
                      />
                    </div>

                    {actionError && (
                      <p className="mb-2 text-xs text-destructive">{actionError}</p>
                    )}

                    <div className="flex flex-wrap gap-2">
                      {ACTIONS.map(({ key, label, variant }) => (
                        <Button
                          key={key}
                          size="sm"
                          variant={variant}
                          disabled={busyAction !== null}
                          onClick={() => runAction(key)}
                        >
                          {busyAction === key ? "Working..." : label}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
