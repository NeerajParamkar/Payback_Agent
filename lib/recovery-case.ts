// Pure, no server-only dependencies - derives a RecoveryCase (the ops-facing
// case-management view of an at-risk order) from the current Transaction state.
// Callers (route handlers) persist the result; nothing here touches storage.

import { isOrderPaid } from "@/lib/payment-attempts";
import type {
  RecoveryAttempt,
  RecoveryCase,
  RecoveryCaseStatus,
  RecoveryPriority,
  RecoveryStage,
  Transaction,
} from "@/lib/types";

// Above this amount, a stalled case gets bumped up in priority regardless of score.
const HIGH_VALUE_THRESHOLD = 5000;

const PRIORITY_RANK: Record<RecoveryPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function computeCaseId(transactionId: string): string {
  return `CASE-${transactionId.replace(/^TXN-/, "")}`;
}

function computeStatus(transaction: Transaction): RecoveryCaseStatus {
  const { status, attempts } = transaction;
  const lastAttempt = attempts[attempts.length - 1];

  if (status === "recovered") return "recovered";
  if (status === "waiting_for_response") return "awaiting_customer";
  if (status === "escalated") return "escalated"; // see lib/escalation-queue.ts
  if (status === "promise_to_pay") return "awaiting_promise"; // see lib/promise-to-pay.ts
  if (status === "in_progress") return "recovery_active";
  if (status === "unrecovered") {
    if (lastAttempt?.outcome === "paid_elsewhere") return "stopped";
    return "failed";
  }
  return "detected"; // status === "pending" - nothing has run yet
}

const TERMINAL_STATUSES: RecoveryCaseStatus[] = ["recovered", "stopped", "failed", "escalated"];

function computeStage(attemptCount: number, status: RecoveryCaseStatus): RecoveryStage {
  if (TERMINAL_STATUSES.includes(status)) return "resolved";
  if (attemptCount <= 0) return "new";
  if (attemptCount === 1) return "attempt_1";
  if (attemptCount === 2) return "attempt_2";
  return "attempt_3";
}

// Uses the AI's own recoveryProbability from its latest diagnosis (lib/diagnose.ts) -
// never transaction.trueFailureReason. The case must only ever see what the system
// itself believes, not the hidden simulation ground truth.
function computeProbability(lastAttempt: RecoveryAttempt | undefined): number {
  return lastAttempt?.recoveryProbability ?? 0.5; // not yet diagnosed - unknown
}

function computeScore(
  probability: number,
  attemptCount: number,
  status: RecoveryCaseStatus
): number {
  if (status === "recovered") return 100;
  if (status === "failed" || status === "stopped") return 0;
  const attemptPenalty = Math.max(attemptCount - 1, 0) * 10; // each escalation without success costs confidence
  return Math.max(0, Math.min(100, Math.round(probability * 100 - attemptPenalty)));
}

// Starts from the AI's own priority call (lib/diagnose.ts) and only ever escalates
// it further via deterministic business rules - a case-management override should
// never silently downgrade what the AI itself flagged.
function computePriority(
  amountAtRisk: number,
  score: number,
  status: RecoveryCaseStatus,
  aiPriority: RecoveryPriority | undefined
): RecoveryPriority {
  if (status === "escalated") return "critical";
  if (status === "recovered" || status === "stopped" || status === "failed") return "low";

  let priority: RecoveryPriority = aiPriority ?? "medium";
  if (
    amountAtRisk >= HIGH_VALUE_THRESHOLD &&
    score < 60 &&
    PRIORITY_RANK[priority] < PRIORITY_RANK.critical
  ) {
    priority = "critical";
  } else if (score < 40 && PRIORITY_RANK[priority] < PRIORITY_RANK.high) {
    priority = "high";
  }
  return priority;
}

