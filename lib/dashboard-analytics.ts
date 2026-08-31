// Pure, no server-only dependencies - aggregates the whole system's state into
// the Revenue Recovery Admin Dashboard's metrics, funnel, and breakdowns.
// Everything here is computed fresh from Transaction/RecoveryCase/EscalationQueue
// data, the same "derive, don't duplicate" pattern as customer-recovery.ts and
// recovery-case.ts - no separate persisted store, nothing to keep in sync.

import { buildCustomerRecoveryProfiles } from "@/lib/customer-recovery";
import { humanize } from "@/lib/format";
import { isOrderPaid } from "@/lib/payment-attempts";
import type {
  CustomerRecoveryProfile,
  EscalationQueueEntry,
  RecoveryAttempt,
  RecoveryCase,
  Transaction,
} from "@/lib/types";

export interface DashboardMoneyMetrics {
  revenueAtRisk: number; // total amount across every transaction in the book
  revenueRecovered: number;
  revenueUnrecovered: number; // permanently given up (status "unrecovered")
  recoveryRate: number; // 0-100, revenueRecovered / revenueAtRisk
  activeRecoveryCases: number; // RecoveryCase count, excluding terminal AND escalated (tracked separately)
  humanEscalations: number; // EscalationQueueEntry count not yet resolved
  aiAttributedRevenueRecovered: number; // recovered where the resolving action wasn't an admin_* one
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  amount?: number;
}

export interface RateBreakdown {
  key: string;
  label: string;
  denominator: number;
  numerator: number;
  rate: number; // 0-1, 0 when denominator is 0
}

export interface DashboardAnalytics {
  money: DashboardMoneyMetrics;
  funnel: FunnelStage[];
  byRootCause: RateBreakdown[];
  byChannel: RateBreakdown[];
  byCustomerSegment: RateBreakdown[];
  byAmountTier: RateBreakdown[];
  byTimeOfDay: RateBreakdown[];
  byAttemptNumber: RateBreakdown[];
  humanEscalationRate: number; // 0-1
  recoverySuccessRate: number; // 0-1, recovered / (recovered + unrecovered)
  topCustomers: CustomerRecoveryProfile[];
}

const CONTACT_ACTIONS = new Set([
  "sent_email_reminder",
  "sent_reminder",
  "generated_payment_link",
  "resent_payment_link",
]);

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function buildMoneyMetrics(
  transactions: Transaction[],
  recoveryCases: RecoveryCase[],
  escalationEntries: EscalationQueueEntry[]
): DashboardMoneyMetrics {
  const revenueAtRisk = transactions.reduce((sum, t) => sum + t.amount, 0);
  const recovered = transactions.filter((t) => t.status === "recovered");
  const revenueRecovered = recovered.reduce((sum, t) => sum + t.amount, 0);
  const revenueUnrecovered = transactions
    .filter((t) => t.status === "unrecovered")
    .reduce((sum, t) => sum + t.amount, 0);

  const aiAttributedRevenueRecovered = recovered
    .filter((t) => {
      const last = t.attempts[t.attempts.length - 1];
      return !last?.actionTaken.startsWith("admin_");
    })
    .reduce((sum, t) => sum + t.amount, 0);

  const activeRecoveryCases = recoveryCases.filter(
    (c) => !["recovered", "escalated", "stopped", "failed"].includes(c.status)
  ).length;
  const humanEscalations = escalationEntries.filter((e) => e.status !== "resolved").length;

  return {
    revenueAtRisk,
    revenueRecovered,
    revenueUnrecovered,
    recoveryRate: Math.round(rate(revenueRecovered, revenueAtRisk) * 1000) / 10,
    activeRecoveryCases,
    humanEscalations,
    aiAttributedRevenueRecovered,
  };
}

function buildFunnel(transactions: Transaction[], recoveryCases: RecoveryCase[]): FunnelStage[] {
  const failedPayments = transactions.length;
  const revenueAtRiskAmount = transactions.reduce((sum, t) => sum + t.amount, 0);
  const customersContacted = transactions.filter((t) =>
    t.attempts.some((a) => CONTACT_ACTIONS.has(a.actionTaken))
  ).length;
  const paymentLinks = transactions.filter((t) => t.paymentAttempts.some((p) => p.paymentLinkId)).length;
  const successful = transactions.filter((t) => t.status === "recovered");
  const revenueRecoveredAmount = successful.reduce((sum, t) => sum + t.amount, 0);

  return [
    { key: "failed_payments", label: "Failed Payments", count: failedPayments },
    { key: "revenue_at_risk", label: "Revenue at Risk", count: failedPayments, amount: revenueAtRiskAmount },
    { key: "recovery_cases", label: "Recovery Cases", count: recoveryCases.length },
    { key: "customers_contacted", label: "Customers Contacted", count: customersContacted },
    { key: "payment_links", label: "Payment Links", count: paymentLinks },
    { key: "successful_payments", label: "Successful Payments", count: successful.length },
    { key: "revenue_recovered", label: "Revenue Recovered", count: successful.length, amount: revenueRecoveredAmount },
  ];
}

function allAttempts(transactions: Transaction[]): RecoveryAttempt[] {
  return transactions.flatMap((t) => t.attempts);
}

function byKey<T>(
  items: T[],
  keyOf: (item: T) => string,
  isSuccess: (item: T) => boolean
): RateBreakdown[] {
  const buckets = new Map<string, { total: number; success: number }>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key) ?? { total: 0, success: 0 };
    bucket.total += 1;
    if (isSuccess(item)) bucket.success += 1;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries())
    .map(([key, { total, success }]) => ({
      key,
      label: humanize(key),
      denominator: total,
      numerator: success,
      rate: rate(success, total),
    }))
    .sort((a, b) => b.rate - a.rate);
}

