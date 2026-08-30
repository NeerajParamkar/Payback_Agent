"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Inbox, Target, TrendingUp } from "lucide-react";
import { BarList } from "@/components/bar-list";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { isWellMatched } from "@/lib/match-quality";
import { humanize } from "@/lib/format";
import type { RecoveryAction, Transaction } from "@/lib/types";

function useTransactions() {
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
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
    load();
  }, []);

  return { transactions, loading, error };
}

function formatPercent(n: number): string {
  return `${Math.round(n * 100)}%`;
}

interface RateBucket {
  key: string;
  attempts: number;
  paid: number;
}

function toRateBarItems(buckets: Map<string, RateBucket>) {
  return Array.from(buckets.values())
    .filter((b) => b.attempts > 0)
    .map((b) => ({
      key: b.key,
      label: humanize(b.key),
      fraction: b.paid / b.attempts,
      valueLabel: `${formatPercent(b.paid / b.attempts)} (${b.paid}/${b.attempts})`,
    }))
    .sort((a, b) => b.fraction - a.fraction);
}

export default function InsightsPage() {
  const { transactions, loading, error } = useTransactions();

  const hasAttempts = useMemo(
    () => !!transactions && transactions.some((t) => t.attempts.length > 0),
    [transactions]
  );

  const reasonItems = useMemo(() => {
    if (!transactions) return [];
    const buckets = new Map<string, RateBucket>();
    for (const t of transactions) {
      for (const a of t.attempts) {
        const b = buckets.get(a.diagnosedReason) ?? {
          key: a.diagnosedReason,
          attempts: 0,
          paid: 0,
        };
        b.attempts += 1;
        if (a.outcome === "paid") b.paid += 1;
        buckets.set(a.diagnosedReason, b);
      }
    }
    return toRateBarItems(buckets);
  }, [transactions]);

  const actionItems = useMemo(() => {
    if (!transactions) return [];
    const buckets = new Map<string, RateBucket>();
    for (const t of transactions) {
      for (const a of t.attempts) {
        const b = buckets.get(a.recommendedAction) ?? {
          key: a.recommendedAction,
          attempts: 0,
          paid: 0,
        };
        b.attempts += 1;
        if (a.outcome === "paid") b.paid += 1;
        buckets.set(a.recommendedAction, b);
      }
    }
    return toRateBarItems(buckets);
  }, [transactions]);

  const typeItems = useMemo(() => {
    if (!transactions) return [];
    const buckets = new Map<string, { total: number; recovered: number }>();
    for (const t of transactions) {
      const b = buckets.get(t.type) ?? { total: 0, recovered: 0 };
      b.total += 1;
      if (t.status === "recovered") b.recovered += 1;
      buckets.set(t.type, b);
    }
    return Array.from(buckets.entries())
      .map(([type, b]) => ({
        key: type,
        label: humanize(type),
        fraction: b.total ? b.recovered / b.total : 0,
        valueLabel: `${formatPercent(b.total ? b.recovered / b.total : 0)} (${b.recovered}/${b.total})`,
      }))
      .sort((a, b) => b.fraction - a.fraction);
  }, [transactions]);

  const matchStats = useMemo(() => {
    const matched: RateBucket = { key: "matched", attempts: 0, paid: 0 };
    const mismatched: RateBucket = { key: "mismatched", attempts: 0, paid: 0 };
    if (!transactions) return { matched, mismatched };
    for (const t of transactions) {
      for (const a of t.attempts) {
        const bucket = isWellMatched(
          t.trueFailureReason,
          a.recommendedAction as RecoveryAction
        )
          ? matched
          : mismatched;
        bucket.attempts += 1;
        if (a.outcome === "paid") bucket.paid += 1;
      }
    }
    return { matched, mismatched };
  }, [transactions]);

  const attemptStats = useMemo(() => {
    const recoveredByAttempt = [0, 0, 0];
    let unrecovered = 0;
    let stillActive = 0;
    if (!transactions) return { recoveredByAttempt, unrecovered, stillActive };
    for (const t of transactions) {
      if (t.status === "recovered") {
        const paidAttempt = t.attempts.find((a) => a.outcome === "paid");
        const idx = (paidAttempt?.attemptNumber ?? 1) - 1;
        if (idx >= 0 && idx < 3) recoveredByAttempt[idx] += 1;
      } else if (t.status === "unrecovered") {
        unrecovered += 1;
      } else {
        stillActive += 1;
      }
    }
    return { recoveredByAttempt, unrecovered, stillActive };
  }, [transactions]);

  const maxAttemptBucket = Math.max(
    ...attemptStats.recoveredByAttempt,
    attemptStats.unrecovered,
    attemptStats.stillActive,
    1
  );

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-foreground">Insights</h1>
          <p className="text-sm text-muted-foreground">
            Aggregate patterns across every processed transaction — validates
            whether better AI diagnosis actually produces better recovery.
          </p>
        </div>

        {error && (
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardHeader>
                  <Skeleton className="h-5 w-40" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-32 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : !hasAttempts ? (
          <Card>
            <CardContent>
              <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                <Inbox className="size-6" />
                No recovery attempts yet — run the batch on the Dashboard first,
                then come back here to see the patterns.
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Recovery rate by diagnosed reason</CardTitle>
                <CardDescription>
                  Share of attempts that ended in payment, grouped by what the
                  AI diagnosed as the failure reason.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <BarList items={reasonItems} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recovery rate by recommended action</CardTitle>
                <CardDescription>
                  Which recovery actions actually convert most often.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <BarList items={actionItems} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recovery rate by transaction type</CardTitle>
                <CardDescription>
                  Share of each transaction type currently marked recovered.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <BarList items={typeItems} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Target className="size-4 text-brand-blue" />
                  Well-matched vs. mismatched actions
                </CardTitle>
                <CardDescription>
                  Validates the recovery model: a well-matched action (the
                  right fix for the true failure reason) should convert far
                  more often than a generic/mismatched one.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <BarList
                  items={[
                    {
                      key: "matched",
                      label: "Well-matched",
                      fraction:
                        matchStats.matched.attempts > 0
                          ? matchStats.matched.paid / matchStats.matched.attempts
                          : 0,
                      valueLabel:
                        matchStats.matched.attempts > 0
                          ? `${formatPercent(matchStats.matched.paid / matchStats.matched.attempts)} (${matchStats.matched.paid}/${matchStats.matched.attempts})`
                          : "No data",
                      barClassName: "bg-success",
                    },
                    {
                      key: "mismatched",
                      label: "Mismatched",
                      fraction:
                        matchStats.mismatched.attempts > 0
                          ? matchStats.mismatched.paid / matchStats.mismatched.attempts
                          : 0,
                      valueLabel:
                        matchStats.mismatched.attempts > 0
                          ? `${formatPercent(matchStats.mismatched.paid / matchStats.mismatched.attempts)} (${matchStats.mismatched.paid}/${matchStats.mismatched.attempts})`
                          : "No data",
                      barClassName: "bg-muted-foreground/50",
                    },
                  ]}
                />
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="size-4 text-brand-blue" />
                  Attempts needed to resolve
                </CardTitle>
                <CardDescription>
                  How many transactions recovered on the first nudge vs.
                  needed escalation — and how many are still unresolved.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <BarList
                  items={[
                    ...attemptStats.recoveredByAttempt.map((count, i) => ({
                      key: `attempt-${i + 1}`,
                      label: `Recovered — attempt ${i + 1}`,
                      fraction: count / maxAttemptBucket,
                      valueLabel: String(count),
                      barClassName: "bg-success",
                    })),
                    {
                      key: "still-active",
                      label: "Still in progress",
                      fraction: attemptStats.stillActive / maxAttemptBucket,
                      valueLabel: String(attemptStats.stillActive),
                      barClassName: "bg-warning",
                    },
                    {
                      key: "unrecovered",
                      label: "Unrecovered",
                      fraction: attemptStats.unrecovered / maxAttemptBucket,
                      valueLabel: String(attemptStats.unrecovered),
                      barClassName: "bg-destructive",
                    },
                  ]}
                />
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
