// Pure, no server-only dependencies - tracks a customer's (or an inferred)
// promise to pay by a given date. One current PromiseToPay per transaction;
// derived from Transaction state the same way RecoveryCase/EscalationQueue are.
//
// Creation: whenever a transaction enters status "promise_to_pay" and isn't
// already tracked by a *pending* record, a fresh one is created here from the
// transaction's own nextEligibleAttemptDate (set by whatever put it into this
// status - lib/agent.ts's automated inference, or the admin-recorded route,
// which writes its own record directly with real customer-stated details and
// so is left untouched by the create-branch below).
//
// Resolution: whenever a pending record is next looked at, it's resolved
// against the CURRENT transaction state - paid -> "kept"; deadline passed and
// still unpaid -> "broken" (the transaction has, by then, already resumed
// normal policy - lib/agent.ts's guards don't hold it in "promise_to_pay" past
// its deadline). Once resolved, a record is frozen as history and never
// re-derived, exactly like an escalation queue entry.

import { isOrderPaid } from "@/lib/payment-attempts";
import type { PromiseToPay, Transaction } from "@/lib/types";

export function computePromiseId(transactionId: string): string {
  return `PTP-${transactionId.replace(/^TXN-/, "")}`;
}

/**
 * Builds a promise-to-pay record from a real, admin-provided date/time (and
 * optional note) - used by the admin-recording route, which knows the actual
 * customer-stated details rather than an inferred wait. Overwrites any
 * existing record for this transaction (reusing its id, preserving its
 * createdAt) - a fresh admin-recorded promise always supersedes whatever was
 * there before, matching derivePromiseToPay's own "new cycle" behavior.
 */
export function buildAdminRecordedPromise(
  transaction: Pick<Transaction, "id" | "customerName" | "customerEmail" | "amount">,
  promiseDate: string,
  promiseTimeProvided: boolean,
  promiseAt: string,
  note: string | undefined,
  existing: PromiseToPay | undefined
): PromiseToPay {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? computePromiseId(transaction.id),
    transactionId: transaction.id,
    customerName: transaction.customerName,
    ...(transaction.customerEmail ? { customerEmail: transaction.customerEmail } : {}),
    amount: transaction.amount,
    promiseDate,
    promiseTimeProvided,
    promiseAt,
    status: "pending",
    source: "admin_recorded",
    ...(note ? { note } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function derivePromiseToPay(
  transaction: Transaction,
  existing: PromiseToPay | undefined
): PromiseToPay | null {
  const now = new Date().toISOString();

  // A fresh promise cycle just started (automated inference - lib/agent.ts) and
  // isn't already being tracked by a pending record (an admin-recorded one, or
  // one from earlier this same cycle).
  if (transaction.status === "promise_to_pay" && (!existing || existing.status !== "pending")) {
    const promiseAt = transaction.nextEligibleAttemptDate ?? now;
    return {
      id: existing?.id ?? computePromiseId(transaction.id),
      transactionId: transaction.id,
      customerName: transaction.customerName,
      ...(transaction.customerEmail ? { customerEmail: transaction.customerEmail } : {}),
      amount: transaction.amount,
      promiseDate: promiseAt.slice(0, 10),
      promiseTimeProvided: false, // the automated path infers a wait, never a customer-stated time
      promiseAt,
      status: "pending",
      source: "automated_inference",
      createdAt: now,
      updatedAt: now,
    };
  }

  if (!existing) return null;
  if (existing.status !== "pending") return existing; // already resolved - frozen history

  if (isOrderPaid(transaction)) {
    return { ...existing, status: "kept", updatedAt: now };
  }
  if (Date.now() >= new Date(existing.promiseAt).getTime()) {
    return { ...existing, status: "broken", updatedAt: now };
  }
  return existing; // still pending, not yet due
}

/**
 * Applies derivePromiseToPay across a batch of transactions against the
 * current set of records - records for transactions not in this batch are
 * left untouched, so a selective run never disturbs promises outside its scope.
 */
export function upsertPromisesToPay(
  existingPromises: PromiseToPay[],
  transactions: Transaction[]
): PromiseToPay[] {
  const byTransactionId = new Map(existingPromises.map((p) => [p.transactionId, p]));
  for (const transaction of transactions) {
    const derived = derivePromiseToPay(transaction, byTransactionId.get(transaction.id));
    if (derived) byTransactionId.set(transaction.id, derived);
  }
  return Array.from(byTransactionId.values());
}
