// Pure, no server-only dependencies - aggregates Transaction history into one
// CustomerRecoveryProfile per customer. Nothing here is persisted separately;
// every field is derived fresh from transactions.json at read time, so there's
// no separate store that can drift out of sync with it.

import { getCustomerScorer } from "@/lib/customer-scoring";
import { isOrderPaid } from "@/lib/payment-attempts";
import type { CustomerRecoveryProfile, RecoveryAction, Transaction } from "@/lib/types";

const REMINDER_ACTIONS: RecoveryAction[] = [
  "send_sms_reminder",
  "send_whatsapp_reminder",
  "send_email_reminder",
];

/**
 * Canonical identity for grouping transactions by customer. Composite of name
 * and email (not email alone) - this dataset's real-customer transactions
 * currently share one placeholder email address, so keying on email alone
 * would wrongly merge different people. Composite still lets a genuine repeat
 * customer (same name AND same email) aggregate correctly.
 */
export function customerIdentityKey(
  transaction: Pick<Transaction, "customerName" | "customerEmail">
): string {
  const name = transaction.customerName.trim().toLowerCase();
  const email = transaction.customerEmail?.trim().toLowerCase();
  return email ? `${name}::${email}` : name;
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

function buildProfile(customerId: string, transactions: Transaction[]): CustomerRecoveryProfile {
  const latest = [...transactions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!;

  const totalTransactions = transactions.length;
  const successfulTransactions = transactions.filter((t) => isOrderPaid(t)).length;
  const failedTransactions = transactions.filter((t) => t.status === "unrecovered").length;
  const totalAmount = transactions.reduce((sum, t) => sum + t.amount, 0);
  const amountRecovered = transactions
    .filter((t) => isOrderPaid(t))
    .reduce((sum, t) => sum + t.amount, 0);
  const amountAtRisk = transactions
    .filter((t) => !isOrderPaid(t) && t.status !== "unrecovered")
    .reduce((sum, t) => sum + t.amount, 0);

  const allAttempts = transactions.flatMap((t) => t.attempts);
  const previousRecoveryAttempts = allAttempts.length;
  const successfulRecoveryActions = allAttempts.filter((a) => a.outcome === "paid").length;
  const failedRecoveryActions = allAttempts.filter(
    (a) => a.outcome === "declined_again" || a.outcome === "no_response"
  ).length;

  // Order-creation -> actually paid, averaged over this customer's recovered orders.
  const paymentDelaysHours = transactions
    .filter((t) => isOrderPaid(t))
    .map((t) => {
      const paidAttempt = t.attempts.find((a) => a.outcome === "paid");
      const resolvedAt = paidAttempt?.respondedAt ?? paidAttempt?.timestamp;
      if (!resolvedAt) return null;
      const hours = (new Date(resolvedAt).getTime() - new Date(t.createdAt).getTime()) / 3600_000;
      return hours >= 0 ? hours : null;
    })
    .filter((v): v is number => v !== null);
  const averagePaymentDelayHours = average(paymentDelaysHours);

  // Whichever action type most often actually produced a "paid" outcome for
  // this customer - the channel worth leading with next time.
  const successByChannel = new Map<string, number>();
  for (const attempt of allAttempts) {
    if (attempt.outcome === "paid") {
      successByChannel.set(attempt.actionTaken, (successByChannel.get(attempt.actionTaken) ?? 0) + 1);
    }
  }
  let preferredRecoveryChannel: string | null = null;
  let bestCount = 0;
  for (const [channel, count] of successByChannel) {
    if (count > bestCount) {
      preferredRecoveryChannel = channel;
      bestCount = count;
    }
  }

  const reminderAttempts = allAttempts.filter((a) =>
    REMINDER_ACTIONS.includes(a.recommendedAction as RecoveryAction)
  );
  const reminderResponseRate =
    reminderAttempts.length > 0
      ? reminderAttempts.filter((a) => a.outcome === "paid").length / reminderAttempts.length
      : null;

  const paymentLinkAttempts = transactions
    .flatMap((t) => t.paymentAttempts)
    .filter((p) => p.paymentLinkId);
  const paymentLinkConversionRate =
    paymentLinkAttempts.length > 0
      ? paymentLinkAttempts.filter((p) => p.status === "captured").length / paymentLinkAttempts.length
      : null;

  const attemptsPerRecovery = average(
    transactions.filter((t) => isOrderPaid(t)).map((t) => t.attempts.length)
  );

  const scoreResult = getCustomerScorer().score({
    paymentSuccessRate: totalTransactions > 0 ? successfulTransactions / totalTransactions : null,
    previousRecoverySuccessRate:
      previousRecoveryAttempts > 0 ? successfulRecoveryActions / previousRecoveryAttempts : null,
    reminderResponseRate,
    failedPaymentRate: totalTransactions > 0 ? failedTransactions / totalTransactions : null,
    averagePaymentDelayHours,
    paymentLinkConversionRate,
    attemptsPerRecovery,
  });

  return {
    customerId,
    customerName: latest.customerName,
    ...(latest.customerEmail ? { customerEmail: latest.customerEmail } : {}),
    totalTransactions,
    successfulTransactions,
    failedTransactions,
    totalAmount,
    amountRecovered,
    amountAtRisk,
    averagePaymentDelayHours,
    previousRecoveryAttempts,
    successfulRecoveryActions,
    failedRecoveryActions,
    preferredRecoveryChannel,
    recoveryScore: scoreResult.score,
    scoreBreakdown: scoreResult.factors,
  };
}

export function buildCustomerRecoveryProfiles(
  transactions: Transaction[]
): CustomerRecoveryProfile[] {
  const groups = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    const key = customerIdentityKey(transaction);
    const list = groups.get(key) ?? [];
    list.push(transaction);
    groups.set(key, list);
  }

  return Array.from(groups.entries()).map(([customerId, customerTransactions]) =>
    buildProfile(customerId, customerTransactions)
  );
}
