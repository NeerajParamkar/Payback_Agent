// Modular customer recovery-scoring service. RuleBasedCustomerScorer is the
// only implementation today - a future model-backed scorer only needs to
// implement the same CustomerScorer interface; callers only ever depend on
// getCustomerScorer(), never on this class directly.

import type { CustomerScoreFactor } from "@/lib/types";

export interface CustomerScoreInputs {
  paymentSuccessRate: number | null; // 0-1 - successfulTransactions / totalTransactions
  previousRecoverySuccessRate: number | null; // 0-1 - successfulRecoveryActions / previousRecoveryAttempts
  reminderResponseRate: number | null; // 0-1 - reminder attempts (SMS/WhatsApp/email) that ended in "paid"
  failedPaymentRate: number | null; // 0-1 - failedTransactions / totalTransactions (higher = worse)
  averagePaymentDelayHours: number | null; // order-creation -> paid, in hours (lower = better)
  paymentLinkConversionRate: number | null; // 0-1 - Payment Link attempts that ended up "captured"
  attemptsPerRecovery: number | null; // average attempts needed on orders that did recover (lower = better)
}

export interface CustomerScoreResult {
  score: number; // 0-100
  factors: CustomerScoreFactor[];
}

export interface CustomerScorer {
  readonly name: string;
  score(inputs: CustomerScoreInputs): CustomerScoreResult;
}

// Used whenever there isn't yet enough history for a factor - neither rewards
// nor penalizes a customer the system simply hasn't seen much of yet.
const NEUTRAL = 0.5;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// Past this many hours, additional delay no longer lowers the score further.
const MAX_SCORED_DELAY_HOURS = 72;
const MAX_ATTEMPTS = 3;

function normalizeRate(rate: number | null, invert = false): { value: number; hasData: boolean } {
  if (rate === null) return { value: NEUTRAL, hasData: false };
  const clamped = clamp01(rate);
  return { value: invert ? 1 - clamped : clamped, hasData: true };
}

function normalizeDelay(hours: number | null): { value: number; hasData: boolean } {
  if (hours === null) return { value: NEUTRAL, hasData: false };
  return { value: clamp01(1 - hours / MAX_SCORED_DELAY_HOURS), hasData: true };
}

function normalizeAttempts(attempts: number | null): { value: number; hasData: boolean } {
  if (attempts === null) return { value: NEUTRAL, hasData: false };
  // 1 attempt (best case) -> 1.0, MAX_ATTEMPTS (worst case that still recovers) -> 0.0
  return { value: clamp01((MAX_ATTEMPTS - attempts) / (MAX_ATTEMPTS - 1)), hasData: true };
}

// Weights sum to 1.0 - each one's share of the final 0-100 score. Tunable
// without touching normalization or the aggregation layer.
const WEIGHTS = {
  paymentSuccessRate: 0.25,
  previousRecoverySuccessRate: 0.2,
  reminderResponseRate: 0.1,
  failedPaymentRate: 0.15,
  averagePaymentDelayHours: 0.1,
  paymentLinkConversionRate: 0.15,
  attemptsPerRecovery: 0.05,
} as const;

class RuleBasedCustomerScorer implements CustomerScorer {
  readonly name = "rule-based-v1";

  score(inputs: CustomerScoreInputs): CustomerScoreResult {
    const normalized: Record<keyof typeof WEIGHTS, { value: number; hasData: boolean; label: string }> = {
      paymentSuccessRate: {
        ...normalizeRate(inputs.paymentSuccessRate),
        label: "Payment success rate",
      },
      previousRecoverySuccessRate: {
        ...normalizeRate(inputs.previousRecoverySuccessRate),
        label: "Previous recovery success",
      },
      reminderResponseRate: {
        ...normalizeRate(inputs.reminderResponseRate),
        label: "Response to reminders",
      },
      failedPaymentRate: {
        ...normalizeRate(inputs.failedPaymentRate, true),
        label: "Failed payment frequency",
      },
      averagePaymentDelayHours: {
        ...normalizeDelay(inputs.averagePaymentDelayHours),
        label: "Average payment delay",
      },
      paymentLinkConversionRate: {
        ...normalizeRate(inputs.paymentLinkConversionRate),
        label: "Payment-link conversion",
      },
      attemptsPerRecovery: {
        ...normalizeAttempts(inputs.attemptsPerRecovery),
        label: "Attempts required to recover",
      },
    };

    const factors: CustomerScoreFactor[] = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).map(
      (key) => {
        const { value, hasData, label } = normalized[key];
        const weight = WEIGHTS[key];
        return {
          key,
          label,
          value: Math.round(value * 100) / 100,
          weight,
          contribution: Math.round(value * weight * 100 * 10) / 10,
          hasData,
        };
      }
    );

    const score = Math.max(
      0,
      Math.min(100, Math.round(factors.reduce((sum, f) => sum + f.contribution, 0)))
    );

    return { score, factors };
  }
}

const ruleBasedCustomerScorer = new RuleBasedCustomerScorer();

/**
 * Single entry point callers use to get a scorer. Swapping in an ML-backed
 * implementation later means adding a class that implements CustomerScorer
 * and changing what this returns - lib/customer-recovery.ts and every caller
 * of it stay unchanged, since they only depend on the CustomerScoreResult shape.
 */
export function getCustomerScorer(): CustomerScorer {
  return ruleBasedCustomerScorer;
}
