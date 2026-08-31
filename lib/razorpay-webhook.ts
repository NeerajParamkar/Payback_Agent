// Razorpay webhook processing - the reliable payment-status-synchronization
// layer for the recovery system. Kept as its own module (not inlined into
// lib/agent.ts) so the event-handling logic is easy to read, test, and extend
// with new event types independently of the diagnosis/decision/execution loop.
//
// Contract: the caller (app/api/razorpay/webhook/route.ts) MUST verify the
// request's signature before calling processRazorpayWebhookEvent - this module
// trusts its input completely and does no signature checking of its own.
//
// Idempotent: every delivery is keyed by "<event type>:<entity id>" and
// checked against the persisted webhook log (lib/webhook-log-store.ts) before
// anything is mutated; an already-processed key is recognized and skipped.
// Retry-safe: a delivery that can't be processed right now (the target order
// is mid-mutation elsewhere) reports "retry" rather than silently dropping it,
// so the route can return a 5xx and let Razorpay's own retry redeliver it.
// Logged: every delivery - processed, a recognized duplicate, ignored, or
// errored - is recorded in the webhook log for audit.

import { releaseLock, tryAcquireLock } from "@/lib/agent-lock";
import { buildEscalationAttempt } from "@/lib/escalation-queue";
import { syncEscalationEntryFor } from "@/lib/escalation-queue-store";
import { isOrderPaid, setPaymentAttemptStatus } from "@/lib/payment-attempts";
import { syncPromiseToPayFor } from "@/lib/promise-to-pay-store";
import { syncRecoveryCaseFor } from "@/lib/recovery-case-store";
import { readTransactions, updateTransaction } from "@/lib/transactions-store";
import { appendWebhookLogEntry, hasProcessedEventKey } from "@/lib/webhook-log-store";
import type { PaymentAttempt, Transaction } from "@/lib/types";

async function syncDerivedState(transaction: Transaction): Promise<void> {
  await syncRecoveryCaseFor(transaction);
  await syncEscalationEntryFor(transaction);
  await syncPromiseToPayFor(transaction);
}

interface RazorpayEntity {
  id?: unknown;
  order_id?: unknown;
  payment_id?: unknown;
  payment_link_id?: unknown;
  method?: unknown;
  amount?: unknown;
  status?: unknown;
  error_description?: unknown;
  notes?: { original_transaction_id?: unknown };
}

interface RazorpayWebhookPayload {
  event?: unknown;
  payload?: {
    payment_link?: { entity?: RazorpayEntity };
    payment?: { entity?: RazorpayEntity };
    refund?: { entity?: RazorpayEntity };
  };
}

interface EventContext {
  eventType: string;
  transactionIdHint?: string;
  paymentLinkId?: string;
  paymentId?: string;
  entityId?: string; // the specific entity this event is about - used for the idempotency key
  method?: string;
  errorDescription?: string;
}

