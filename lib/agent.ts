import { randomUUID } from "crypto";
import { diagnoseTransaction } from "@/lib/diagnose";
import { sendConfirmationEmail } from "@/lib/email";
import { isWellMatched } from "@/lib/match-quality";
import { createRecoveryPaymentLink } from "@/lib/razorpay";
import { readTransactions, writeTransactions } from "@/lib/transactions-store";
import type {
  AttemptOutcome,
  FailureReason,
  RecoveryAction,
  RecoveryAttempt,
  Transaction,
  TransactionStatus,
} from "@/lib/types";

const MAX_ATTEMPTS = 3;

const WELL_MATCHED_SUCCESS_RATE = 0.7;
const MISMATCHED_SUCCESS_RATE = 0.3;

// How long to wait before the next attempt, per diagnosed reason. Reasons that are
// inherently time-boxed (an OTP expiring, a transient bank glitch) get retried right
// away; reasons that need real-world time to resolve (funds arriving, a customer
// updating their card, a corporate approval workflow) get a real cool-down instead
// of being hammered again immediately.
const RETRY_DELAY_HOURS: Record<FailureReason, number> = {
  otp_timeout: 0,
  bank_server_error: 0,
  customer_distraction: 6,
  payment_method_declined: 12,
  card_expired: 24,
  international_card_block: 24,
  insufficient_funds: 48,
  invoice_not_reviewed: 72,
};

function simulateOutcome(
  trueReason: FailureReason,
  action: RecoveryAction
): AttemptOutcome {
  const paidProbability = isWellMatched(trueReason, action)
    ? WELL_MATCHED_SUCCESS_RATE
    : MISMATCHED_SUCCESS_RATE;

  const roll = Math.random();
  if (roll < paidProbability) return "paid";

  // Split the remaining probability mass evenly between the two "not paid" outcomes.
  const remainder = (roll - paidProbability) / (1 - paidProbability);
  return remainder < 0.5 ? "declined_again" : "no_response";
}

interface ExecuteResult {
  actionTaken: string;
  actionDetail: string;
  paymentLinkId?: string;
  paymentLinkUrl?: string;
}

const SIMULATED_ACTION_LABELS: Partial<Record<RecoveryAction, string>> = {
  send_sms_reminder: "sent_sms_reminder",
  send_whatsapp_reminder: "sent_whatsapp_reminder",
  send_email_reminder: "sent_email_reminder",
  offer_incentive_discount: "sent_incentive_offer",
  escalate_to_call: "escalated_to_call",
  escalate_to_account_manager: "escalated_to_account_manager",
};

async function executeAction(
  transaction: Transaction,
  diagnosedReason: FailureReason,
  recommendedAction: RecoveryAction,
  customerMessage: string,
  attemptNumber: number
): Promise<ExecuteResult> {
  if (
    recommendedAction === "retry_payment_same_method" ||
    recommendedAction === "retry_payment_alternate_method"
  ) {
    const link = await createRecoveryPaymentLink({
      transactionId: transaction.id,
      amount: transaction.amount,
      reason: diagnosedReason,
      attemptNumber,
      customerName: transaction.customerName,
      customerEmail: transaction.customerEmail,
      customerPhone: transaction.customerPhone,
    });
    const methodLabel =
      recommendedAction === "retry_payment_alternate_method"
        ? "alternate"
        : "same";
    return {
      actionTaken: "razorpay_retry",
      actionDetail: `We're re-attempting your payment of ₹${transaction.amount} (${methodLabel} method). Complete it securely here: ${link.paymentLinkUrl}`,
      paymentLinkId: link.paymentLinkId,
      paymentLinkUrl: link.paymentLinkUrl,
    };
  }

  if (recommendedAction === "mark_unrecoverable") {
    return {
      actionTaken: "mark_unrecoverable",
      actionDetail:
        "Diagnosis judged this transaction unrecoverable; no further recovery action attempted.",
    };
  }

  // Simulated message actions - logged only, nothing actually sent.
  return {
    actionTaken: SIMULATED_ACTION_LABELS[recommendedAction] ?? recommendedAction,
    actionDetail: customerMessage,
  };
}

export interface AgentRunResult {
  transaction: Transaction;
  error?: string;
}