const CHANNEL_BY_DECISION: Record<string, string> = {
  generate_payment_link: "payment_link",
  retry: "payment_link",
  send_email: "email",
  send_reminder: "reminder",
  escalate_to_human: "escalation",
};

function buildByChannel(attempts: RecoveryAttempt[]): RateBreakdown[] {
  const channeled = attempts.filter((a) => a.decisionAction in CHANNEL_BY_DECISION);
  return byKey(
    channeled,
    (a) => CHANNEL_BY_DECISION[a.decisionAction],
    (a) => a.outcome === "paid"
  );
}

const AMOUNT_TIERS: Array<{ key: string; label: string; min: number; max: number }> = [
  { key: "under_2000", label: "Under ₹2,000", min: 0, max: 2000 },
  { key: "2000_5000", label: "₹2,000 - ₹5,000", min: 2000, max: 5000 },
  { key: "5000_10000", label: "₹5,000 - ₹10,000", min: 5000, max: 10000 },
  { key: "10000_plus", label: "₹10,000+", min: 10000, max: Infinity },
];

function buildByAmountTier(transactions: Transaction[]): RateBreakdown[] {
  return AMOUNT_TIERS.map((tier) => {
    const inTier = transactions.filter((t) => t.amount >= tier.min && t.amount < tier.max);
    const recovered = inTier.filter((t) => isOrderPaid(t));
    return {
      key: tier.key,
      label: tier.label,
      denominator: inTier.length,
      numerator: recovered.length,
      rate: rate(recovered.length, inTier.length),
    };
  }).filter((t) => t.denominator > 0);
}

const TIME_OF_DAY_BUCKETS: Array<{ key: string; label: string; startHour: number; endHour: number }> = [
  { key: "night", label: "Night (12am-6am)", startHour: 0, endHour: 6 },
  { key: "morning", label: "Morning (6am-12pm)", startHour: 6, endHour: 12 },
  { key: "afternoon", label: "Afternoon (12pm-6pm)", startHour: 12, endHour: 18 },
  { key: "evening", label: "Evening (6pm-12am)", startHour: 18, endHour: 24 },
];

function buildByTimeOfDay(attempts: RecoveryAttempt[]): RateBreakdown[] {
  return TIME_OF_DAY_BUCKETS.map((bucket) => {
    const inBucket = attempts.filter((a) => {
      const hour = new Date(a.timestamp).getHours();
      return hour >= bucket.startHour && hour < bucket.endHour;
    });
    const paid = inBucket.filter((a) => a.outcome === "paid");
    return {
      key: bucket.key,
      label: bucket.label,
      denominator: inBucket.length,
      numerator: paid.length,
      rate: rate(paid.length, inBucket.length),
    };
  }).filter((b) => b.denominator > 0);
}

function buildByAttemptNumber(attempts: RecoveryAttempt[]): RateBreakdown[] {
  return byKey(
    attempts,
    (a) => `Attempt ${a.attemptNumber}`,
    (a) => a.outcome === "paid"
  )
    .map((b) => ({ ...b, key: b.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

const SEGMENT_TIERS: Array<{ key: string; label: string; min: number; max: number }> = [
  { key: "high", label: "High score (70-100)", min: 70, max: 101 },
  { key: "medium", label: "Medium score (40-69)", min: 40, max: 70 },
  { key: "low", label: "Low score (0-39)", min: 0, max: 40 },
];

function buildByCustomerSegment(profiles: CustomerRecoveryProfile[]): RateBreakdown[] {
  return SEGMENT_TIERS.map((tier) => {
    const inTier = profiles.filter((p) => p.recoveryScore >= tier.min && p.recoveryScore < tier.max);
    const totalAmount = inTier.reduce((sum, p) => sum + p.totalAmount, 0);
    const recoveredAmount = inTier.reduce((sum, p) => sum + p.amountRecovered, 0);
    return {
      key: tier.key,
      label: tier.label,
      denominator: totalAmount,
      numerator: recoveredAmount,
      rate: rate(recoveredAmount, totalAmount),
    };
  }).filter((t) => t.denominator > 0);
}

export function buildDashboardAnalytics(
  transactions: Transaction[],
  recoveryCases: RecoveryCase[],
  escalationEntries: EscalationQueueEntry[]
): DashboardAnalytics {
  const attempts = allAttempts(transactions);
  const profiles = buildCustomerRecoveryProfiles(transactions);

  const transactionsWithAttempts = transactions.filter((t) => t.attempts.length > 0);
  const everEscalated = transactionsWithAttempts.filter((t) =>
    t.attempts.some((a) => a.decisionAction === "escalate_to_human")
  ).length;

  const recoveredCount = transactions.filter((t) => t.status === "recovered").length;
  const unrecoveredCount = transactions.filter((t) => t.status === "unrecovered").length;

  return {
    money: buildMoneyMetrics(transactions, recoveryCases, escalationEntries),
    funnel: buildFunnel(transactions, recoveryCases),
    byRootCause: byKey(
      attempts,
      (a) => a.diagnosedReason,
      (a) => a.outcome === "paid"
    ),
    byChannel: buildByChannel(attempts),
    byCustomerSegment: buildByCustomerSegment(profiles),
    byAmountTier: buildByAmountTier(transactions),
    byTimeOfDay: buildByTimeOfDay(attempts),
    byAttemptNumber: buildByAttemptNumber(attempts),
    humanEscalationRate: rate(everEscalated, transactionsWithAttempts.length),
    recoverySuccessRate: rate(recoveredCount, recoveredCount + unrecoveredCount),
    topCustomers: profiles
      .slice()
      .sort((a, b) => b.amountAtRisk - a.amountAtRisk)
      .slice(0, 5),
  };
}
