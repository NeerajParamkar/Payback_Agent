"use client";

import { MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatusBadge } from "@/components/status-badge";
import { formatINR, humanize } from "@/lib/format";
import type { AttemptOutcome, Transaction } from "@/lib/types";

const OUTCOME_STYLES: Record<AttemptOutcome, string> = {
  paid: "border-success/30 bg-success/15 text-success",
  declined_again: "border-destructive/30 bg-destructive/15 text-destructive",
  no_response: "border-border bg-muted text-muted-foreground",
  paid_elsewhere: "border-border bg-muted text-muted-foreground",
  awaiting_response: "border-brand-blue/30 bg-brand-blue/15 text-brand-blue",
  awaiting_payment: "border-brand-blue/30 bg-brand-blue/15 text-brand-blue",
};

interface TransactionTrailSheetProps {
  transaction: Transaction | null;
  onOpenChange: (open: boolean) => void;
}

export function TransactionTrailSheet({
  transaction,
  onOpenChange,
}: TransactionTrailSheetProps) {
  return (
    <Sheet open={transaction !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {transaction && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 text-base">
                {transaction.id}
                <StatusBadge status={transaction.status} />
              </SheetTitle>
              <SheetDescription>
                {transaction.customerName} &middot; {formatINR(transaction.amount)}{" "}
                &middot; {humanize(transaction.type)}
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-col gap-3 px-4 pb-4">
              {transaction.status === "in_progress" &&
                transaction.nextEligibleAttemptDate && (
                  <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
                    Waiting to escalate — next attempt eligible on{" "}
                    <strong>
                      {new Date(transaction.nextEligibleAttemptDate).toLocaleString(
                        "en-IN"
                      )}
                    </strong>
                    . Run the batch again after that time to continue this
                    transaction.
                  </p>
                )}

              {transaction.status === "waiting_for_response" && (
                <p className="rounded-lg border border-brand-blue/30 bg-brand-blue/10 px-4 py-3 text-sm text-brand-blue">
                  A real email was sent to <strong>{transaction.customerEmail}</strong>.
                  Waiting for them to click a response link — this won&apos;t
                  advance automatically.
                </p>
              )}

              {transaction.status === "awaiting_payment" && (
                <p className="rounded-lg border border-brand-blue/30 bg-brand-blue/10 px-4 py-3 text-sm text-brand-blue">
                  A real Razorpay Payment Link was created. Waiting for
                  Razorpay&apos;s webhook to confirm a real payment — this
                  won&apos;t advance automatically or via simulation.
                </p>
              )}

              {transaction.attempts.length === 0 ? (
                <p className="rounded-lg border border-border bg-muted/50 px-4 py-6 text-center text-sm text-muted-foreground">
                  No recovery attempts yet. This transaction is still pending.
                </p>
              ) : (
                transaction.attempts.map((attempt) => (
                  <div
                    key={attempt.attemptNumber}
                    className="rounded-lg border border-border bg-card p-3"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-navy">
                        Attempt {attempt.attemptNumber}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(attempt.timestamp).toLocaleString("en-IN")}
                      </span>
                    </div>

                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                      <dt className="text-muted-foreground">Diagnosed reason</dt>
                      <dd className="text-foreground">
                        {humanize(attempt.diagnosedReason)}
                      </dd>

                      <dt className="text-muted-foreground">Recommended action</dt>
                      <dd className="text-foreground">
                        {humanize(attempt.recommendedAction)}
                      </dd>

                      <dt className="text-muted-foreground">Action taken</dt>
                      <dd className="text-foreground">
                        {humanize(attempt.actionTaken)}
                      </dd>

                      <dt className="text-muted-foreground">Outcome</dt>
                      <dd>
                        <Badge
                          variant="outline"
                          className={OUTCOME_STYLES[attempt.outcome]}
                        >
                          {humanize(attempt.outcome)}
                        </Badge>
                      </dd>
                    </dl>

                    <div className="mt-2 rounded-md bg-muted/60 px-3 py-2">
                      <p className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                        <MessageSquare className="size-3" />
                        Sent to customer
                      </p>
                      <p className="text-sm text-foreground">
                        {attempt.actionDetail}
                      </p>
                    </div>

                    {attempt.razorpayOrderId && (
                      <p className="mt-2 font-mono text-xs text-brand-blue">
                        Razorpay order: {attempt.razorpayOrderId}
                      </p>
                    )}

                    {attempt.paymentLinkUrl && (
                      <p className="mt-2 text-xs">
                        <a
                          href={attempt.paymentLinkUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-brand-blue underline underline-offset-2"
                        >
                          {attempt.paymentLinkUrl}
                        </a>
                        {attempt.paymentLinkId && (
                          <span className="ml-2 text-muted-foreground">
                            ({attempt.paymentLinkId})
                          </span>
                        )}
                      </p>
                    )}

                    {attempt.nextAttemptEligibleAt && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Next attempt scheduled for{" "}
                        {new Date(attempt.nextAttemptEligibleAt).toLocaleString(
                          "en-IN"
                        )}{" "}
                        (based on the {humanize(attempt.diagnosedReason)} cool-down).
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