export interface WebhookProcessResult {
  outcome: "processed" | "duplicate" | "ignored" | "retry" | "error";
  detail: string;
  transactionId?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractContext(event: RazorpayWebhookPayload): EventContext {
  const eventType = str(event.event) ?? "unknown";
  const linkEntity = event.payload?.payment_link?.entity;
  const paymentEntity = event.payload?.payment?.entity;
  const refundEntity = event.payload?.refund?.entity;

  const transactionIdHint =
    str(linkEntity?.notes?.original_transaction_id) ??
    str(paymentEntity?.notes?.original_transaction_id);

  const paymentLinkId = str(linkEntity?.id) ?? str(paymentEntity?.payment_link_id);
  const paymentId = str(paymentEntity?.id) ?? str(refundEntity?.payment_id);

  const entityId = str(refundEntity?.id) ?? paymentId ?? paymentLinkId;

  return {
    eventType,
    transactionIdHint,
    paymentLinkId,
    paymentId,
    entityId,
    method: str(paymentEntity?.method),
    errorDescription: str(paymentEntity?.error_description),
  };
}

function buildEventKey(context: EventContext): string {
  return `${context.eventType}:${context.entityId ?? "unknown"}`;
}

/**
 * Finds the order this event is about. Prefers the notes hint (fastest, most
 * direct) but falls back to scanning for a matching razorpayPaymentId or
 * paymentLinkId already recorded on some PaymentAttempt - robust even if
 * Razorpay didn't propagate notes onto this particular entity type (refunds,
 * notably, don't carry the original order's notes).
 */
function findTransaction(transactions: Transaction[], context: EventContext): Transaction | undefined {
  if (context.transactionIdHint) {
    const byHint = transactions.find((t) => t.id === context.transactionIdHint);
    if (byHint) return byHint;
  }
  if (context.paymentId) {
    const byPaymentId = transactions.find((t) =>
      t.paymentAttempts.some((p) => p.razorpayPaymentId === context.paymentId)
    );
    if (byPaymentId) return byPaymentId;
  }
  if (context.paymentLinkId) {
    const byLink = transactions.find((t) =>
      t.paymentAttempts.some((p) => p.paymentLinkId === context.paymentLinkId)
    );
    if (byLink) return byLink;
  }
  return undefined;
}

/**
 * Finds the specific payment attempt this event is about. Prefers an exact
 * razorpayPaymentId match (distinguishes multiple tries against the same
 * link); falls back to the most recent still-open ("created"/"pending")
 * attempt against the matching Payment Link, then any attempt against it.
 */
function findAttemptIndex(
  paymentAttempts: PaymentAttempt[],
  context: EventContext,
  requireStatus?: PaymentAttempt["status"]
): number {
  if (context.paymentId) {
    const byPaymentId = paymentAttempts.findIndex(
      (p) => p.razorpayPaymentId === context.paymentId && (!requireStatus || p.status === requireStatus)
    );
    if (byPaymentId !== -1) return byPaymentId;
  }
  if (context.paymentLinkId) {
    for (let i = paymentAttempts.length - 1; i >= 0; i--) {
      const p = paymentAttempts[i];
      if (p.paymentLinkId !== context.paymentLinkId) continue;
      if (requireStatus ? p.status === requireStatus : p.status === "created" || p.status === "pending") {
        return i;
      }
    }
    if (!requireStatus) {
      const byLink = paymentAttempts.findIndex((p) => p.paymentLinkId === context.paymentLinkId);
      if (byLink !== -1) return byLink;
    }
  }
  return -1;
}

/**
 * The critical rule: when a payment succeeds -
 * 1. identify the order (findTransaction, by the caller)
 * 2. mark the order PAID (paymentAttempts entry -> "captured", status -> "recovered")
 * 3. mark the Recovery Case RECOVERED (syncRecoveryCaseFor - derives "recovered" once isOrderPaid)
 * 4. the recovered amount is the transaction's own amount, logged below
 * 5. cancel future recovery actions (nextEligibleAttemptDate cleared; isOrderPaid
 *    guards in the agent loop and Decision Engine take it from here)
 * 6. customer recovery history updates automatically - it's computed fresh from
 *    transactions.json on every read (lib/customer-recovery.ts), nothing to push
 * 7. dashboard metrics update automatically for the same reason
 */
async function handleSuccess(
  transaction: Transaction,
  context: EventContext
): Promise<WebhookProcessResult> {
  const attemptIndex = findAttemptIndex(transaction.paymentAttempts, context);
  const fallbackAttemptNumber =
    transaction.attempts[transaction.attempts.length - 1]?.attemptNumber ?? 1;

  // Duplicate-successful-payment detection MUST run before the "already paid,
  // ignore" guard below - a captured payment always makes isOrderPaid true,
  // so if that guard ran first it would silently swallow every genuinely NEW,
  // DIFFERENT payment on an already-recovered order (exactly the anomaly this
  // check exists to catch) before this code could ever see it. If a DIFFERENT
  // payment on this order was already captured (a distinct razorpayPaymentId),
  // two real payments have gone through for one order - an anomaly that needs
  // a human, not a routine "mark recovered."
  const alreadyHasCapture = transaction.paymentAttempts.some(
    (p) => p.status === "captured" && p.razorpayPaymentId && p.razorpayPaymentId !== context.paymentId
  );
  if (alreadyHasCapture) {
    const detail = `Order ${transaction.id} received a second successful payment (${context.paymentId ?? "unknown id"}) - possible duplicate charge, escalating for human review.`;
    const updated = await updateTransaction(transaction.id, (current) => {
      const paymentAttempts = setPaymentAttemptStatus(
        current.paymentAttempts,
        attemptIndex !== -1
          ? (p) => p.id === current.paymentAttempts[attemptIndex]?.id
          : () => false,
        "captured",
        { razorpayPaymentId: context.paymentId, method: context.method },
        attemptIndex === -1
          ? { recoveryAttemptNumber: fallbackAttemptNumber, amount: current.amount }
          : undefined
      );
      return {
        ...current,
        status: "escalated" as const,
        attempts: [...current.attempts, buildEscalationAttempt(current, detail, ["duplicate_successful_payments"])],
        paymentAttempts,
        nextEligibleAttemptDate: undefined,
        pendingResponseToken: undefined,
      };
    });
    if (!updated) {
      return { outcome: "error", detail: `Transaction ${transaction.id} disappeared mid-update.` };
    }
    await syncDerivedState(updated);
    return { outcome: "processed", detail, transactionId: transaction.id };
  }

  // Not a duplicate charge - either genuinely unpaid still, or this same
  // payment was already recorded (e.g. both payment_link.paid and
  // payment.captured arrived for the one real payment) - a benign no-op.
  if (isOrderPaid(transaction)) {
    return {
      outcome: "ignored",
      detail: `Order ${transaction.id} is already paid; success event ignored.`,
      transactionId: transaction.id,
    };
  }

  const updated = await updateTransaction(transaction.id, (current) => {
    const paymentAttempts = setPaymentAttemptStatus(
      current.paymentAttempts,
      attemptIndex !== -1
        ? (p) => p.id === current.paymentAttempts[attemptIndex]?.id
        : () => false,
      "captured",
      { razorpayPaymentId: context.paymentId, method: context.method },
      attemptIndex === -1
        ? { recoveryAttemptNumber: fallbackAttemptNumber, amount: current.amount }
        : undefined
    );

    const matchedRecoveryAttemptNumber =
      attemptIndex !== -1 ? current.paymentAttempts[attemptIndex].recoveryAttemptNumber : undefined;
    const attempts = current.attempts.map((a) =>
      a.attemptNumber === matchedRecoveryAttemptNumber && a.outcome !== "paid"
        ? { ...a, outcome: "paid" as const, respondedAt: new Date().toISOString() }
        : a
    );

    return {
      ...current,
      status: "recovered",
      attempts,
      paymentAttempts,
      nextEligibleAttemptDate: undefined,
      pendingResponseToken: undefined,
    };
  });

  if (!updated) {
    return { outcome: "error", detail: `Transaction ${transaction.id} disappeared mid-update.` };
  }

  await syncDerivedState(updated);

  return {
    outcome: "processed",
    detail: `Order ${transaction.id} marked recovered via webhook (${context.eventType}), amount ₹${updated.amount}.`,
    transactionId: transaction.id,
  };
}

async function handleFailure(
  transaction: Transaction,
  context: EventContext
): Promise<WebhookProcessResult> {
  if (isOrderPaid(transaction)) {
    return {
      outcome: "ignored",
      detail: `Order ${transaction.id} is already paid; a failure event for an older attempt is stale.`,
      transactionId: transaction.id,
    };
  }

  const attemptIndex = findAttemptIndex(transaction.paymentAttempts, context);
  if (attemptIndex === -1) {
    return {
      outcome: "ignored",
      detail: `No matching payment attempt found on ${transaction.id} for this failure event.`,
      transactionId: transaction.id,
    };
  }

  // Only this one payment attempt failed - it does NOT end the order's
  // recovery. The agent's own escalation (Decision Engine, cooldowns,
  // maxTotalAttempts) governs when the order is actually given up on.
  const updated = await updateTransaction(transaction.id, (current) => ({
    ...current,
    paymentAttempts: setPaymentAttemptStatus(
      current.paymentAttempts,
      (p) => p.id === current.paymentAttempts[attemptIndex]?.id,
      "failed",
      {
        razorpayPaymentId: context.paymentId,
        failureReason: context.errorDescription ?? "Payment failed",
      }
    ),
  }));

  if (!updated) {
    return { outcome: "error", detail: `Transaction ${transaction.id} disappeared mid-update.` };
  }
  await syncDerivedState(updated);

  return {
    outcome: "processed",
    detail: `Payment attempt on ${transaction.id} marked failed via webhook (${context.eventType}).`,
    transactionId: transaction.id,
  };
}

async function handlePending(
  transaction: Transaction,
  context: EventContext
): Promise<WebhookProcessResult> {
  if (isOrderPaid(transaction)) {
    return {
      outcome: "ignored",
      detail: `Order ${transaction.id} is already paid; pending event ignored.`,
      transactionId: transaction.id,
    };
  }

  const attemptIndex = findAttemptIndex(transaction.paymentAttempts, context);
  if (attemptIndex === -1) {
    return {
      outcome: "ignored",
      detail: `No matching payment attempt found on ${transaction.id} for this pending event.`,
      transactionId: transaction.id,
    };
  }

  const updated = await updateTransaction(transaction.id, (current) => ({
    ...current,
    paymentAttempts: setPaymentAttemptStatus(
      current.paymentAttempts,
      (p) => p.id === current.paymentAttempts[attemptIndex]?.id,
      "pending",
      { razorpayPaymentId: context.paymentId, method: context.method }
    ),
  }));

  if (!updated) {
    return { outcome: "error", detail: `Transaction ${transaction.id} disappeared mid-update.` };
  }
  await syncDerivedState(updated);

  return {
    outcome: "processed",
    detail: `Payment attempt on ${transaction.id} marked pending (authorized, not yet captured).`,
    transactionId: transaction.id,
  };
}

async function handleRefund(
  transaction: Transaction,
  context: EventContext
): Promise<WebhookProcessResult> {
  const attemptIndex = findAttemptIndex(transaction.paymentAttempts, context, "captured");
  if (attemptIndex === -1) {
    // A refund on a known order that can't be matched to any captured payment
    // is exactly a "complex refund issue" - a human needs to look at this
    // rather than it being silently dropped.
    const detail = `Refund event on ${transaction.id} doesn't match any captured payment attempt - flagging for human review.`;
    const updated = await updateTransaction(transaction.id, (current) => ({
      ...current,
      status: "escalated" as const,
      attempts: [...current.attempts, buildEscalationAttempt(current, detail, ["complex_refund_issue"])],
      nextEligibleAttemptDate: undefined,
      pendingResponseToken: undefined,
    }));
    if (!updated) {
      return { outcome: "error", detail: `Transaction ${transaction.id} disappeared mid-update.` };
    }
    await syncDerivedState(updated);
    return { outcome: "processed", detail, transactionId: transaction.id };
  }

  const updated = await updateTransaction(transaction.id, (current) => {
    const paymentAttempts = setPaymentAttemptStatus(
      current.paymentAttempts,
      (p) => p.id === current.paymentAttempts[attemptIndex]?.id,
      "refunded"
    );
    // Refunding this attempt may or may not leave the order still paid (another
    // captured attempt could still exist) - re-check rather than assume.
    const stillPaid = isOrderPaid({ paymentAttempts });
    return {
      ...current,
      paymentAttempts,
      status: stillPaid ? current.status : "in_progress",
      nextEligibleAttemptDate: stillPaid ? current.nextEligibleAttemptDate : undefined,
    };
  });

  if (!updated) {
    return { outcome: "error", detail: `Transaction ${transaction.id} disappeared mid-update.` };
  }
  await syncDerivedState(updated);

  const reopened = updated.status === "in_progress";
  return {
    outcome: "processed",
    detail: `Payment on ${transaction.id} refunded via webhook${reopened ? " — order reopened for recovery" : ""}.`,
    transactionId: transaction.id,
  };
}

/**
 * Entry point. The caller MUST have already verified the webhook signature.
 * Idempotent (checks the log before doing anything), retry-safe (reports
 * "retry" instead of dropping an event it can't process right now), and logs
 * every delivery regardless of outcome.
 */
export async function processRazorpayWebhookEvent(rawEvent: unknown): Promise<WebhookProcessResult> {
  const event = rawEvent as RazorpayWebhookPayload;
  const context = extractContext(event);
  const eventKey = buildEventKey(context);

  if (await hasProcessedEventKey(eventKey)) {
    const result: WebhookProcessResult = {
      outcome: "duplicate",
      detail: `Event ${eventKey} was already processed; skipped (idempotent).`,
    };
    await appendWebhookLogEntry({
      eventKey,
      eventType: context.eventType,
      status: "duplicate",
      detail: result.detail,
    });
    return result;
  }

  const transactions = await readTransactions();
  const transaction = findTransaction(transactions, context);

  if (!transaction) {
    const result: WebhookProcessResult = {
      outcome: "ignored",
      detail: `No matching transaction found for event ${eventKey}.`,
    };
    await appendWebhookLogEntry({
      eventKey,
      eventType: context.eventType,
      status: "ignored",
      detail: result.detail,
    });
    return result;
  }

  if (!tryAcquireLock(transaction.id)) {
    // Another operation (a batch run, an email-response click) is mid-mutation
    // on this exact order right now - report "retry" rather than guessing at
    // a stale copy of it; the route maps this to a 5xx so Razorpay redelivers.
    const result: WebhookProcessResult = {
      outcome: "retry",
      detail: `Transaction ${transaction.id} is currently being processed elsewhere; ask Razorpay to retry.`,
      transactionId: transaction.id,
    };
    await appendWebhookLogEntry({
      eventKey,
      eventType: context.eventType,
      transactionId: transaction.id,
      status: "error",
      detail: result.detail,
    });
    return result;
  }

  let result: WebhookProcessResult;
  try {
    if (context.eventType === "payment_link.paid" || context.eventType === "payment.captured") {
      result = await handleSuccess(transaction, context);
    } else if (context.eventType === "payment.failed" || context.eventType === "payment_link.expired") {
      result = await handleFailure(transaction, context);
    } else if (context.eventType === "payment.authorized") {
      result = await handlePending(transaction, context);
    } else if (context.eventType === "refund.created" || context.eventType === "refund.processed") {
      result = await handleRefund(transaction, context);
    } else {
      result = { outcome: "ignored", detail: `Unhandled event type: ${context.eventType}.`, transactionId: transaction.id };
    }
  } catch (error) {
    result = {
      outcome: "error",
      detail: error instanceof Error ? error.message : "Unknown error processing webhook.",
      transactionId: transaction.id,
    };
  } finally {
    releaseLock(transaction.id);
  }

  await appendWebhookLogEntry({
    eventKey,
    eventType: context.eventType,
    transactionId: result.transactionId,
    amount: transaction.amount,
    status: result.outcome === "processed" ? "processed" : result.outcome === "error" || result.outcome === "retry" ? "error" : "ignored",
    detail: result.detail,
  });

  return result;
}
