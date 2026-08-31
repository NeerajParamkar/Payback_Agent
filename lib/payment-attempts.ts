// Pure helpers over Transaction.paymentAttempts — this is the source of truth for
// whether an order has actually been paid. A failed payment attempt never marks
// revenue as lost by itself; only the presence of one "captured" attempt does,
// however many attempts failed before it. A refunded attempt no longer counts -
// see setPaymentAttemptStatus - so a full refund correctly reopens an order.

import { randomUUID } from "crypto";
import type {
  AttemptOutcome,
  OrderPaymentStatus,
  PaymentAttempt,
  PaymentAttemptStatus,
  Transaction,
} from "@/lib/types";

export function isOrderPaid(transaction: Pick<Transaction, "paymentAttempts">): boolean {
  return transaction.paymentAttempts.some((p) => p.status === "captured");
}

export function getOrderPaymentStatus(
  transaction: Pick<Transaction, "paymentAttempts">
): OrderPaymentStatus {
  return isOrderPaid(transaction) ? "paid" : "unpaid";
}

/**
 * Resolves the payment attempt for one recovery cycle into its terminal state,
 * driven by an AttemptOutcome (the agent loop's / a real customer's own
 * vocabulary). If a "created" attempt already exists for this
 * recoveryAttemptNumber (pushed when a real Payment Link was made), it's
 * updated in place; otherwise a new resolved entry is appended - covers a
 * non-retry action (a reminder, an incentive offer) that still ended in a real
 * payment with no Payment Link of its own.
 */
export function resolvePaymentAttempt(
  paymentAttempts: PaymentAttempt[],
  recoveryAttemptNumber: number,
  amount: number,
  outcome: AttemptOutcome,
  diagnosedReason: string,
  razorpayPaymentId?: string
): PaymentAttempt[] {
  const status: PaymentAttemptStatus =
    outcome === "paid"
      ? "captured"
      : outcome === "paid_elsewhere"
        ? "paid_elsewhere"
        : "failed"; // declined_again / no_response

  const now = new Date().toISOString();
  const index = paymentAttempts.findIndex(
    (p) => p.recoveryAttemptNumber === recoveryAttemptNumber
  );

  if (index === -1) {
    return [
      ...paymentAttempts,
      {
        id: randomUUID(),
        recoveryAttemptNumber,
        status,
        amount,
        ...(razorpayPaymentId ? { razorpayPaymentId } : {}),
        ...(status === "failed" ? { failureReason: diagnosedReason } : {}),
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  const next = [...paymentAttempts];
  next[index] = {
    ...next[index],
    status,
    updatedAt: now,
    ...(razorpayPaymentId ? { razorpayPaymentId } : {}),
    ...(status === "failed" ? { failureReason: diagnosedReason } : {}),
  };
  return next;
}

/**
 * Sets one payment attempt's status directly, driven by Razorpay's own webhook
 * vocabulary (captured/failed/pending/refunded) rather than an AttemptOutcome -
 * used by lib/razorpay-webhook.ts. `match` selects which attempt to update; if
 * none matches and `appendIfMissing` is given, a new entry is appended instead
 * (a real "paid" webhook is authoritative even if this system never itself
 * created a tracked Payment Link for it).
 */
export function setPaymentAttemptStatus(
  paymentAttempts: PaymentAttempt[],
  match: (p: PaymentAttempt) => boolean,
  status: PaymentAttemptStatus,
  updates: Partial<Pick<PaymentAttempt, "razorpayPaymentId" | "method" | "failureReason">> = {},
  appendIfMissing?: { recoveryAttemptNumber: number; amount: number }
): PaymentAttempt[] {
  const index = paymentAttempts.findIndex(match);
  const now = new Date().toISOString();

  if (index === -1) {
    if (!appendIfMissing) return paymentAttempts;
    return [
      ...paymentAttempts,
      {
        id: randomUUID(),
        recoveryAttemptNumber: appendIfMissing.recoveryAttemptNumber,
        status,
        amount: appendIfMissing.amount,
        createdAt: now,
        updatedAt: now,
        ...updates,
      },
    ];
  }

  const next = [...paymentAttempts];
  next[index] = { ...next[index], status, updatedAt: now, ...updates };
  return next;
}
