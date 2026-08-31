import { randomUUID } from "crypto";
import { releaseLock, tryAcquireLock } from "@/lib/agent-lock";
import { diagnoseTransaction, type CustomerHistoryContext } from "@/lib/diagnose";
import { sendConfirmationEmail } from "@/lib/email";
import {
  isWellMatched,
  MISMATCHED_SUCCESS_RATE,
  WELL_MATCHED_SUCCESS_RATE,
} from "@/lib/match-quality";
import { getOrderPaymentStatus, resolvePaymentAttempt } from "@/lib/payment-attempts";
import { createRecoveryPaymentLink } from "@/lib/razorpay";
import {
  decideRecoveryAction,
  resolveSimulationAction,
  type ManualEscalationFlags,
  type RecoveryDecisionInput,
  type RecoveryDecisionResult,
} from "@/lib/recovery-decision-engine";
import { syncRecoveryCaseFor } from "@/lib/recovery-case-store";
import { syncEscalationEntryFor } from "@/lib/escalation-queue-store";
import { syncPromiseToPayFor } from "@/lib/promise-to-pay-store";
import { getRecoveryWorkflowConfig } from "@/lib/recovery-workflow-config";
import { readTransactions, writeTransactions } from "@/lib/transactions-store";
import type {
  AttemptOutcome,
  PaymentAttempt,
  RecoveryAction,
  RecoveryAttempt,
  RootCause,
  Transaction,
  TransactionStatus,
} from "@/lib/types";

// How long to wait before the next attempt, per diagnosed root cause. Causes that
// are inherently time-boxed (an OTP expiring, a transient network glitch) get
// retried right away; causes that need real-world time to resolve (funds arriving,
// a customer updating their card, a corporate approval workflow) get a real
// cool-down instead of being hammered again immediately.
const RETRY_DELAY_HOURS: Record<RootCause, number> = {
  network_failure: 0,
  authentication_failure: 0,
  upi_failure: 0,
  payment_pending: 1,
  checkout_abandonment: 6,
  bank_decline: 12,
  card_failure: 24,
  repeated_payment_failure: 24,
  payment_order_mismatch: 24,
  unknown: 24,
  insufficient_funds: 48,
  overdue_payment: 72,
};

