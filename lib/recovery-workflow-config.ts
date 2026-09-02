// The bounded recovery workflow's tunable knobs. Genuinely configurable via
// environment variables (read fresh on every call, sensible defaults if unset)
// rather than hardcoded constants - change .env.local, no code edit needed.

export interface RecoveryWorkflowConfig {
  maxTotalAttempts: number; // overall ceiling on recovery attempts for one order
  reminderCooldownHours: number; // minimum gap enforced specifically between two reminder-type actions
  maxReminders: number; // cap on total reminder-type actions (send_email/send_reminder) per order
  maxPaymentRetries: number; // cap on total generate_payment_link actions per order
  delayBetweenActionsHours: number; // minimum gap enforced between ANY two actions, whatever their type -
  // the workflow never fires two actions back-to-back in the same run, even for a 0-hour root cause.
  maxRecoveryDurationHours: number; // hard ceiling on total elapsed time since recovery started (first attempt)
  highValueEscalationThreshold: number; // INR - an order at or above this amount escalates to a human before automation acts at all
  // A FLAT threshold alone misses a real anomaly: a customer who normally
  // transacts small amounts suddenly attempting something many times their
  // own historical average is a meaningful signal on its own, independent of
  // whether the absolute amount ever crosses highValueEscalationThreshold -
  // see the "unusual_amount_spike" rule in lib/recovery-decision-engine.ts.
  amountSpikeMultiplier: number; // e.g. 5 = escalate when amount >= 5x this customer's own average past transaction
}

export const DEFAULT_RECOVERY_WORKFLOW_CONFIG: RecoveryWorkflowConfig = {
  maxTotalAttempts: 3,
  reminderCooldownHours: 6,
  maxReminders: 2,
  maxPaymentRetries: 2,
  delayBetweenActionsHours: 1,
  maxRecoveryDurationHours: 168, // 1 week
  highValueEscalationThreshold: 10_000,
  amountSpikeMultiplier: 5,
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRecoveryWorkflowConfig(): RecoveryWorkflowConfig {
  return {
    maxTotalAttempts: envNumber(
      "RECOVERY_MAX_TOTAL_ATTEMPTS",
      DEFAULT_RECOVERY_WORKFLOW_CONFIG.maxTotalAttempts
    ),
    reminderCooldownHours: envNumber(
      "RECOVERY_REMINDER_COOLDOWN_HOURS",
      DEFAULT_RECOVERY_WORKFLOW_CONFIG.reminderCooldownHours
    ),
    maxReminders: envNumber(
      "RECOVERY_MAX_REMINDERS",
      DEFAULT_RECOVERY_WORKFLOW_CONFIG.maxReminders
    ),
    maxPaymentRetries: envNumber(
      "RECOVERY_MAX_PAYMENT_RETRIES",
      DEFAULT_RECOVERY_WORKFLOW_CONFIG.maxPaymentRetries
    ),
    delayBetweenActionsHours: envNumber(
      "RECOVERY_DELAY_BETWEEN_ACTIONS_HOURS",
      DEFAULT_RECOVERY_WORKFLOW_CONFIG.delayBetweenActionsHours
    ),
    maxRecoveryDurationHours: envNumber(
      "RECOVERY_MAX_DURATION_HOURS",
      DEFAULT_RECOVERY_WORKFLOW_CONFIG.maxRecoveryDurationHours
    ),
    highValueEscalationThreshold: envNumber(
      "RECOVERY_HIGH_VALUE_THRESHOLD",
      DEFAULT_RECOVERY_WORKFLOW_CONFIG.highValueEscalationThreshold
    ),
    amountSpikeMultiplier: envNumber(
      "RECOVERY_AMOUNT_SPIKE_MULTIPLIER",
      DEFAULT_RECOVERY_WORKFLOW_CONFIG.amountSpikeMultiplier
    ),
  };
}