/**
 * Runs the recovery loop for a single transaction: diagnose -> execute -> simulate
 * outcome -> escalate or stop, up to MAX_ATTEMPTS. Hard stopping rules (max attempts,
 * freeze after mark_unrecoverable) are enforced here, not left to the LLM.
 *
 * Between attempts, a per-diagnosed-reason cool-down applies (RETRY_DELAY_HOURS) -
 * reasons with a 0-hour delay (e.g. otp_timeout) still escalate immediately within
 * this same call, but a reason that needs real time to resolve (e.g. insufficient_funds)
 * pauses here: the transaction is returned as "in_progress" with nextEligibleAttemptDate
 * set, and its next attempt only happens on a later run once that date has passed.
 */
export async function runAgentForTransaction(
  transaction: Transaction
): Promise<AgentRunResult> {
  // Frozen: already resolved by a previous run, or attempts already exhausted.
  if (
    transaction.status === "recovered" ||
    transaction.status === "unrecovered" ||
    transaction.attempts.length >= MAX_ATTEMPTS
  ) {
    return { transaction };
  }

  // Real customer, waiting on them to click a response link in their email -
  // do not diagnose or email again until they respond (see handleEmailResponse).
  if (transaction.status === "waiting_for_response") {
    return { transaction };
  }

  // A real Razorpay Payment Link is outstanding - only the payment webhook
  // (see the webhook route) can resolve this, not another automated pass.
  if (transaction.status === "awaiting_payment") {
    return { transaction };
  }

  // Still cooling down from its last attempt - not eligible yet this run.
  if (
    transaction.nextEligibleAttemptDate &&
    new Date(transaction.nextEligibleAttemptDate).getTime() > Date.now()
  ) {
    return { transaction };
  }

  const attempts: RecoveryAttempt[] = [...transaction.attempts];
  let finalStatus: TransactionStatus | null = null;
  let nextEligibleAttemptDate: string | undefined;
  let pendingResponseToken: string | undefined;

  for (
    let attemptNumber = attempts.length + 1;
    attemptNumber <= MAX_ATTEMPTS;
    attemptNumber++
  ) {
    try {
      const diagnosis = await diagnoseTransaction({
        id: transaction.id,
        type: transaction.type,
        amount: transaction.amount,
        customerName: transaction.customerName,
        attemptNumber,
        previousActions: attempts.map((a) => a.recommendedAction as RecoveryAction),
      });

      const execResult = await executeAction(
        transaction,
        diagnosis.reason,
        diagnosis.recommendedAction,
        diagnosis.customerMessage,
        attemptNumber
      );

      if (diagnosis.recommendedAction === "mark_unrecoverable") {
        attempts.push({
          attemptNumber,
          timestamp: new Date().toISOString(),
          diagnosedReason: diagnosis.reason,
          recommendedAction: diagnosis.recommendedAction,
          actionTaken: execResult.actionTaken,
          actionDetail: execResult.actionDetail,
          outcome: "no_response",
        });
        finalStatus = "unrecovered";
        break;
      }

      // Real customer - send a real email instead of simulating an outcome.
      // The transaction freezes here until they click a response link. For
      // retry actions, execResult.actionDetail already contains the real
      // payment link, so it's included in the email body automatically -
      // for every other action it's identical to diagnosis.customerMessage.
      if (transaction.customerEmail) {
        const token = randomUUID();
        const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
        await sendConfirmationEmail({
          toEmail: transaction.customerEmail,
          toName: transaction.customerName,
          transactionId: transaction.id,
          amount: transaction.amount,
          message: execResult.actionDetail,
          paidUrl: `${baseUrl}/confirm?t=${transaction.id}&r=paid&token=${token}`,
          notPaidUrl: `${baseUrl}/confirm?t=${transaction.id}&r=not_paid&token=${token}`,
          paidElsewhereUrl: `${baseUrl}/confirm?t=${transaction.id}&r=paid_elsewhere&token=${token}`,
        });

        attempts.push({
          attemptNumber,
          timestamp: new Date().toISOString(),
          diagnosedReason: diagnosis.reason,
          recommendedAction: diagnosis.recommendedAction,
          actionTaken: execResult.actionTaken,
          actionDetail: `${execResult.actionDetail} (real email sent to ${transaction.customerEmail})`,
          outcome: "awaiting_response",
          ...(execResult.paymentLinkId
            ? { paymentLinkId: execResult.paymentLinkId }
            : {}),
          ...(execResult.paymentLinkUrl
            ? { paymentLinkUrl: execResult.paymentLinkUrl }
            : {}),
        });
        finalStatus = "waiting_for_response";
        pendingResponseToken = token;
        break; // stop entirely; only a real click on a response link continues this
      }

      const outcome = simulateOutcome(
        transaction.trueFailureReason,
        diagnosis.recommendedAction
      );

      const paymentLinkFields = {
        ...(execResult.paymentLinkId
          ? { paymentLinkId: execResult.paymentLinkId }
          : {}),
        ...(execResult.paymentLinkUrl
          ? { paymentLinkUrl: execResult.paymentLinkUrl }
          : {}),
      };

      if (outcome === "paid") {
        attempts.push({
          attemptNumber,
          timestamp: new Date().toISOString(),
          diagnosedReason: diagnosis.reason,
          recommendedAction: diagnosis.recommendedAction,
          actionTaken: execResult.actionTaken,
          actionDetail: execResult.actionDetail,
          outcome,
          ...paymentLinkFields,
        });
        finalStatus = "recovered";
        break;
      }

      if (attemptNumber === MAX_ATTEMPTS) {
        attempts.push({
          attemptNumber,
          timestamp: new Date().toISOString(),
          diagnosedReason: diagnosis.reason,
          recommendedAction: diagnosis.recommendedAction,
          actionTaken: execResult.actionTaken,
          actionDetail: execResult.actionDetail,
          outcome,
          ...paymentLinkFields,
        });
        finalStatus = "unrecovered";
        break;
      }

      // Not resolved, attempts remain - decide whether to escalate right now
      // (0-hour reasons) or wait out this reason's real-world cool-down.
      const delayHours =
        RETRY_DELAY_HOURS[diagnosis.reason as FailureReason] ?? 0;
      const scheduledFor =
        delayHours > 0
          ? new Date(Date.now() + delayHours * 3600_000).toISOString()
          : undefined;

      attempts.push({
        attemptNumber,
        timestamp: new Date().toISOString(),
        diagnosedReason: diagnosis.reason,
        recommendedAction: diagnosis.recommendedAction,
        actionTaken: execResult.actionTaken,
        actionDetail: execResult.actionDetail,
        outcome,
        ...paymentLinkFields,
        ...(scheduledFor ? { nextAttemptEligibleAt: scheduledFor } : {}),
      });

      if (scheduledFor) {
        nextEligibleAttemptDate = scheduledFor;
        break; // pause here; the next attempt resumes on a future run once eligible
      }
      // else: 0-hour reason, loop continues to the next attempt immediately.
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown error during recovery attempt.";
      return {
        transaction: {
          ...transaction,
          status: attempts.length > 0 ? "in_progress" : transaction.status,
          attempts,
          nextEligibleAttemptDate: undefined,
        },
        error: `Attempt ${attemptNumber} failed: ${message}`,
      };
    }
  }

  return {
    transaction: {
      ...transaction,
      status: finalStatus ?? "in_progress",
      attempts,
      nextEligibleAttemptDate: finalStatus ? undefined : nextEligibleAttemptDate,
      pendingResponseToken:
        finalStatus === "waiting_for_response" ? pendingResponseToken : undefined,
    },
  };
}