function computeNextAction(
  transaction: Transaction,
  status: RecoveryCaseStatus
): { nextAction?: string; nextActionAt?: string } {
  if (status === "detected" || status === "analysing") {
    return { nextAction: "Run diagnosis" };
  }
  if (status === "recovery_active") {
    return {
      nextAction: `Escalate to attempt ${transaction.attempts.length + 1}`,
      ...(transaction.nextEligibleAttemptDate
        ? { nextActionAt: transaction.nextEligibleAttemptDate }
        : {}),
    };
  }
  if (status === "awaiting_customer") {
    return { nextAction: "Awaiting customer response" };
  }
  if (status === "escalated") {
    return { nextAction: "Awaiting human review" };
  }
  if (status === "awaiting_promise") {
    return {
      nextAction: "Awaiting promised payment",
      ...(transaction.nextEligibleAttemptDate
        ? { nextActionAt: transaction.nextEligibleAttemptDate }
        : {}),
    };
  }
  return {}; // terminal - nothing pending
}

/**
 * Derives a RecoveryCase snapshot from the current Transaction state - pure and
 * idempotent, callers persist the result. Returns null when no case should
 * exist: the order is already paid and no case was ever created for it -
 * nothing to recover, so nothing to create. See isOrderPaid in
 * lib/payment-attempts.ts, the same guard the agent loop checks before
 * starting a new recovery action - a case already open when an order becomes
 * paid is still updated to "recovered" below, never dropped.
 */
export function deriveRecoveryCase(
  transaction: Transaction,
  existing: RecoveryCase | undefined
): RecoveryCase | null {
  const paid = isOrderPaid(transaction);
  if (paid && !existing) return null;

  const now = new Date().toISOString();
  const status: RecoveryCaseStatus = paid ? "recovered" : computeStatus(transaction);
  const attemptCount = transaction.attempts.length;
  const lastAttempt = transaction.attempts[attemptCount - 1];
  const stage = computeStage(attemptCount, status);
  const probability = paid ? 1 : computeProbability(lastAttempt);
  const score = computeScore(probability, attemptCount, status);
  const priority = computePriority(transaction.amount, score, status, lastAttempt?.priority);
  const { nextAction, nextActionAt } = paid ? {} : computeNextAction(transaction, status);

  return {
    id: existing?.id ?? computeCaseId(transaction.id),
    transactionId: transaction.id,
    customerName: transaction.customerName,
    ...(transaction.customerEmail ? { customerEmail: transaction.customerEmail } : {}),
    amountAtRisk: transaction.amount,
    status,
    ...(lastAttempt ? { rootCause: lastAttempt.diagnosedReason } : {}),
    recoveryScore: score,
    recoveryProbability: probability,
    priority,
    stage,
    ...(nextAction ? { nextAction } : {}),
    ...(nextActionAt ? { nextActionAt } : {}),
    attemptCount,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * Marks a case as actively being worked this run, without recomputing anything
 * else - called right before the agent processes a still-undiagnosed case, so
 * "analysing" reflects a case picked up this run rather than one merely
 * sitting detected.
 */
export function markCaseAnalysing(recoveryCase: RecoveryCase): RecoveryCase {
  if (recoveryCase.status !== "detected") return recoveryCase;
  return { ...recoveryCase, status: "analysing", updatedAt: new Date().toISOString() };
}

/**
 * Applies deriveRecoveryCase across a batch of transactions against the
 * current cases list - cases for transactions not in this batch are left
 * untouched, so a selective run never disturbs cases outside its scope.
 */
export function upsertRecoveryCases(
  existingCases: RecoveryCase[],
  transactions: Transaction[]
): RecoveryCase[] {
  const byTransactionId = new Map(existingCases.map((c) => [c.transactionId, c]));
  for (const transaction of transactions) {
    const derived = deriveRecoveryCase(transaction, byTransactionId.get(transaction.id));
    if (derived) byTransactionId.set(transaction.id, derived);
  }
  return Array.from(byTransactionId.values());
}
