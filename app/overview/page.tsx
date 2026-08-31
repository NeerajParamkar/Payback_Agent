"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bot,
  IndianRupee,
  Inbox,
  ListChecks,
  Percent,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { BarList } from "@/components/bar-list";
import { SiteHeader } from "@/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatINR } from "@/lib/format";
import type { DashboardAnalytics, RateBreakdown } from "@/lib/dashboard-analytics";

function useDashboard() {
  const [data, setData] = useState<DashboardAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/dashboard");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Failed to load dashboard data.");
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load dashboard data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

interface StatTileProps {
  label: string;
  value: string;
  valueClassName?: string;
  icon: React.ComponentType<{ className?: string }>;
  loading: boolean;
}

function StatTile({ label, value, valueClassName, icon: Icon, loading }: StatTileProps) {
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
          <p className={`text-2xl font-semibold ${valueClassName ?? "text-foreground"}`}>{value}</p>
        )}
      </CardContent>
    </Card>
  );
}

function toBarItems(breakdown: RateBreakdown[], formatValue: (b: RateBreakdown) => string) {
  return breakdown.map((b) => ({
    key: b.key,
    label: b.label,
    fraction: b.rate,
    valueLabel: formatValue(b),
  }));
}

function countValueLabel(b: RateBreakdown): string {
  return `${Math.round(b.rate * 100)}% (${b.numerator}/${b.denominator})`;
}

function amountValueLabel(b: RateBreakdown): string {
  return `${Math.round(b.rate * 100)}% (${formatINR(b.numerator)}/${formatINR(b.denominator)})`;
}

function BreakdownCard({
  title,
  description,
  breakdown,
  loading,
  formatValue,
}: {
  title: string;
  description: string;
  breakdown: RateBreakdown[] | undefined;
  loading: boolean;
  formatValue: (b: RateBreakdown) => string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-3 py-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : !breakdown || breakdown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No data yet.</p>
        ) : (
          <BarList items={toBarItems(breakdown, formatValue)} />
        )}
      </CardContent>
    </Card>
  );
}

