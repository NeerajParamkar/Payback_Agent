"use client";

import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  deferred: "border-warning/30 bg-warning/15 text-warning",
};

const TERMINAL_STATUSES: Transaction["status"][] = ["recovered", "unrecovered"];

const OFFLINE_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "other", label: "Other verified payment" },
] as const;

interface TransactionTrailSheetProps {
  transaction: Transaction | null;
  onOpenChange: (open: boolean) => void;
  onTransactionUpdated?: (updated: Transaction) => void;
}

type AdminForm = "promise" | "offline" | null;

export function TransactionTrailSheet({
  transaction,
  onOpenChange,
  onTransactionUpdated,
}: TransactionTrailSheetProps) {
  const [adminName, setAdminName] = useState("Admin");
  const [note, setNote] = useState("");
  const [openForm, setOpenForm] = useState<AdminForm>(null);
  const [promiseDate, setPromiseDate] = useState("");
  const [promiseTime, setPromiseTime] = useState("");
  const [offlineMethod, setOfflineMethod] = useState<(typeof OFFLINE_METHODS)[number]["value"]>("cash");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function resetAdminForm() {
    setOpenForm(null);
    setNote("");
    setPromiseDate("");
    setPromiseTime("");
    setActionError(null);
  }

  async function submit(key: string, url: string, body: Record<string, unknown>) {
    setBusy(key);
    setActionError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || (data.ok !== undefined && !data.ok)) {
        throw new Error(data.error ?? data.message ?? "Action failed.");
      }
      if (data.transaction) {
        onTransactionUpdated?.(data.transaction);
      }
      resetAdminForm();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  function markRecovered() {
    if (!transaction) return;
    submit("mark_recovered", `/api/transactions/${transaction.id}/action`, {
      action: "mark_recovered",
      adminName,
      note: note || undefined,
    });
  }

  function stopRecovery() {
    if (!transaction) return;
    submit("stop_recovery", `/api/transactions/${transaction.id}/action`, {
      action: "stop_recovery",
      adminName,
      note: note || undefined,
    });
  }

  function toggleOptOut() {
    if (!transaction) return;
    submit("opt_out", `/api/transactions/${transaction.id}/action`, {
      action: transaction.customerOptedOut ? "opt_in_customer" : "opt_out_customer",
      adminName,
      note: note || undefined,
    });
  }

  function submitOfflinePayment() {
    if (!transaction) return;
    submit("offline", `/api/transactions/${transaction.id}/action`, {
      action: "record_offline_payment",
      method: offlineMethod,
      adminName,
      note: note || undefined,
    });
  }

  function submitPromise() {
    if (!transaction || !promiseDate) return;
    submit("promise", `/api/transactions/${transaction.id}/promise-to-pay`, {
      promiseDate,
      promiseTime: promiseTime || undefined,
      adminName,
      note: note || undefined,
    });
  }

  const canAct = transaction && !TERMINAL_STATUSES.includes(transaction.status);

  return (
    <Sheet
      open={transaction !== null}
      onOpenChange={(open) => {
        if (!open) resetAdminForm();
        onOpenChange(open);
      }}
    >
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

              {transaction.status === "escalated" && (
                <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  Escalated to a human — automated recovery is frozen. See the{" "}
                  <a href="/escalations" className="underline underline-offset-2">
                    Escalations
                  </a>{" "}
                  queue, or act below.
                </p>
              )}

              {transaction.customerOptedOut && (
                <p className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                  Customer has opted out of further contact — automated recovery will stop on
                  its next cycle.
                </p>
              )}

              {transaction.status === "promise_to_pay" && transaction.nextEligibleAttemptDate && (
                <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
                  Customer promised to pay by{" "}
                  <strong>
                    {new Date(transaction.nextEligibleAttemptDate).toLocaleString("en-IN")}
                  </strong>
                  . If still unpaid by then, normal recovery policy resumes automatically.
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

                      <dt className="text-muted-foreground">Confidence</dt>
                      <dd className="text-foreground">{humanize(attempt.confidence)}</dd>

                      <dt className="text-muted-foreground">Recovery probability</dt>
                      <dd className="text-foreground">
                        {Math.round(attempt.recoveryProbability * 100)}%
                      </dd>

                      <dt className="text-muted-foreground">Priority</dt>
                      <dd className="text-foreground">{humanize(attempt.priority)}</dd>

                      <dt className="text-muted-foreground">Decision engine</dt>
                      <dd className="text-foreground">
                        <Badge
                          variant="outline"
                          className={
                            attempt.policyOverridden
                              ? "border-warning/30 bg-warning/15 text-warning"
                              : "border-border bg-muted text-muted-foreground"
                          }
                        >
                          {humanize(attempt.decisionAction)}
                          {attempt.policyOverridden ? " (overridden)" : ""}
                        </Badge>
                      </dd>
                    </dl>

                    <div className="mt-2 rounded-md bg-muted/30 px-3 py-2">
                      <p className="mb-1 text-xs font-medium text-muted-foreground">
                        AI analysis (internal, not shown to customer)
                      </p>
                      <p className="text-sm text-foreground">{attempt.diagnosisRationale}</p>
                    </div>

                    {attempt.policyOverridden && (
                      <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
                        <p className="mb-1 text-xs font-medium text-warning">
                          Policy engine override
                        </p>
                        <p className="text-sm text-foreground">{attempt.policyReason}</p>
                      </div>
                    )}

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

              {canAct && (
                <div className="border-t border-border pt-4">
                  <p className="mb-2 text-sm font-semibold text-navy">Admin actions</p>
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

                  {actionError && <p className="mb-2 text-xs text-destructive">{actionError}</p>}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => setOpenForm(openForm === "promise" ? null : "promise")}
                    >
                      Record Promise to Pay
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => setOpenForm(openForm === "offline" ? null : "offline")}
                    >
                      Record Offline Payment
                    </Button>
                    <Button size="sm" disabled={busy !== null} onClick={markRecovered}>
                      {busy === "mark_recovered" ? "Saving..." : "Mark Recovered"}
                    </Button>
                    <Button size="sm" variant="destructive" disabled={busy !== null} onClick={stopRecovery}>
                      {busy === "stop_recovery" ? "Saving..." : "Stop Recovery"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={toggleOptOut}>
                      {busy === "opt_out"
                        ? "Saving..."
                        : transaction.customerOptedOut
                          ? "Opt Customer Back In"
                          : "Opt Customer Out"}
                    </Button>
                  </div>

                  {openForm === "promise" && (
                    <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
                      <div className="flex gap-2">
                        <input
                          type="date"
                          value={promiseDate}
                          onChange={(e) => setPromiseDate(e.target.value)}
                          className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground"
                        />
                        <input
                          type="time"
                          value={promiseTime}
                          onChange={(e) => setPromiseTime(e.target.value)}
                          className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground"
                          placeholder="Optional time"
                        />
                      </div>
                      <Button
                        size="sm"
                        disabled={!promiseDate || busy !== null}
                        onClick={submitPromise}
                      >
                        {busy === "promise" ? "Saving..." : "Save Promise"}
                      </Button>
                    </div>
                  )}

                  {openForm === "offline" && (
                    <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
                      <select
                        value={offlineMethod}
                        onChange={(e) =>
                          setOfflineMethod(e.target.value as (typeof OFFLINE_METHODS)[number]["value"])
                        }
                        className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground"
                      >
                        {OFFLINE_METHODS.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      <Button size="sm" disabled={busy !== null} onClick={submitOfflinePayment}>
                        {busy === "offline" ? "Saving..." : "Confirm Offline Payment"}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
