// Admin actions on the Human Escalation Queue (lib/escalation-queue.ts). Kept
// as its own module so the write-side (what an admin can DO) is separate from
// the read-side derivation (lib/escalation-queue.ts) and from the automated
// workflow (lib/agent.ts) that puts cases into the queue in the first place.
//
// Every action here operates directly on the transaction through the same
// primitives the rest of the system uses (Payment Attempts, the real Razorpay
// integration, Brevo email) - an admin's "mark recovered" is not a shortcut
// that bypasses the data model, it's a first-class way of resolving an order.
// "take_ownership" is the one action that does NOT touch the transaction -
// it's queue-only bookkeeping.

import { randomUUID } from "crypto";
import { releaseLock, tryAcquireLock } from "@/lib/agent-lock";
import { sendConfirmationEmail } from "@/lib/email";
import { readEscalationQueue, writeEscalationQueue } from "@/lib/escalation-queue-store";
import { buildAdminAttempt } from "@/lib/manual-payment-actions";
import { createRecoveryPaymentLink } from "@/lib/razorpay";
import { syncPromiseToPayFor } from "@/lib/promise-to-pay-store";
import { syncRecoveryCaseFor } from "@/lib/recovery-case-store";
import { getRecoveryWorkflowConfig } from "@/lib/recovery-workflow-config";
import { getTransaction, updateTransaction } from "@/lib/transactions-store";
import type {
  EscalationQueueEntry,
  EscalationResolutionAction,
  PaymentAttempt,
  Transaction,
} from "@/lib/types";

export type EscalationAdminAction =
  | "resolve"
  | "stop_recovery"
  | "mark_recovered"
  | "record_offline_payment"
  | "send_payment_link"
  | "take_ownership";

export interface EscalationActionInput {
  entryId: string;
  action: EscalationAdminAction;
  adminName: string; // no auth system in this app - the admin's own typed name/identifier
  note?: string;
}

export interface EscalationActionResult {
  ok: boolean;
  message: string;
  entry?: EscalationQueueEntry;
  transaction?: Transaction;
}

async function writeEntry(
  entries: EscalationQueueEntry[],
  updated: EscalationQueueEntry
): Promise<void> {
  await writeEscalationQueue([
    ...entries.filter((e) => e.id !== updated.id),
    updated,
  ]);
}

