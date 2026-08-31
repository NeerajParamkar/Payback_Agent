"use client";

import { use, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Clock,
  IndianRupee,
  Inbox,
  ListChecks,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { CustomerRecoveryProfile, Transaction } from "@/lib/types";

interface RiskLevel {
  label: string;
  badgeClassName: string;
}

function riskLevel(score: number): RiskLevel {
  if (score >= 70) return { label: "Low risk", badgeClassName: "border-success/30 bg-success/15 text-success" };
  if (score >= 40) return { label: "Medium risk", badgeClassName: "border-warning/30 bg-warning/15 text-warning" };
  return { label: "High risk", badgeClassName: "border-destructive/30 bg-destructive/15 text-destructive" };
}

interface StatTileProps {
  label: string;
  value: string;
  valueClassName?: string;
  icon: React.ComponentType<{ className?: string }>;
}

function StatTile({ label, value, valueClassName, icon: Icon }: StatTileProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-4" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-semibold ${valueClassName ?? "text-foreground"}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

// When a transaction actually resolved as paid - the attempt the agent (or an
// admin action) recorded with outcome "paid" is the single source of truth
// for this across every path that can mark an order recovered.
function resolvedAt(transaction: Transaction): string | null {
  const paidAttempt = transaction.attempts.find((a) => a.outcome === "paid");
  return paidAttempt?.respondedAt ?? paidAttempt?.timestamp ?? null;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = use(params);

  const [customer, setCustomer] = useState<CustomerRecoveryProfile | null>(null);
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/customers/${customerId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load customer.");
        if (!cancelled) {
          setCustomer(data.customer);
          setTransactions(data.transactions);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load customer.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <Link
          href="/customers"
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to Customers
        </Link>

        {loading ? (
          <div className="flex flex-col gap-6">
            <Skeleton className="h-10 w-64" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          </div>
        ) : error || !customer ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error ?? "Customer not found."}</span>
          </div>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-semibold text-foreground">{customer.customerName}</h1>
                  <Badge variant="outline" className={riskLevel(customer.recoveryScore).badgeClassName}>
                    {riskLevel(customer.recoveryScore).label} &middot; Score {customer.recoveryScore}
                  </Badge>
                </div>
                {customer.customerEmail && (
                  <p className="text-sm text-muted-foreground">{customer.customerEmail}</p>
                )}
              </div>
            </div>

            <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Transactions"
                value={`${customer.successfulTransactions}/${customer.totalTransactions}`}
                icon={ListChecks}
              />
              <StatTile
                label="Amount Recovered"
                value={formatINR(customer.amountRecovered)}
                valueClassName="text-success"
                icon={TrendingUp}
              />
              <StatTile
                label="Amount At Risk"
                value={formatINR(customer.amountAtRisk)}
                valueClassName="text-navy"
                icon={IndianRupee}
              />
              <StatTile
                label="Avg Payment Delay"
                value={
                  customer.averagePaymentDelayHours !== null
                    ? `${Math.round(customer.averagePaymentDelayHours)}h`
                    : "No data yet"
                }
                icon={Clock}
              />
            </div>

            <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.4fr]">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ShieldAlert className="size-4 text-brand-blue" />
                    Recovery Score breakdown ({customer.recoveryScore}/100)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Weighted rule-based model — each factor is normalized 0–1 (1 = ideal),
                    multiplied by its weight, and summed. A factor with no history yet
                    defaults to a neutral 0.5 rather than penalizing the customer.
                  </p>
                  <div className="flex flex-col gap-2">
                    {customer.scoreBreakdown.map((factor) => (
                      <div key={factor.key} className="rounded-md border border-border bg-muted/40 px-3 py-2">
                        <div className="mb-1 flex items-center justify-between text-sm">
                          <span className="text-foreground">{factor.label}</span>
                          <span className="font-medium text-foreground">
                            {factor.contribution.toFixed(1)} pts
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                          <div
                            className="h-full rounded-full bg-brand-blue"
                            style={{ width: `${Math.round(factor.value * 100)}%` }}
                          />
                        </div>
                        <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                          <span>
                            value {Math.round(factor.value * 100)}% &middot; weight{" "}
                            {Math.round(factor.weight * 100)}%
                          </span>
                          {!factor.hasData && <span>no history — neutral default</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Recovery history</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">Previous recovery attempts</dt>
                    <dd className="text-right text-foreground">{customer.previousRecoveryAttempts}</dd>
                    <dt className="text-muted-foreground">Successful recovery actions</dt>
                    <dd className="text-right text-success">{customer.successfulRecoveryActions}</dd>
                    <dt className="text-muted-foreground">Failed recovery actions</dt>
                    <dd className="text-right text-destructive">{customer.failedRecoveryActions}</dd>
                    <dt className="text-muted-foreground">Preferred channel</dt>
                    <dd className="text-right text-foreground">
                      {customer.preferredRecoveryChannel
                        ? humanize(customer.preferredRecoveryChannel)
                        : "No data yet"}
                    </dd>
                    <dt className="text-muted-foreground">Successful transactions</dt>
                    <dd className="text-right text-foreground">{customer.successfulTransactions}</dd>
                    <dt className="text-muted-foreground">Failed transactions</dt>
                    <dd className="text-right text-foreground">{customer.failedTransactions}</dd>
                  </dl>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Transaction history</CardTitle>
              </CardHeader>
              <CardContent>
                {!transactions || transactions.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                    <Inbox className="size-6" />
                    No transactions found.
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>ID</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Failed On</TableHead>
                        <TableHead>Recovered On</TableHead>
                        <TableHead className="text-right">Attempts</TableHead>
                        <TableHead className="text-right">Trail</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {transactions.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell className="font-medium">{t.id}</TableCell>
                          <TableCell>{humanize(t.type)}</TableCell>
                          <TableCell className="text-right">{formatINR(t.amount)}</TableCell>
                          <TableCell>
                            <StatusBadge status={t.status} />
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatDate(t.createdAt)}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatDate(resolvedAt(t))}
                          </TableCell>
                          <TableCell className="text-right">{t.attempts.length}</TableCell>
                          <TableCell className="text-right">
                            <button
                              type="button"
                              onClick={() => setSelectedTransaction(t)}
                              className="text-sm font-medium text-brand-blue underline underline-offset-2"
                            >
                              View
                            </button>
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