function simulateOutcome(
  trueReason: RootCause,
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

/**
 * Executes exactly one validated decision (lib/recovery-decision-engine.ts) -
 * never the AI's raw recommendation. "generate_payment_link" is the only branch
 * that performs a real financial operation (a genuine Razorpay Payment Link);
 * everything else is either a logged/simulated message or a no-op label.
 */
async function executeAction(
  transaction: Transaction,
  diagnosedReason: RootCause,
  decision: RecoveryDecisionResult,
  customerMessage: string,
  attemptNumber: number,
  priorAttempts: RecoveryAttempt[]
): Promise<ExecuteResult> {
  if (decision.action === "generate_payment_link") {
    const link = await createRecoveryPaymentLink({
      transactionId: transaction.id,
      amount: transaction.amount,
      reason: diagnosedReason,
      attemptNumber,
      customerName: transaction.customerName,
      customerEmail: transaction.customerEmail,
      customerPhone: transaction.customerPhone,
    });
    const methodLabel = decision.methodHint === "alternate" ? "alternate" : "same";
    return {
      actionTaken: "generated_payment_link",
      actionDetail: `We're re-attempting your payment of ₹${transaction.amount} (${methodLabel} method). Complete it securely here: ${link.paymentLinkUrl}`,
      paymentLinkId: link.paymentLinkId,
      paymentLinkUrl: link.paymentLinkUrl,
    };
  }

  if (decision.action === "retry") {
    // Resend the existing, still-unresolved Payment Link - no new Razorpay call.
    const existing = [...priorAttempts].reverse().find((a) => a.paymentLinkUrl);
    if (existing?.paymentLinkUrl) {
      return {
        actionTaken: "resent_payment_link",
        actionDetail: `Just a reminder — you can still complete your payment of ₹${transaction.amount} here: ${existing.paymentLinkUrl}`,
        paymentLinkId: existing.paymentLinkId,
        paymentLinkUrl: existing.paymentLinkUrl,
      };
    }
    // Defensive fallback - the policy engine only chooses "retry" when an active
    // link exists, but if one truly can't be found, degrade to a plain reminder
    // rather than fail the attempt.
    return { actionTaken: "sent_reminder", actionDetail: customerMessage };
  }

  if (decision.action === "send_email") {
    return { actionTaken: "sent_email_reminder", actionDetail: customerMessage };
  }

  // "send_reminder" and any other fallthrough - simulated message only.
  // ("escalate_to_human"/"stop"/"wait"/"track_promise_to_pay" never reach this
  // function - lib/agent.ts short-circuits all four before calling executeAction.)
  return { actionTaken: "sent_reminder", actionDetail: customerMessage };
}

export interface AgentRunResult {
  transaction: Transaction;
  error?: string;
  // True when this call never actually ran: another in-flight call already
  // holds the per-order lock for this transaction. `transaction` is simply the
  // input echoed back, unmodified - callers that persist results in bulk (see
  // run-batch/route.ts) must not blindly overwrite the record with this stale
  // copy, since the concurrent holder may have since written real changes to it.
  locked?: boolean;
}

/**
 * Runs the bounded recovery workflow for a single transaction: re-check payment
 * status -> diagnose -> decide (Recovery Decision Engine) -> execute at most ONE
 * action -> always pause before the next one, up to config.maxTotalAttempts.
 * Hard stopping rules (max attempts, freeze after a policy-decided stop) are
 * enforced here, not left to the LLM.
 *
 * Every action - a Payment Link, a reminder, an escalation - is followed by a
 * mandatory cool-down (RETRY_DELAY_HOURS for the diagnosed cause, floored by
 * config.delayBetweenActionsHours and, for reminders, config.reminderCooldownHours)
 * before the next one is even considered; this function never fires two actions
 * back-to-back in the same call, matching the workflow's own configured pace.
 *
 * Wrapped by the exported runAgentForTransaction with a per-order lock (see
 * lib/agent-lock.ts) so two overlapping calls can never process the same order
 * at once - the concrete guarantee against duplicate reminders or Payment Links.
 */
async function runAgentForTransactionLocked(
  transaction: Transaction,
  customerHistory?: CustomerHistoryContext
): Promise<AgentRunResult> {
  const config = getRecoveryWorkflowConfig();

  // The order's payment-attempt history is the ground truth for whether money
  // has actually been captured - checked first, ahead of every status-based
  // guard below, so a captured payment attempt always wins even if `status`
  // hasn't caught up to it yet. Re-checked again per-cycle below (and inside
  // the Decision Engine itself) so a payment captured moments ago is never missed.
  if (getOrderPaymentStatus(transaction) === "paid") {
    return { transaction };
  }

  // Frozen: already resolved by a previous run, attempts already exhausted, or
  // escalated to a human - see lib/escalation-queue.ts. Once escalated, this
  // order is permanently off-limits to automation; only an admin action
  // (lib/escalation-queue.ts's resolve/stop/mark-recovered/etc.) moves it again.
  if (
    transaction.status === "recovered" ||
    transaction.status === "unrecovered" ||
    transaction.status === "escalated" ||
    transaction.attempts.length >= config.maxTotalAttempts
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
  let paymentAttempts: PaymentAttempt[] = [...transaction.paymentAttempts];
  let finalStatus: TransactionStatus | null = null;
  let nextEligibleAttemptDate: string | undefined;
  let pendingResponseToken: string | undefined;

  for (
    let attemptNumber = attempts.length + 1;
    attemptNumber <= config.maxTotalAttempts;
    attemptNumber++
  ) {
    try {
      // A REAL Razorpay-reported failure on THIS order's own most recent
      // payment attempt (razorpayPaymentId set - distinguishes genuine
      // gateway data from our own simulated failureReason, which is just our
      // prior diagnosis echoed back, not new evidence) - fed into diagnosis
      // as live signal on a retry, integrating the real webhook data instead
      // of re-guessing blind every cycle.
      const latestGatewayFailureReason = [...paymentAttempts]
        .reverse()
        .find((p) => p.status === "failed" && p.razorpayPaymentId && p.failureReason)?.failureReason;

      const diagnosis = await diagnoseTransaction({
        id: transaction.id,
        type: transaction.type,
        amount: transaction.amount,
        customerName: transaction.customerName,
        attemptNumber,
        previousActions: attempts.map((a) => a.recommendedAction as RecoveryAction),
        customerHistory,
        gatewayErrorHint: transaction.gatewayErrorHint,
        latestGatewayFailureReason,
      });

      // The AI only ever RECOMMENDS (diagnosis.recommendedAction, above) - it is
      // never allowed to directly trigger a financial or communication operation.
      // The deterministic Recovery Decision Engine validates that recommendation
      // against hard business rules (including this workflow's configured caps)
      // and returns what actually happens.
      const decisionInput: RecoveryDecisionInput = {
        aiRecommendedAction: diagnosis.recommendedAction,
        confidence: diagnosis.confidence,
        recoveryProbability: diagnosis.recoveryProbability,
        amount: transaction.amount,
        recoveryScore: Math.round(diagnosis.recoveryProbability * 100),
        attemptCount: attempts.length,
        // Hours since recovery actually started (first attempt), not since the
        // order's original creation date - the latter can be arbitrarily old in
        // seed/demo data without automation having been "stuck" on it at all.
        recoveryDurationHours:
          (Date.now() - new Date(attempts[0]?.timestamp ?? transaction.createdAt).getTime()) /
          3600_000,
        remindersSent: attempts.filter(
          (a) => a.decisionAction === "send_reminder" || a.decisionAction === "send_email"
        ).length,
        paymentRetriesUsed: attempts.filter((a) => a.decisionAction === "generate_payment_link")
          .length,
        isOrderPaid:
          getOrderPaymentStatus({ ...transaction, paymentAttempts }) === "paid",
        hasActivePaymentLink: paymentAttempts.some(
          (p) => p.status === "created" || p.status === "pending"
        ),
        customerOptedOut: transaction.customerOptedOut ?? false,
        manualFlags: {
          customerDisputed: transaction.customerDisputed ?? false,
          customerClaimsPaidUnverified: transaction.customerClaimsPaidUnverified ?? false,
          suspectedFraud: transaction.suspectedFraud ?? false,
          complexIssueFlag: transaction.complexIssueFlag ?? false,
        } satisfies ManualEscalationFlags,
        previousActions: attempts.map((a) => a.recommendedAction as RecoveryAction),
        previousResponses: attempts.map((a) => a.outcome),
        customerHistory,
        config,
      };
      const decision = decideRecoveryAction(decisionInput);

      const analysisFields = {
        confidence: diagnosis.confidence,
        recoveryProbability: diagnosis.recoveryProbability,
        priority: diagnosis.priority,
        diagnosisRationale: diagnosis.reason,
        decisionAction: decision.action,
        policyOverridden: decision.overridden,
        policyReason: decision.reason,
        ...(decision.escalationReasons.length > 0
          ? { escalationReasons: decision.escalationReasons }
          : {}),
      };

      // "Wait" and "track a promise-to-pay" perform no operation at all - no
      // message sent, no Razorpay call, nothing simulated. Just note the
      // decision and check back later.
      if (decision.action === "wait" || decision.action === "track_promise_to_pay") {
        const baseWaitHours = decision.action === "track_promise_to_pay" ? 72 : 12;
        const delayHours = Math.max(baseWaitHours, config.delayBetweenActionsHours);
        const scheduledFor = new Date(Date.now() + delayHours * 3600_000).toISOString();
        attempts.push({
          attemptNumber,
          timestamp: new Date().toISOString(),
          diagnosedReason: diagnosis.rootCause,
          recommendedAction: diagnosis.recommendedAction,
          actionTaken: decision.action,
          actionDetail: decision.reason,
          outcome: "deferred",
          ...analysisFields,
          nextAttemptEligibleAt: scheduledFor,
        });
        nextEligibleAttemptDate = scheduledFor;
        // A tracked promise gets its own distinct status (see lib/promise-to-pay.ts) -
        // "wait" stays the generic "in_progress" cooldown.
        if (decision.action === "track_promise_to_pay") {
          finalStatus = "promise_to_pay";
        }
        break;
      }

      // The policy engine decided to give up - no execution, no simulation.
      if (decision.action === "stop") {
        attempts.push({
          attemptNumber,
          timestamp: new Date().toISOString(),
          diagnosedReason: diagnosis.rootCause,
          recommendedAction: diagnosis.recommendedAction,
          actionTaken: "stopped_by_policy",
          actionDetail: decision.reason,
          outcome: "no_response",
          ...analysisFields,
        });
        finalStatus = "unrecovered";
        break;
      }

      // Escalated to a human (lib/escalation-queue.ts) - this order is frozen
      // for automation from this point on, permanently, regardless of attempts
      // remaining. No message is sent, no Payment Link is minted, and the
      // outcome is never simulated - only an admin action moves this order again.
      if (decision.action === "escalate_to_human") {
        attempts.push({
          attemptNumber,
          timestamp: new Date().toISOString(),
          diagnosedReason: diagnosis.rootCause,
          recommendedAction: diagnosis.recommendedAction,
          actionTaken: "escalated_to_human",
          actionDetail: decision.reason,
          outcome: "no_response",
          ...analysisFields,
        });
        finalStatus = "escalated";
        break;
      }

      const execResult = await executeAction(
        transaction,
        diagnosis.rootCause,
        decision,
        diagnosis.customerMessage,
        attemptNumber,
        attempts
      );

      // Only "generate_payment_link" mints a genuinely NEW Payment Link - record
      // it as "created" immediately, before we even know the outcome, so it's
      // never lost if something below throws (e.g. the confirmation email fails
      // to send). "retry" reuses an existing link and must not double-record it.
      if (decision.action === "generate_payment_link" && execResult.paymentLinkId) {
        paymentAttempts = [
          ...paymentAttempts,
          {
            id: randomUUID(),
            recoveryAttemptNumber: attemptNumber,
            status: "created",
            amount: transaction.amount,
            paymentLinkId: execResult.paymentLinkId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];
      }

      // Real customer - send a real email instead of simulating an outcome.
      // The transaction freezes here until they click a response link. For
      // generate_payment_link/retry, execResult.actionDetail already contains
      // the real payment link, so it's included in the email body automatically -
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
          needHumanUrl: `${baseUrl}/confirm?t=${transaction.id}&r=need_human&token=${token}`,
        });

        attempts.push({
          attemptNumber,
          timestamp: new Date().toISOString(),
          diagnosedReason: diagnosis.rootCause,
          recommendedAction: diagnosis.recommendedAction,
          actionTaken: execResult.actionTaken,
          actionDetail: `${execResult.actionDetail} (real email sent to ${transaction.customerEmail})`,
          outcome: "awaiting_response",
          ...analysisFields,
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

      // The simulation reflects what was ACTUALLY executed (the validated
      // decision), never the AI's raw suggestion if the policy engine changed it.
      const outcome = simulateOutcome(
        transaction.trueFailureReason,
        resolveSimulationAction(decision, customerHistory)
      );

      // Resolve this cycle's payment attempt into its terminal state. A "retry"
      // (resend) updates the ORIGINAL Payment Link's entry, not a new one -
      // found by matching its paymentLinkId back to the recoveryAttemptNumber
      // that created it.
      const paymentAttemptNumberToResolve =
        decision.action === "retry"
          ? (paymentAttempts.find((p) => p.paymentLinkId === execResult.paymentLinkId)
              ?.recoveryAttemptNumber ?? attemptNumber)
          : attemptNumber;
      paymentAttempts = resolvePaymentAttempt(
        paymentAttempts,
        paymentAttemptNumberToResolve,
        transaction.amount,
        outcome,
        diagnosis.rootCause
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
          diagnosedReason: diagnosis.rootCause,
          recommendedAction: diagnosis.recommendedAction,
          actionTaken: execResult.actionTaken,
          actionDetail: execResult.actionDetail,
          outcome,
          ...analysisFields,
          ...paymentLinkFields,
        });
        finalStatus = "recovered";
        break;
      }

      if (attemptNumber === config.maxTotalAttempts) {
        attempts.push({
          attemptNumber,
          timestamp: new Date().toISOString(),
          diagnosedReason: diagnosis.rootCause,
          recommendedAction: diagnosis.recommendedAction,
          actionTaken: execResult.actionTaken,
          actionDetail: execResult.actionDetail,
          outcome,
          ...analysisFields,
          ...paymentLinkFields,
        });
        finalStatus = "unrecovered";
        break;
      }

      // Not resolved, attempts remain - always pause before the next one. The
      // workflow never fires two actions back-to-back in the same run: every
      // action gets at least config.delayBetweenActionsHours (and, for a
      // reminder-type action, at least config.reminderCooldownHours too),
      // floored further up by the diagnosed cause's own real-world cool-down.
      const isReminderAction = decision.action === "send_reminder" || decision.action === "send_email";
      const causeDelayHours = RETRY_DELAY_HOURS[diagnosis.rootCause] ?? 0;
      const delayHours = Math.max(
        causeDelayHours,
        config.delayBetweenActionsHours,
        isReminderAction ? config.reminderCooldownHours : 0
      );
      const scheduledFor = new Date(Date.now() + delayHours * 3600_000).toISOString();

      attempts.push({
        attemptNumber,
        timestamp: new Date().toISOString(),
        diagnosedReason: diagnosis.rootCause,
        recommendedAction: diagnosis.recommendedAction,
        actionTaken: execResult.actionTaken,
        actionDetail: execResult.actionDetail,
        outcome,
        ...analysisFields,
        ...paymentLinkFields,
        nextAttemptEligibleAt: scheduledFor,
      });

      nextEligibleAttemptDate = scheduledFor;
      break; // always pause here; the next attempt resumes on a future run once eligible
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
          paymentAttempts,
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
      paymentAttempts,
      // Scheduled resumption survives for the two non-terminal end states
      // (plain in_progress cooldown, and a tracked promise's deadline) -
      // wiped for every terminal one (recovered/unrecovered/escalated) and
      // for waiting_for_response, which resumes on a customer's click, not a date.
      nextEligibleAttemptDate:
        !finalStatus || finalStatus === "promise_to_pay" ? nextEligibleAttemptDate : undefined,
      pendingResponseToken:
        finalStatus === "waiting_for_response" ? pendingResponseToken : undefined,
    },
  };
}

/**
 * Public entry point - acquires a per-order lock before running the workflow
 * and always releases it afterward, so two overlapping calls (e.g. a
 * double-clicked "Run Batch") can never process the same order at once. If the
 * order is already being processed, this is a safe no-op: it returns the
 * transaction unchanged rather than racing the in-flight run.
 */
export async function runAgentForTransaction(
  transaction: Transaction,
  customerHistory?: CustomerHistoryContext
): Promise<AgentRunResult> {
  if (!tryAcquireLock(transaction.id)) {
    return { transaction, locked: true };
  }
  try {
    return await runAgentForTransactionLocked(transaction, customerHistory);
  } finally {
    releaseLock(transaction.id);
  }
}

export interface EmailResponseResult {
  ok: boolean;
  message: string;
  transaction?: Transaction;
}

/**
 * Public entry point - acquires the same per-order lock runAgentForTransaction
 * uses, so a real customer's click can never race an in-flight automated run
 * for the same order.
 */
export async function handleEmailResponse(
  transactionId: string,
  token: string,
  response: "paid" | "not_paid" | "paid_elsewhere" | "need_human"
): Promise<EmailResponseResult> {
  if (!tryAcquireLock(transactionId)) {
    return {
      ok: false,
      message: "This transaction is currently being processed; please try again in a moment.",
    };
  }
  try {
    return await handleEmailResponseLocked(transactionId, token, response);
  } finally {
    releaseLock(transactionId);
  }
}

/**
 * Handles a customer clicking a response link in a real recovery email.
 * Updates the pending attempt with the real outcome, then applies the same
 * hard stopping rules as the automated loop (max attempts, freeze on terminal
 * outcomes) rather than a separate set of rules.
 */
async function handleEmailResponseLocked(
  transactionId: string,
  token: string,
  response: "paid" | "not_paid" | "paid_elsewhere" | "need_human"
): Promise<EmailResponseResult> {
  const config = getRecoveryWorkflowConfig();
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
  const outcome: AttemptOutcome =
    response === "paid"
      ? "paid"
      : response === "paid_elsewhere"
        ? "paid_elsewhere"
        : "declined_again";
  // Resolves the "created" payment attempt this email's retry link produced
  // (or appends one, for a non-retry action) into its real, human-confirmed
  // terminal state - same helper the automated loop uses. A "need_human" click
  // isn't a payment outcome, so the pending attempt is left exactly as it was.
  const paymentAttempts =
    response === "need_human"
      ? transaction.paymentAttempts
      : resolvePaymentAttempt(
          transaction.paymentAttempts,
          lastAttempt.attemptNumber,
          transaction.amount,
          outcome,
          lastAttempt.diagnosedReason
        );
  let updated: Transaction;

  if (response === "paid") {
    attempts[lastIndex] = { ...lastAttempt, outcome: "paid", respondedAt };
    updated = {
      ...transaction,
      status: "recovered",
      attempts,
      paymentAttempts,
      pendingResponseToken: undefined,
      nextEligibleAttemptDate: undefined,
    };
  } else if (response === "paid_elsewhere") {
    attempts[lastIndex] = { ...lastAttempt, outcome: "paid_elsewhere", respondedAt };
    updated = {
      ...transaction,
      status: "unrecovered",
      attempts,
      paymentAttempts,
      pendingResponseToken: undefined,
      nextEligibleAttemptDate: undefined,
    };
  } else if (response === "need_human") {
    // Customer explicitly asked for a person - escalate immediately, same
    // freeze as an automated escalation (lib/escalation-queue.ts).
    attempts[lastIndex] = {
      ...lastAttempt,
      outcome: "declined_again",
      respondedAt,
      escalationReasons: ["customer_requested_human"],
    };
    updated = {
      ...transaction,
      status: "escalated",
      attempts,
      paymentAttempts,
      pendingResponseToken: undefined,
      nextEligibleAttemptDate: undefined,
    };
  } else {
    attempts[lastIndex] = { ...lastAttempt, outcome: "declined_again", respondedAt };
    if (lastAttempt.attemptNumber >= config.maxTotalAttempts) {
      // Max attempts reached, discovered via a real customer's final response -
      // escalate, same as the automated loop's own retry-limit rule.
      attempts[lastIndex] = {
        ...attempts[lastIndex],
        escalationReasons: ["max_attempts_reached"],
      };
      updated = {
        ...transaction,
        status: "escalated",
        attempts,
        paymentAttempts,
        pendingResponseToken: undefined,
        nextEligibleAttemptDate: undefined,
      };
    } else {
      // At least the configured minimum gap before the next real email, even
      // for reasons that are "immediate" in the simulated flow - don't re-email
      // a real person seconds after they just said no.
      const delayHours = Math.max(
        RETRY_DELAY_HOURS[lastAttempt.diagnosedReason as RootCause] ?? 0,
        config.delayBetweenActionsHours,
        config.reminderCooldownHours
      );
      updated = {
        ...transaction,
        status: "in_progress",
        attempts,
        paymentAttempts,
        pendingResponseToken: undefined,
        nextEligibleAttemptDate: new Date(
          Date.now() + delayHours * 3600_000
        ).toISOString(),
      };
    }
  }

  transactions[index] = updated;
  await writeTransactions(transactions);
  await syncRecoveryCaseFor(updated);
  await syncEscalationEntryFor(updated);
  await syncPromiseToPayFor(updated);

  return { ok: true, message: "Thanks — your response has been recorded.", transaction: updated };
}
