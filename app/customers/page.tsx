"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Inbox } from "lucide-react";
import { useRouter } from "next/navigation";
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
import { formatINR, humanize } from "@/lib/format";
import type { CustomerRecoveryProfile } from "@/lib/types";

function useCustomers() {
  const [customers, setCustomers] = useState<CustomerRecoveryProfile[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/customers");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load customers.");
        setCustomers(data.customers);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load customers.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return { customers, loading, error };
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

export default function CustomersPage() {
  const { customers, loading, error } = useCustomers();
  const router = useRouter();

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-foreground">Customer Recovery Intelligence</h1>
          <p className="text-sm text-muted-foreground">
            Historical recovery behavior per customer, and a transparent 0-100
            Recovery Score built from a weighted rule-based model.
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
            <CardTitle>Customers</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton />
            ) : !customers || customers.length === 0 ? (
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
                    <TableHead className="text-right">Avg Delay</TableHead>
                    <TableHead>Preferred Channel</TableHead>
                    <TableHead className="text-right">Recovery Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customers
                    .slice()
                    .sort((a, b) => b.totalAmount - a.totalAmount)
                    .map((c) => (
                      <TableRow
                        key={c.customerId}
                        className="cursor-pointer"
                        onClick={() => router.push(`/customers/${encodeURIComponent(c.customerId)}`)}
                      >
                        <TableCell>
                          <div className="font-medium text-foreground">{c.customerName}</div>
                          {c.customerEmail && (
                            <div className="text-xs text-muted-foreground">{c.customerEmail}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {c.successfulTransactions}/{c.totalTransactions}
                        </TableCell>
                        <TableCell className="text-right text-success">
                          {formatINR(c.amountRecovered)}
                        </TableCell>
                        <TableCell className="text-right text-navy">
                          {formatINR(c.amountAtRisk)}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {c.averagePaymentDelayHours !== null
                            ? `${Math.round(c.averagePaymentDelayHours)}h`
                            : "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {c.preferredRecoveryChannel
                            ? humanize(c.preferredRecoveryChannel)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge
                            variant="outline"
                            className={scoreBadgeClassName(c.recoveryScore)}
                          >
                            {c.recoveryScore}
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
    </div>
  );
}