export interface EmailResponseResult {
  ok: boolean;
  message: string;
  transaction?: Transaction;
}

/**
 * Handles a customer clicking a response link in a real recovery email.
 * Updates the pending attempt with the real outcome, then applies the same
 * hard stopping rules as the automated loop (max attempts, freeze on terminal
 * outcomes) rather than a separate set of rules.
 */
export async function handleEmailResponse(
  transactionId: string,
  token: string,
  response: "paid" | "not_paid" | "paid_elsewhere"
): Promise<EmailResponseResult> {
  const transactions = await readTransactions();
  const index = transactions.findIndex((t) => t.id === transactionId);
  if (index === -1) {
    return { ok: false, message: "Transaction not found." };
  }

  const transaction = transactions[index];

  if (transaction.status !== "waiting_for_response") {
    return {
      ok: false,
      message: "This link has already been used or is no longer active.",
    };
  }
  if (!transaction.pendingResponseToken || transaction.pendingResponseToken !== token) {
    return { ok: false, message: "This link is invalid or has expired." };
  }

  const attempts = [...transaction.attempts];
  const lastIndex = attempts.length - 1;
  const lastAttempt = attempts[lastIndex];
  if (!lastAttempt || lastAttempt.outcome !== "awaiting_response") {
    return { ok: false, message: "No pending confirmation found for this transaction." };
  }

  const respondedAt = new Date().toISOString();
  let updated: Transaction;

  if (response === "paid") {
    attempts[lastIndex] = { ...lastAttempt, outcome: "paid", respondedAt };
    updated = {
      ...transaction,
      status: "recovered",
      attempts,
      pendingResponseToken: undefined,
      nextEligibleAttemptDate: undefined,
    };
  } else if (response === "paid_elsewhere") {
    attempts[lastIndex] = { ...lastAttempt, outcome: "paid_elsewhere", respondedAt };
    updated = {
      ...transaction,
      status: "unrecovered",
      attempts,
      pendingResponseToken: undefined,
      nextEligibleAttemptDate: undefined,
    };
  } else {
    attempts[lastIndex] = { ...lastAttempt, outcome: "declined_again", respondedAt };
    if (lastAttempt.attemptNumber >= MAX_ATTEMPTS) {
      updated = {
        ...transaction,
        status: "unrecovered",
        attempts,
        pendingResponseToken: undefined,
        nextEligibleAttemptDate: undefined,
      };
    } else {
      // At least a 1-hour gap before the next real email, even for reasons that
      // are "immediate" in the simulated flow - don't re-email a real person
      // seconds after they just said no.
      const delayHours = Math.max(
        RETRY_DELAY_HOURS[lastAttempt.diagnosedReason as FailureReason] ?? 0,
        1
      );
      updated = {
        ...transaction,
        status: "in_progress",
        attempts,
        pendingResponseToken: undefined,
        nextEligibleAttemptDate: new Date(
          Date.now() + delayHours * 3600_000
        ).toISOString(),
      };
    }
  }

  transactions[index] = updated;
  await writeTransactions(transactions);

  return { ok: true, message: "Thanks — your response has been recorded.", transaction: updated };
}

