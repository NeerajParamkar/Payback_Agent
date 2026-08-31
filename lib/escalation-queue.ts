// Pure, no server-only dependencies - derives the Human Escalation Queue's
// entries from Transaction state. An entry exists only for orders currently
// or previously escalated (transaction.status === "escalated" right now, or
// an admin has since resolved it and the record is kept as history). The full
// recovery timeline, previous actions, and customer responses the queue must
// show are Transaction.attempts itself - not duplicated here, fetched
// alongside an entry by transactionId, the same pattern as RecoveryCase.

import type {
  EscalationQueueEntry,
  EscalationQueueStatus,
  EscalationReason,
  RecoveryAttempt,
  Transaction,
} from "@/lib/types";

function computeEscalationId(transactionId: string): string {
  return `ESC-${transactionId.replace(/^TXN-/, "")}`;
}

/**
 * Builds the synthetic RecoveryAttempt that freezes an order for human review
 * outside the normal diagnose/decide loop - used wherever an anomaly is
 * detected directly (a webhook event, a manually reported flag) rather than
 * via the Decision Engine's own escalate_to_human output. Mirrors exactly
 * what lib/agent.ts records when the Decision Engine escalates: nothing
 * simulated, nothing sent, just an honest note of why this needs a human.
 */
export function buildEscalationAttempt(
  transaction: Pick<Transaction, "attempts">,
  detail: string,
  escalationReasons: EscalationReason[]
): RecoveryAttempt {
  const lastAttempt = transaction.attempts[transaction.attempts.length - 1];
  return {
    attemptNumber: (lastAttempt?.attemptNumber ?? 0) + 1,
    timestamp: new Date().toISOString(),
    diagnosedReason: lastAttempt?.diagnosedReason ?? "unknown",
    recommendedAction: "escalate_to_account_manager",
    actionTaken: "escalated_to_human",
    actionDetail: detail,
    outcome: "no_response",
    confidence: "high",
    recoveryProbability: 0,
    priority: "critical",
    diagnosisRationale: detail,
    decisionAction: "escalate_to_human",
    policyOverridden: false,
    policyReason: detail,
    escalationReasons,
  };
}

/**
 * Derives (or refreshes) the escalation queue entry for one transaction.
 * - Not currently escalated and no entry ever existed -> null, nothing to show.
 * - Not currently escalated but an entry already exists -> returned untouched;
 *   an admin action (resolve/stop/mark-recovered) is what moved the order out
 *   of "escalated," and that same action already updated the entry itself -
 *   this function must never re-derive over an admin's resolution.
 * - Currently escalated -> entry created (status "open") or refreshed with
 *   the latest reasons/score, while ownership and any resolution already on
 *   the entry are always preserved.
 */
export function deriveEscalationEntry(
  transaction: Transaction,
  existing: EscalationQueueEntry | undefined
): EscalationQueueEntry | null {
  if (transaction.status !== "escalated") {
    return existing ?? null;
  }

  const now = new Date().toISOString();
  const lastAttempt = transaction.attempts[transaction.attempts.length - 1];
  const freshReasons = lastAttempt?.escalationReasons ?? [];
  const probability = lastAttempt?.recoveryProbability ?? 0.5;
  const status: EscalationQueueStatus = existing?.status ?? "open";

  return {
    id: existing?.id ?? computeEscalationId(transaction.id),
    transactionId: transaction.id,
    customerName: transaction.customerName,
    ...(transaction.customerEmail ? { customerEmail: transaction.customerEmail } : {}),
    amount: transaction.amount,
    ...(lastAttempt ? { rootCause: lastAttempt.diagnosedReason } : {}),
    recoveryScore: Math.round(probability * 100),
    recoveryProbability: probability,
    reasons: freshReasons.length > 0 ? freshReasons : (existing?.reasons ?? []),
    status,
    ...(existing?.ownedBy ? { ownedBy: existing.ownedBy } : {}),
    ...(existing?.ownedAt ? { ownedAt: existing.ownedAt } : {}),
    ...(existing?.resolution ? { resolution: existing.resolution } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * Applies deriveEscalationEntry across a batch of transactions against the
 * current queue - entries for transactions not in this batch are left
 * untouched, so a selective run never disturbs entries outside its scope.
 */
export function upsertEscalationEntries(
  existingEntries: EscalationQueueEntry[],
  transactions: Transaction[]
): EscalationQueueEntry[] {
  const byTransactionId = new Map(existingEntries.map((e) => [e.transactionId, e]));
  for (const transaction of transactions) {
    const derived = deriveEscalationEntry(transaction, byTransactionId.get(transaction.id));
    if (derived) byTransactionId.set(transaction.id, derived);
  }
  return Array.from(byTransactionId.values());
}