export async function performEscalationAction(
  input: EscalationActionInput
): Promise<EscalationActionResult> {
  const entries = await readEscalationQueue();
  const entry = entries.find((e) => e.id === input.entryId);
  if (!entry) {
    return { ok: false, message: `Escalation entry ${input.entryId} not found.` };
  }
  const adminName = input.adminName.trim() || "Admin";
  const now = new Date().toISOString();

  if (input.action === "take_ownership") {
    const updatedEntry: EscalationQueueEntry = {
      ...entry,
      status: entry.status === "resolved" ? entry.status : "owned",
      ownedBy: adminName,
      ownedAt: now,
      updatedAt: now,
    };
    await writeEntry(entries, updatedEntry);
    return { ok: true, message: `${adminName} took ownership of ${entry.id}.`, entry: updatedEntry };
  }

  // Every remaining action mutates the transaction itself, racing the same
  // per-order lock the agent loop, webhook processing, and email responses all
  // respect (lib/agent-lock.ts) - acquired here so an admin action can never
  // silently lose an update to (or clobber) one of those.
  if (!tryAcquireLock(entry.transactionId)) {
    return {
      ok: false,
      message: "This transaction is currently being processed elsewhere; please try again in a moment.",
    };
  }

  try {
    if (input.action === "send_payment_link") {
      const transactionBefore = await getTransaction(entry.transactionId);
      if (!transactionBefore) {
        return { ok: false, message: `Transaction ${entry.transactionId} not found.` };
      }

      const link = await createRecoveryPaymentLink({
        transactionId: transactionBefore.id,
        amount: transactionBefore.amount,
        reason: transactionBefore.attempts[transactionBefore.attempts.length - 1]?.diagnosedReason ?? "unknown",
        attemptNumber: transactionBefore.attempts.length + 1,
        customerName: transactionBefore.customerName,
        customerEmail: transactionBefore.customerEmail,
        customerPhone: transactionBefore.customerPhone,
      });

      const newPaymentAttempt: PaymentAttempt = {
        id: randomUUID(),
        recoveryAttemptNumber: transactionBefore.attempts.length + 1,
        status: "created",
        amount: transactionBefore.amount,
        paymentLinkId: link.paymentLinkId,
        createdAt: now,
        updatedAt: now,
      };
      const detail = `Account manager sent a new Payment Link: ${link.paymentLinkUrl}`;

      const updatedTransaction = await updateTransaction(entry.transactionId, (current) => ({
        ...current,
        paymentAttempts: [...current.paymentAttempts, newPaymentAttempt],
        attempts: [
          ...current.attempts,
          buildAdminAttempt(current, "admin_sent_payment_link", detail, "no_response"),
        ],
      }));
      if (!updatedTransaction) {
        return { ok: false, message: `Transaction ${entry.transactionId} disappeared mid-update.` };
      }

      if (updatedTransaction.customerEmail) {
        const token = randomUUID();
        const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
        await sendConfirmationEmail({
          toEmail: updatedTransaction.customerEmail,
          toName: updatedTransaction.customerName,
          transactionId: updatedTransaction.id,
          amount: updatedTransaction.amount,
          message: `An account manager has sent you a secure link to complete your payment of ₹${updatedTransaction.amount}. ${link.paymentLinkUrl}`,
          paidUrl: `${baseUrl}/confirm?t=${updatedTransaction.id}&r=paid&token=${token}`,
          notPaidUrl: `${baseUrl}/confirm?t=${updatedTransaction.id}&r=not_paid&token=${token}`,
          paidElsewhereUrl: `${baseUrl}/confirm?t=${updatedTransaction.id}&r=paid_elsewhere&token=${token}`,
        });
      }

      const updatedEntry: EscalationQueueEntry = { ...entry, updatedAt: now };
      await writeEntry(entries, updatedEntry);
      return {
        ok: true,
        message: `Payment link sent for ${updatedTransaction.id}.`,
        entry: updatedEntry,
        transaction: updatedTransaction,
      };
    }

    // resolve / stop_recovery / mark_recovered / record_offline_payment - all
    // mutate the transaction AND resolve the queue entry.
    const config = getRecoveryWorkflowConfig();
    let resolutionAction: EscalationResolutionAction = "resolved";

    const updatedTransaction = await updateTransaction(entry.transactionId, (current) => {
      if (input.action === "stop_recovery") {
        resolutionAction = "recovery_stopped";
        return {
          ...current,
          status: "unrecovered" as const,
          nextEligibleAttemptDate: undefined,
          attempts: [
            ...current.attempts,
            buildAdminAttempt(
              current,
              "admin_stopped_recovery",
              input.note ?? "Recovery stopped by an admin.",
              "no_response"
            ),
          ],
        };
      }

      if (input.action === "mark_recovered" || input.action === "record_offline_payment") {
        resolutionAction =
          input.action === "mark_recovered" ? "marked_recovered" : "offline_payment_recorded";
        const method = input.action === "record_offline_payment" ? "offline" : "admin_confirmed";
        const newPaymentAttempt: PaymentAttempt = {
          id: randomUUID(),
          recoveryAttemptNumber: current.attempts.length + 1,
          status: "captured",
          amount: current.amount,
          method,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const detail =
          input.note ??
          (input.action === "record_offline_payment"
            ? "Payment recorded as collected offline (cash/bank transfer/etc)."
            : "Payment confirmed recovered by an admin.");
        return {
          ...current,
          status: "recovered" as const,
          paymentAttempts: [...current.paymentAttempts, newPaymentAttempt],
          nextEligibleAttemptDate: undefined,
          attempts: [
            ...current.attempts,
            buildAdminAttempt(
              current,
              input.action === "record_offline_payment" ? "admin_recorded_offline_payment" : "admin_marked_recovered",
              detail,
              "paid"
            ),
          ],
        };
      }

      // "resolve" - hand back to automation if attempts remain, otherwise close it out.
      resolutionAction = "resolved";
      const stillHasBudget = current.attempts.length < config.maxTotalAttempts;
      return {
        ...current,
        status: stillHasBudget ? ("in_progress" as const) : ("unrecovered" as const),
        nextEligibleAttemptDate: undefined,
        attempts: [
          ...current.attempts,
          buildAdminAttempt(
            current,
            "admin_resolved",
            input.note ?? "Reviewed and resolved by an admin.",
            "no_response"
          ),
        ],
      };
    });

    if (!updatedTransaction) {
      return { ok: false, message: `Transaction ${entry.transactionId} not found.` };
    }

    await syncRecoveryCaseFor(updatedTransaction);
    await syncPromiseToPayFor(updatedTransaction);

    const updatedEntry: EscalationQueueEntry = {
      ...entry,
      status: "resolved",
      resolution: {
        action: resolutionAction,
        note: input.note,
        resolvedBy: adminName,
        resolvedAt: now,
      },
      updatedAt: now,
    };
    await writeEntry(entries, updatedEntry);

    return {
      ok: true,
      message: `${entry.id} resolved (${resolutionAction}).`,
      entry: updatedEntry,
      transaction: updatedTransaction,
    };
  } finally {
    releaseLock(entry.transactionId);
  }
}