// A funnel is a magnitude comparison across sequential stages - one sequential
// hue (brand blue), bar width driven by each stage's own count relative to the
// funnel's first stage, never a separate hue per stage (that would wrongly
// imply the stages are a categorical/identity comparison, not a narrowing flow).
function RecoveryFunnel({
  stages,
  loading,
}: {
  stages: DashboardAnalytics["funnel"] | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-3 py-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (!stages || stages.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No data yet.</p>;
  }

  const first = stages[0].count || 1;

  return (
    <div className="flex flex-col gap-2">
      {stages.map((stage, i) => {
        const widthPercent = Math.max((stage.count / first) * 100, stage.count > 0 ? 4 : 0);
        const dropFromPrevious = i > 0 ? stages[i - 1].count - stage.count : 0;
        return (
          <div key={stage.key}>
            <div className="mb-1 flex items-baseline justify-between text-sm">
              <span className="font-medium text-foreground">{stage.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {stage.count.toLocaleString("en-IN")}
                {stage.amount !== undefined ? ` · ${formatINR(stage.amount)}` : ""}
                {i > 0 && dropFromPrevious > 0 && (
                  <span className="ml-2 text-xs text-destructive">
                    -{dropFromPrevious.toLocaleString("en-IN")}
                  </span>
                )}
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-sm bg-muted">
              <div
                className="h-full rounded-sm bg-brand-blue"
                style={{ width: `${widthPercent}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function OverviewPage() {
  const { data, loading, error } = useDashboard();

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-foreground">Revenue Recovery Admin Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Money-first view of the whole recovery system — funnel, channel and
            segment breakdowns, and customer history.
          </p>
        </div>

        {error && (
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Total Revenue at Risk"
            value={data ? formatINR(data.money.revenueAtRisk) : ""}
            valueClassName="text-navy"
            icon={IndianRupee}
            loading={loading}
          />
          <StatTile
            label="Revenue Recovered"
            value={data ? formatINR(data.money.revenueRecovered) : ""}
            valueClassName="text-success"
            icon={TrendingUp}
            loading={loading}
          />
          <StatTile
            label="Unrecovered Revenue"
            value={data ? formatINR(data.money.revenueUnrecovered) : ""}
            valueClassName="text-destructive"
            icon={TrendingDown}
            loading={loading}
          />
          <StatTile
            label="Recovery Rate"
            value={data ? `${data.money.recoveryRate}%` : ""}
            valueClassName="text-brand-blue"
            icon={Percent}
            loading={loading}
          />
        </div>

        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatTile
            label="Active Recovery Cases"
            value={data ? String(data.money.activeRecoveryCases) : ""}
            icon={ListChecks}
            loading={loading}
          />
          <StatTile
            label="Human Escalations"
            value={data ? String(data.money.humanEscalations) : ""}
            valueClassName="text-warning"
            icon={ShieldAlert}
            loading={loading}
          />
          <StatTile
            label="AI-Attributed Revenue Recovered"
            value={data ? formatINR(data.money.aiAttributedRevenueRecovered) : ""}
            valueClassName="text-brand-blue"
            icon={Bot}
            loading={loading}
          />
        </div>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Recovery Funnel</CardTitle>
            <CardDescription>
              Every failed payment&apos;s path from detection to recovered revenue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RecoveryFunnel stages={data?.funnel} loading={loading} />
          </CardContent>
        </Card>

        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <StatTile
            label="Human Escalation Rate"
            value={data ? `${Math.round(data.humanEscalationRate * 100)}%` : ""}
            valueClassName="text-warning"
            icon={ShieldAlert}
            loading={loading}
          />
          <StatTile
            label="Recovery Success Rate"
            value={data ? `${Math.round(data.recoverySuccessRate * 100)}%` : ""}
            valueClassName="text-success"
            icon={Percent}
            loading={loading}
          />
        </div>

        <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <BreakdownCard
            title="Recovery by root cause"
            description="Which diagnosed failure reasons convert best."
            breakdown={data?.byRootCause}
            loading={loading}
            formatValue={countValueLabel}
          />
          <BreakdownCard
            title="Recovery by channel"
            description="Payment link, email, reminder, or human escalation."
            breakdown={data?.byChannel}
            loading={loading}
            formatValue={countValueLabel}
          />
          <BreakdownCard
            title="Recovery by customer segment"
            description="Segmented by each customer's own Recovery Score."
            breakdown={data?.byCustomerSegment}
            loading={loading}
            formatValue={amountValueLabel}
          />
          <BreakdownCard
            title="Recovery by transaction amount"
            description="Larger orders don't always convert the same as small ones."
            breakdown={data?.byAmountTier}
            loading={loading}
            formatValue={countValueLabel}
          />
          <BreakdownCard
            title="Recovery by time of day"
            description="When recovery actions were taken, and how often they worked."
            breakdown={data?.byTimeOfDay}
            loading={loading}
            formatValue={countValueLabel}
          />
          <BreakdownCard
            title="Recovery by attempt number"
            description="Does the 1st nudge convert better than the 3rd?"
            breakdown={data?.byAttemptNumber}
            loading={loading}
            formatValue={countValueLabel}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Users className="size-4 text-brand-blue" />
                Customer Recovery History
              </span>
              <Link
                href="/customers"
                className="text-xs font-medium text-brand-blue hover:underline"
              >
                View all customers →
              </Link>
            </CardTitle>
            <CardDescription>Top 5 customers by amount currently at risk.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex flex-col gap-3 py-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : !data || data.topCustomers.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
                <Inbox className="size-6" />
                No customers found.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Transactions</TableHead>
                    <TableHead className="text-right">Recovered</TableHead>
                    <TableHead className="text-right">At Risk</TableHead>
                    <TableHead className="text-right">Recovery Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topCustomers.map((c) => (
                    <TableRow key={c.customerId}>
                      <TableCell className="font-medium text-foreground">{c.customerName}</TableCell>
                      <TableCell className="text-right">
                        {c.successfulTransactions}/{c.totalTransactions}
                      </TableCell>
                      <TableCell className="text-right text-success">
                        {formatINR(c.amountRecovered)}
                      </TableCell>
                      <TableCell className="text-right text-navy">
                        {formatINR(c.amountAtRisk)}
                      </TableCell>
                      <TableCell className="text-right">{c.recoveryScore}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