interface RazorpayWebhookNotes {
  original_transaction_id?: unknown;
  attempt_number?: unknown;
}

interface RazorpayWebhookEvent {
  event?: unknown;
  payload?: {
    payment_link?: { entity?: { id?: unknown; notes?: RazorpayWebhookNotes } };
    payment?: { entity?: { id?: unknown; notes?: RazorpayWebhookNotes } };
  };
}

export interface WebhookHandleResult {
  handled: boolean;
  reason: string;
}

/**
 * Handles a verified Razorpay webhook event (payment_link.paid / payment.captured).
 * Only ever resolves attempts created via createRecoveryPaymentLink (outcome
 * "awaiting_payment") - every other action type is untouched by this path,
 * matching the plan: real webhook outcomes replace the simulation only for
 * payment-link retries, not for reminder-type actions.
 */
export async function handlePaymentWebhookEvent(
  rawEvent: unknown
): Promise<WebhookHandleResult> {
  const event = rawEvent as RazorpayWebhookEvent;
  const entity = event.payload?.payment_link?.entity ?? event.payload?.payment?.entity;
  const notes = entity?.notes;
  const transactionId =
    typeof notes?.original_transaction_id === "string"
      ? notes.original_transaction_id
      : undefined;

  if (!transactionId) {
    return { handled: false, reason: "No original_transaction_id in webhook notes; ignored." };
  }

  const paymentLinkId =
    typeof event.payload?.payment_link?.entity?.id === "string"
      ? event.payload.payment_link.entity.id
      : undefined;
  const attemptNumberFromNotes =
    typeof notes?.attempt_number === "number"
      ? notes.attempt_number
      : typeof notes?.attempt_number === "string"
        ? Number(notes.attempt_number)
        : undefined;

  const transactions = await readTransactions();
  const index = transactions.findIndex((t) => t.id === transactionId);
  if (index === -1) {
    return { handled: false, reason: `Transaction ${transactionId} not found; ignored.` };
  }

  const transaction = transactions[index];

  // Already resolved (e.g. a redelivered webhook) - idempotent no-op.
  if (transaction.status === "recovered" || transaction.status === "unrecovered") {
    return { handled: false, reason: `Transaction ${transactionId} already resolved; ignored.` };
  }

  const attempts = [...transaction.attempts];
  const attemptIndex = attempts.findIndex((a) =>
    paymentLinkId ? a.paymentLinkId === paymentLinkId : a.attemptNumber === attemptNumberFromNotes
  );

  if (attemptIndex === -1 || attempts[attemptIndex].outcome !== "awaiting_payment") {
    return {
      handled: false,
      reason: `No matching awaiting_payment attempt found for ${transactionId}; ignored.`,
    };
  }

  attempts[attemptIndex] = {
    ...attempts[attemptIndex],
    outcome: "paid",
    respondedAt: new Date().toISOString(),
  };

  transactions[index] = {
    ...transaction,
    status: "recovered",
    attempts,
    nextEligibleAttemptDate: undefined,
  };

  await writeTransactions(transactions);

  return { handled: true, reason: `Transaction ${transactionId} marked recovered via webhook.` };
}
