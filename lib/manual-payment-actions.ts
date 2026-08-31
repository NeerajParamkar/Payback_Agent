// General-purpose admin payment actions - available for ANY transaction, not
// just ones sitting in the Human Escalation Queue (lib/escalation-actions.ts
// covers those, and reuses buildAdminAttempt from here). An admin's "mark
// recovered" or "record offline payment" is a first-class way of resolving an
// order through the same primitives the rest of the system uses (Payment
// Attempts), never a bypass of the data model.
//
// Trust boundary: nothing here is reachable from a customer-facing surface -
// every function requires an adminName and is only ever invoked from an
// admin-only API route. A customer's own claim of having paid (the "Yes I've
// paid" email button, or any future free-text channel) is NEVER routed
// through this module - see lib/agent.ts's handleEmailResponse, which stays
// a self-report the system doesn't treat as gateway-verified truth. Only
// these explicit admin actions - or a real Razorpay webhook - mark an order
// paid on anything but the customer's own say-so.

import { randomUUID } from "crypto";
import { releaseLock, tryAcquireLock } from "@/lib/agent-lock";
import { resolveEscalationForTransaction } from "@/lib/escalation-queue-store";
import { syncPromiseToPayFor } from "@/lib/promise-to-pay-store";
import { syncRecoveryCaseFor } from "@/lib/recovery-case-store";
import { updateTransaction } from "@/lib/transactions-store";
import type { PaymentAttempt, RecoveryAttempt, Transaction } from "@/lib/types";

const LOCK_BUSY_MESSAGE =
  "This transaction is currently being processed elsewhere; please try again in a moment.";

export type OfflinePaymentMethod = "cash" | "bank_transfer" | "other";

export interface RecordOfflinePaymentInput {
  transactionId: string;
  method: OfflinePaymentMethod;
  adminName: string;
  note?: string;
  amount?: number; // defaults to the transaction's own amount - set only for a partial/different verified amount
}

export interface MarkRecoveredInput {
  transactionId: string;
  adminName: string;
  note?: string;
}

export interface StopRecoveryInput {
  transactionId: string;
  adminName: string;
  note?: string;
}

export interface AdminActionResult {
  ok: boolean;
  message: string;
  transaction?: Transaction;
}

/**
 * Builds the audit-trail entry for a manual admin action - shares the same
 * RecoveryAttempt shape the AI-driven loop uses so the trail sheet's timeline
 * shows admin actions inline with everything else, honestly labeled as
 * "Manual admin action," never disguised as an AI decision.
 */
export function buildAdminAttempt(
  current: Pick<Transaction, "attempts">,
  actionTaken: string,
  actionDetail: string,
  outcome: "paid" | "no_response"
): RecoveryAttempt {
  const lastAttempt = current.attempts[current.attempts.length - 1];
  return {
    attemptNumber: current.attempts.length + 1,
    timestamp: new Date().toISOString(),
    diagnosedReason: lastAttempt?.diagnosedReason ?? "unknown",
    recommendedAction: "escalate_to_account_manager",
    actionTaken,
    actionDetail,
    outcome,
    confidence: "high",
    recoveryProbability: outcome === "paid" ? 1 : 0,
    priority: "low",
    diagnosisRationale: "Manual admin action - not an AI diagnosis.",
    decisionAction: "stop",
    policyOverridden: false,
    policyReason: "Manual admin action - not a Decision Engine output.",
  };
}

const METHOD_LABELS: Record<OfflinePaymentMethod, string> = {
  cash: "cash",
  bank_transfer: "bank transfer",
  other: "another offline method",
};

/**
 * Records a payment an admin has personally verified outside Razorpay (cash,
 * bank transfer, etc). This is explicitly NOT triggered by a customer's own
 * claim of having paid - only an admin submitting this action, after their
 * own verification, moves the order to PAID this way.
 */
export async function recordOfflinePayment(
  input: RecordOfflinePaymentInput
): Promise<AdminActionResult> {
  const adminName = input.adminName.trim() || "Admin";
  const now = new Date().toISOString();

  if (!tryAcquireLock(input.transactionId)) {
    return { ok: false, message: LOCK_BUSY_MESSAGE };
  }
  try {
    const updated = await updateTransaction(input.transactionId, (current) => {
      const paymentAttempt: PaymentAttempt = {
        id: randomUUID(),
        recoveryAttemptNumber: current.attempts.length + 1,
        status: "captured",
        amount: input.amount ?? current.amount,
        method: input.method,
        createdAt: now,
        updatedAt: now,
      };
      const detail =
        input.note ??
        `Offline payment recorded (${METHOD_LABELS[input.method]}), verified by ${adminName}.`;
      return {
        ...current,
        status: "recovered" as const,
        paymentAttempts: [...current.paymentAttempts, paymentAttempt],
        nextEligibleAttemptDate: undefined,
        pendingResponseToken: undefined,
        attempts: [
          ...current.attempts,
          buildAdminAttempt(current, "admin_recorded_offline_payment", detail, "paid"),
        ],
      };
    });

    if (!updated) {
      return { ok: false, message: `Transaction ${input.transactionId} not found.` };
    }

    await syncRecoveryCaseFor(updated);
    await syncPromiseToPayFor(updated);
    await resolveEscalationForTransaction(updated.id, {
      action: "offline_payment_recorded",
      note: input.note,
      resolvedBy: adminName,
      resolvedAt: now,
    });

    return {
      ok: true,
      message: `Offline payment recorded for ${updated.id}. Order marked PAID, recovery stopped.`,
      transaction: updated,
    };
  } finally {
    releaseLock(input.transactionId);
  }
}

/**
 * Admin directly confirms an order recovered - a lighter-weight sibling of
 * recordOfflinePayment for when there's no specific offline method to note
 * (e.g. confirmed via a channel outside this system entirely).
 */
export async function markPaymentRecovered(input: MarkRecoveredInput): Promise<AdminActionResult> {
  const adminName = input.adminName.trim() || "Admin";
  const now = new Date().toISOString();

  if (!tryAcquireLock(input.transactionId)) {
    return { ok: false, message: LOCK_BUSY_MESSAGE };
  }
  try {
    const updated = await updateTransaction(input.transactionId, (current) => {
      const paymentAttempt: PaymentAttempt = {
        id: randomUUID(),
        recoveryAttemptNumber: current.attempts.length + 1,
        status: "captured",
        amount: current.amount,
        method: "admin_confirmed",
        createdAt: now,
        updatedAt: now,
      };
      const detail = input.note ?? `Payment confirmed recovered by ${adminName}.`;
      return {
        ...current,
        status: "recovered" as const,
        paymentAttempts: [...current.paymentAttempts, paymentAttempt],
        nextEligibleAttemptDate: undefined,
        pendingResponseToken: undefined,
        attempts: [
          ...current.attempts,
          buildAdminAttempt(current, "admin_marked_recovered", detail, "paid"),
        ],
      };
    });

    if (!updated) {
      return { ok: false, message: `Transaction ${input.transactionId} not found.` };
    }

    await syncRecoveryCaseFor(updated);
    await syncPromiseToPayFor(updated);
    await resolveEscalationForTransaction(updated.id, {
      action: "marked_recovered",
      note: input.note,
      resolvedBy: adminName,
      resolvedAt: now,
    });

    return {
      ok: true,
      message: `${updated.id} marked recovered.`,
      transaction: updated,
    };
  } finally {
    releaseLock(input.transactionId);
  }
}

/** Admin stops recovery outright - no payment, just ends the case. */
export async function stopRecovery(input: StopRecoveryInput): Promise<AdminActionResult> {
  const adminName = input.adminName.trim() || "Admin";
  const now = new Date().toISOString();

  if (!tryAcquireLock(input.transactionId)) {
    return { ok: false, message: LOCK_BUSY_MESSAGE };
  }
  try {
    const updated = await updateTransaction(input.transactionId, (current) => ({
      ...current,
      status: "unrecovered" as const,
      nextEligibleAttemptDate: undefined,
      attempts: [
        ...current.attempts,
        buildAdminAttempt(
          current,
          "admin_stopped_recovery",
          input.note ?? `Recovery stopped by ${adminName}.`,
          "no_response"
        ),
      ],
    }));

    if (!updated) {
      return { ok: false, message: `Transaction ${input.transactionId} not found.` };
    }

    await syncRecoveryCaseFor(updated);
    await syncPromiseToPayFor(updated);
    await resolveEscalationForTransaction(updated.id, {
      action: "recovery_stopped",
      note: input.note,
      resolvedBy: adminName,
      resolvedAt: now,
    });

    return { ok: true, message: `Recovery stopped for ${updated.id}.`, transaction: updated };
  } finally {
    releaseLock(input.transactionId);
  }
}

export interface SetCustomerOptOutInput {
  transactionId: string;
  optedOut: boolean;
  adminName: string;
  note?: string;
}

/**
 * Sets (or clears) the customer's opt-out flag - the Recovery Decision Engine
 * (lib/recovery-decision-engine.ts, rule 3) reads this on the next diagnosis
 * cycle and forces "stop" once true, ending all further contact. Nothing else
 * in the app ever set this field before, leaving it permanently unreachable.
 */
export async function setCustomerOptOut(input: SetCustomerOptOutInput): Promise<AdminActionResult> {
  const adminName = input.adminName.trim() || "Admin";

  if (!tryAcquireLock(input.transactionId)) {
    return { ok: false, message: LOCK_BUSY_MESSAGE };
  }
  try {
    const updated = await updateTransaction(input.transactionId, (current) => ({
      ...current,
      customerOptedOut: input.optedOut,
      attempts: [
        ...current.attempts,
        buildAdminAttempt(
          current,
          input.optedOut ? "admin_recorded_opt_out" : "admin_recorded_opt_in",
          input.note ??
            (input.optedOut
              ? `Customer opted out of further contact (recorded by ${adminName}).`
              : `Customer opted back in to contact (recorded by ${adminName}).`),
          "no_response"
        ),
      ],
    }));

    if (!updated) {
      return { ok: false, message: `Transaction ${input.transactionId} not found.` };
    }

    await syncRecoveryCaseFor(updated);

    return {
      ok: true,
      message: input.optedOut
        ? `${updated.id} marked opted-out of further contact.`
        : `${updated.id} opted back in to contact.`,
      transaction: updated,
    };
  } finally {
    releaseLock(input.transactionId);
  }
}
