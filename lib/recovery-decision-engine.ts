// Recovery Decision Engine — the deterministic policy layer between the AI's
// diagnosis and any real financial or communication operation.
//
// The AI (lib/diagnose.ts) never executes anything: it only RECOMMENDS. This
// module VALIDATES that recommendation against hard business rules and decides
// what actually happens. It is intentionally its own module, not inlined into
// lib/agent.ts, so the policy rules can be read, edited, and reasoned about (or
// swapped for a different engine entirely) without touching the diagnosis or
// execution plumbing around it. Every rule is deterministic - no LLM calls here.
//
// This is also where several of the Human Escalation Queue's automatic
// triggers (lib/escalation-queue.ts) are actually detected: max attempts
// reached, AI confidence too low, a high-value order, and any manually
// reported flag (dispute / unverified payment claim / suspected fraud /
// complex issue) on the transaction. "escalate_to_human" is never executed
// directly - lib/agent.ts freezes the order (status "escalated") the moment
// this engine returns it, which is what actually stops automation.

import type { CustomerHistoryContext } from "@/lib/diagnose";
import type { RecoveryWorkflowConfig } from "@/lib/recovery-workflow-config";
import type {
  AttemptOutcome,
  Confidence,
  DecisionAction,
  EscalationReason,
  PaymentMethodHint,
  RecoveryAction,
} from "@/lib/types";

export interface ManualEscalationFlags {
  customerDisputed: boolean;
  customerClaimsPaidUnverified: boolean;
  suspectedFraud: boolean;
  complexIssueFlag: boolean;
}

export interface RecoveryDecisionInput {
  // What the AI recommended this cycle (lib/diagnose.ts's Diagnosis) - a
  // suggestion only, never trusted to execute directly.
  aiRecommendedAction: RecoveryAction;
  confidence: Confidence;
  recoveryProbability: number; // 0-1, the AI's own estimate

  // Order/case state
  amount: number;
  recoveryScore: number; // 0-100, derived from recoveryProbability by the caller
  attemptCount: number; // attempts already made on this order, before this one
  recoveryDurationHours: number; // hours since recovery started (first attempt), not the order's raw creation date
  remindersSent: number; // reminder-type actions (send_email/send_reminder) already taken on this order
  paymentRetriesUsed: number; // generate_payment_link actions already taken on this order
  isOrderPaid: boolean;
  hasActivePaymentLink: boolean; // an unresolved ("created"/"pending") Payment Link already exists
  customerOptedOut: boolean;
  manualFlags: ManualEscalationFlags;

  // History
  previousActions: RecoveryAction[]; // this order's own prior AI recommendations
  previousResponses: AttemptOutcome[]; // this order's own prior outcomes
  customerHistory?: CustomerHistoryContext; // this customer's pattern across ALL their orders

  // The bounded workflow's configurable knobs (lib/recovery-workflow-config.ts) -
  // every cap this engine enforces comes from here, not a hardcoded constant.
  config: RecoveryWorkflowConfig;
}

export interface PolicyCheckResult {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface RecoveryDecisionResult {
  action: DecisionAction; // the final, validated decision - safe to execute
  methodHint?: PaymentMethodHint; // only meaningful when action is "generate_payment_link"
  aiSuggestedAction: DecisionAction; // what the AI's raw recommendation mapped to, pre-validation
  overridden: boolean; // true when action !== aiSuggestedAction
  reason: string; // human-readable explanation of the final decision
  checks: PolicyCheckResult[]; // every rule evaluated, in order, for audit/transparency
  escalationReasons: EscalationReason[]; // populated when action === "escalate_to_human" and a rule maps
  // cleanly onto one of the Human Escalation Queue's named reasons - some
  // escalating rules (e.g. a stale case, a repeated ineffective action) don't
  // map onto a specific named reason and leave this empty; `reason` above
  // still explains them in plain language either way.
}

// Below this amount, minting a real Payment Link isn't worth the operational
// overhead - a reminder is the more proportionate move.
const MIN_PAYMENT_LINK_AMOUNT = 100;

/**
 * Maps the AI's granular recommendation onto the decision engine's own
 * vocabulary - purely a translation, no validation happens here.
 */
function translateAiAction(
  action: RecoveryAction
): { action: DecisionAction; methodHint?: PaymentMethodHint } {
  switch (action) {
    case "retry_payment_same_method":
      return { action: "generate_payment_link", methodHint: "same" };
    case "retry_payment_alternate_method":
      return { action: "generate_payment_link", methodHint: "alternate" };
    case "send_email_reminder":
      return { action: "send_email" };
    case "send_sms_reminder":
    case "send_whatsapp_reminder":
    case "offer_incentive_discount":
      return { action: "send_reminder" };
    case "escalate_to_call":
    case "escalate_to_account_manager":
      return { action: "escalate_to_human" };
    case "mark_unrecoverable":
      return { action: "stop" };
  }
}

/**
 * Maps a validated decision back onto a representative granular RecoveryAction,
 * used only to drive the outcome simulation's well-matched lookup (lib/agent.ts) -
 * the simulation should reflect what actually happened, not what the AI merely
 * wanted. Never used to populate a persisted "recommendedAction" field - that
 * stays the AI's own raw suggestion for audit purposes.
 */
export function resolveSimulationAction(
  decision: Pick<RecoveryDecisionResult, "action" | "methodHint">,
  customerHistory: CustomerHistoryContext | undefined
): RecoveryAction {
  switch (decision.action) {
    case "generate_payment_link":
      return decision.methodHint === "alternate"
        ? "retry_payment_alternate_method"
        : "retry_payment_same_method";
    case "retry":
      return "retry_payment_same_method";
    case "send_email":
      return "send_email_reminder";
    case "send_reminder":
      return customerHistory?.preferredRecoveryChannel === "sent_whatsapp_reminder"
        ? "send_whatsapp_reminder"
        : "send_sms_reminder";
    case "escalate_to_human":
      return "escalate_to_account_manager";
    case "stop":
      return "mark_unrecoverable";
    case "wait":
    case "track_promise_to_pay":
      // Never actually reaches the simulation (lib/agent.ts short-circuits both
      // before calling it) - value here is unused, just satisfies the type.
      return "send_sms_reminder";
  }
}

const MANUAL_FLAG_REASONS: Array<{
  flag: keyof ManualEscalationFlags;
  reason: EscalationReason;
  label: string;
}> = [
  { flag: "customerDisputed", reason: "customer_disputed_payment", label: "Customer disputed the payment" },
  {
    flag: "customerClaimsPaidUnverified",
    reason: "customer_claims_paid_unverified",
    label: "Customer claims they already paid, but it can't be verified",
  },
  { flag: "suspectedFraud", reason: "suspected_fraud", label: "Suspected fraud / suspicious activity flagged" },
  { flag: "complexIssueFlag", reason: "complex_refund_issue", label: "Complex refund/payment issue flagged" },
];

/**
 * Validates the AI's recommendation against deterministic business rules and
 * returns the final action to execute. Rules run in order from hardest
 * (never overridden) to softest (heuristic downgrades).
 */
export function decideRecoveryAction(input: RecoveryDecisionInput): RecoveryDecisionResult {
  const suggested = translateAiAction(input.aiRecommendedAction);
  const checks: PolicyCheckResult[] = [];
  const escalationReasons: EscalationReason[] = [];
  let action: DecisionAction = suggested.action;
  let methodHint = suggested.methodHint;
  let reason = `AI recommendation (${suggested.action}) accepted as-is.`;

  function override(next: DecisionAction, detail: string) {
    action = next;
    methodHint = undefined;
    reason = detail;
  }

  function escalate(detail: string, escalationReason?: EscalationReason) {
    if (escalationReason && !escalationReasons.includes(escalationReason)) {
      escalationReasons.push(escalationReason);
    }
    override("escalate_to_human", detail);
  }

  // 0. Manually reported signals (a support/ops flag this system has no other
  // way to observe) always win - checked first, unconditionally, ahead of
  // even "already paid" - a dispute or fraud flag on a paid order still needs
  // a human, not a silent stop.
  const activeManualFlags = MANUAL_FLAG_REASONS.filter(({ flag }) => input.manualFlags[flag]);
  checks.push({
    rule: "no_manual_escalation_flags",
    passed: activeManualFlags.length === 0,
    detail:
      activeManualFlags.length === 0
        ? "No manual escalation flags set."
        : `Manual flag(s) set: ${activeManualFlags.map((f) => f.label).join("; ")}.`,
  });
  for (const { reason: escalationReason, label } of activeManualFlags) {
    escalate(label, escalationReason);
  }

  // 1. Order already paid - nothing left to do, full stop - unless a manual
  // flag above already demands human review regardless.
  const notPaid = !input.isOrderPaid;
  checks.push({
    rule: "order_still_unpaid",
    passed: notPaid,
    detail: notPaid ? "Order is unpaid." : "Order is already paid — no action needed.",
  });
  if (!notPaid && action !== "escalate_to_human") {
    override("stop", "Order is already paid.");
  }

  // 2. Retry limit exceeded - always hands off to a human. Automated recovery
  // never just quietly gives up once its attempt budget is spent.
  const withinRetryLimit = input.attemptCount < input.config.maxTotalAttempts;
  checks.push({
    rule: "retry_limit_not_exceeded",
    passed: withinRetryLimit,
    detail: withinRetryLimit
      ? `${input.attemptCount}/${input.config.maxTotalAttempts} attempts so far, within limit.`
      : `${input.attemptCount}/${input.config.maxTotalAttempts} attempts already made — limit reached.`,
  });
  if (!withinRetryLimit && action !== "stop") {
    escalate(
      `Maximum automated recovery attempts reached (${input.attemptCount}/${input.config.maxTotalAttempts}); handing off to a human.`,
      "max_attempts_reached"
    );
  }

  // 3. Customer opted out - no further contact of any kind.
  const notOptedOut = !input.customerOptedOut;
  checks.push({
    rule: "customer_not_opted_out",
    passed: notOptedOut,
    detail: notOptedOut ? "Customer has not opted out." : "Customer opted out of further contact.",
  });
  if (!notOptedOut && action !== "stop" && action !== "escalate_to_human") {
    override("stop", "Customer opted out of further contact.");
  }

  // 4. A high-value order gets a human's eyes before automation acts at all -
  // checked only on the very first attempt (an order that's already past
  // attempt 1 has already cleared this gate once).
  if (input.attemptCount === 0 && action !== "stop" && action !== "escalate_to_human") {
    const belowHighValueThreshold = input.amount < input.config.highValueEscalationThreshold;
    checks.push({
      rule: "below_high_value_threshold",
      passed: belowHighValueThreshold,
      detail: belowHighValueThreshold
        ? `Amount ₹${input.amount} is below the ₹${input.config.highValueEscalationThreshold} high-value threshold.`
        : `Amount ₹${input.amount} is at or above the ₹${input.config.highValueEscalationThreshold} high-value threshold.`,
    });
    if (!belowHighValueThreshold) {
      escalate(
        `Order amount ₹${input.amount} is at or above the configured high-value threshold (₹${input.config.highValueEscalationThreshold}); a human reviews this before automation acts.`,
        "high_value_transaction"
      );
    }
  }

  // 4b. A flat threshold alone misses a real anomaly: a customer who
  // normally transacts small amounts suddenly attempting something many
  // times their own historical average is a meaningful signal on its own -
  // e.g. a customer who usually pays ₹100 suddenly attempting ₹5,000 is
  // worth a human's eyes even though ₹5,000 alone would never cross the
  // flat high-value threshold above. Checked only on the first attempt, same
  // as rule 4, and only when this customer actually has a known baseline to
  // compare against (a brand-new customer has nothing to be "sudden" relative to).
  // Deliberately does NOT skip when rule 4 already escalated - an order that's
  // both high-value AND a spike for this specific customer should carry both
  // reasons, the same way multiple manual flags (rule 0) all accumulate.
  if (
    input.attemptCount === 0 &&
    action !== "stop" &&
    input.customerHistory?.averagePastAmount &&
    input.customerHistory.averagePastAmount > 0
  ) {
    const baseline = input.customerHistory.averagePastAmount;
    const spikeRatio = input.amount / baseline;
    const withinNormalRange = spikeRatio < input.config.amountSpikeMultiplier;
    checks.push({
      rule: "no_unusual_amount_spike",
      passed: withinNormalRange,
      detail: withinNormalRange
        ? `Amount ₹${input.amount} is ${spikeRatio.toFixed(1)}x this customer's average (₹${Math.round(baseline)}) - within their normal range.`
        : `Amount ₹${input.amount} is ${spikeRatio.toFixed(1)}x this customer's usual average (₹${Math.round(baseline)}) - an unusual spike for them specifically, regardless of the flat high-value threshold.`,
    });
    if (!withinNormalRange) {
      escalate(
        `Order amount ₹${input.amount} is ${spikeRatio.toFixed(1)}x this customer's typical transaction (₹${Math.round(baseline)}) - an unusual spike worth a human's review before automation acts.`,
        "unusual_amount_spike"
      );
    }
  }

  // 5. Confidence that's still low beyond the very first attempt is a sign
  // this case genuinely doesn't fit the model well - hand it to a human
  // instead of continuing to guess (distinct from rule 9 below, which only
  // softens a *first*-attempt Payment Link specifically).
  if (input.attemptCount >= 1 && action !== "stop" && action !== "escalate_to_human") {
    const confidenceAcceptable = input.confidence !== "low";
    checks.push({
      rule: "confidence_acceptable_after_first_attempt",
      passed: confidenceAcceptable,
      detail: confidenceAcceptable
        ? `Confidence is ${input.confidence}.`
        : `Confidence is still low after ${input.attemptCount} attempt(s).`,
    });
    if (!confidenceAcceptable) {
      escalate(
        `AI confidence is still low after ${input.attemptCount} attempt(s); escalating rather than continuing to guess.`,
        "low_ai_confidence"
      );
    }
  }

  // 6. Second-guess a premature give-up: if the AI wants to stop very early and
  // the numbers still look reasonably hopeful, try one more nudge instead.
  if (action === "stop" && suggested.action === "stop" && input.attemptCount < 2 && input.recoveryProbability >= 0.4) {
    checks.push({
      rule: "reject_premature_giveup",
      passed: false,
      detail: `AI suggested giving up after only ${input.attemptCount} attempt(s), but recovery probability (${Math.round(input.recoveryProbability * 100)}%) doesn't support it yet.`,
    });
    override(
      "send_reminder",
      `AI recommended stopping after only ${input.attemptCount} attempt(s), but recovery probability is still ${Math.round(input.recoveryProbability * 100)}% — trying a reminder before giving up.`
    );
  }

  // 7. Reminder cap reached - a case that's used its budget of reminders needs
  // a different kind of push, not another one.
  if (action === "send_reminder" || action === "send_email") {
    const withinReminderCap = input.remindersSent < input.config.maxReminders;
    checks.push({
      rule: "within_reminder_cap",
      passed: withinReminderCap,
      detail: withinReminderCap
        ? `${input.remindersSent}/${input.config.maxReminders} reminders sent so far.`
        : `Reminder cap reached (${input.remindersSent}/${input.config.maxReminders}).`,
    });
    if (!withinReminderCap) {
      escalate(
        `Reminder cap reached (${input.remindersSent}/${input.config.maxReminders}); escalating instead of sending another.`
      );
    }
  }

  // 8. Payment Link retry cap reached - stop minting new links once the budget
  // is used; fall back to a reminder instead.
  if (action === "generate_payment_link") {
    const withinRetryCap = input.paymentRetriesUsed < input.config.maxPaymentRetries;
    checks.push({
      rule: "within_payment_retry_cap",
      passed: withinRetryCap,
      detail: withinRetryCap
        ? `${input.paymentRetriesUsed}/${input.config.maxPaymentRetries} Payment Links generated so far.`
        : `Payment Link retry cap reached (${input.paymentRetriesUsed}/${input.config.maxPaymentRetries}).`,
    });
    if (!withinRetryCap) {
      override(
        "send_reminder",
        `Payment Link retry cap reached (${input.paymentRetriesUsed}/${input.config.maxPaymentRetries}); trying a reminder instead.`
      );
    }
  }

  // 9. Don't mint a second Payment Link while one is still outstanding - resend
  // the existing one instead.
  if (action === "generate_payment_link") {
    const noDuplicateLink = !input.hasActivePaymentLink;
    checks.push({
      rule: "no_duplicate_payment_link",
      passed: noDuplicateLink,
      detail: noDuplicateLink
        ? "No active Payment Link outstanding."
        : "An active Payment Link already exists for this order.",
    });
    if (!noDuplicateLink) {
      override(
        "retry",
        "An unresolved Payment Link already exists; resending it instead of minting a new one."
      );
    }
  }

  // 10. A real Payment Link isn't worth the overhead for a trivially small amount.
  if (action === "generate_payment_link") {
    const amountClearsFloor = input.amount >= MIN_PAYMENT_LINK_AMOUNT;
    checks.push({
      rule: "amount_above_payment_link_floor",
      passed: amountClearsFloor,
      detail: amountClearsFloor
        ? `Amount ₹${input.amount} clears the ₹${MIN_PAYMENT_LINK_AMOUNT} floor for a real Payment Link.`
        : `Amount ₹${input.amount} is below the ₹${MIN_PAYMENT_LINK_AMOUNT} floor — a reminder is more proportionate.`,
    });
    if (!amountClearsFloor) {
      override("send_reminder", `Amount is below the ₹${MIN_PAYMENT_LINK_AMOUNT} floor for a real Payment Link.`);
    }
  }

  // 11. Don't spend a real financial operation on a low-confidence first guess -
  // wait for more signal.
  if (action === "generate_payment_link") {
    const confidenceOk = !(input.confidence === "low" && input.attemptCount === 0);
    checks.push({
      rule: "sufficient_confidence_for_payment_link",
      passed: confidenceOk,
      detail: confidenceOk
        ? `Confidence is ${input.confidence}.`
        : "Confidence is low on the first attempt — deferring a real Payment Link.",
    });
    if (!confidenceOk) {
      override(
        "wait",
        "Diagnosis confidence is low on the first attempt; waiting before generating a real Payment Link."
      );
    }
  }

  // 12. A customer with a poor track record across ALL their orders doesn't
  // justify a real Payment Link on the very first try - warm them up first.
  if (action === "generate_payment_link" && input.customerHistory && input.attemptCount === 0) {
    const { successfulTransactions, failedTransactions } = input.customerHistory;
    const poorTrackRecord = successfulTransactions === 0 && failedTransactions >= 2;
    checks.push({
      rule: "customer_track_record_supports_payment_link",
      passed: !poorTrackRecord,
      detail: poorTrackRecord
        ? `Customer has ${failedTransactions} prior failed transactions and 0 successful ones.`
        : "Customer's track record doesn't rule out a Payment Link.",
    });
    if (poorTrackRecord) {
      override(
        "send_reminder",
        `Customer has a poor track record (${failedTransactions} failed, 0 successful) — trying a reminder before a real Payment Link.`
      );
    }
  }

  // 13. Customer already told us "not yet" - track it as a promise rather than
  // immediately re-prompting.
  const lastResponse = input.previousResponses[input.previousResponses.length - 1];
  if (
    (action === "send_reminder" || action === "send_email") &&
    lastResponse === "declined_again" &&
    input.recoveryProbability >= 0.5
  ) {
    checks.push({
      rule: "respect_recent_customer_response",
      passed: false,
      detail: "Customer's most recent response was 'not yet' — tracking as a promise-to-pay instead.",
    });
    override(
      "track_promise_to_pay",
      "Customer's most recent response was 'not yet'; tracking their promise instead of re-prompting immediately."
    );
  }

  // 14. Repeating the exact same AI recommendation the engine already acted on
  // last time is a sign automation isn't working - escalate instead.
  const lastAction = input.previousActions[input.previousActions.length - 1];
  if (
    (action === "send_reminder" || action === "send_email" || action === "retry") &&
    lastAction === input.aiRecommendedAction
  ) {
    checks.push({
      rule: "no_repeat_ineffective_action",
      passed: false,
      detail: `AI recommended the same action (${input.aiRecommendedAction}) as last cycle without success.`,
    });
    escalate(
      `The same action (${input.aiRecommendedAction}) was already tried without success — escalating rather than repeating it.`
    );
  }

  // 15. A case that's already had at least one real attempt AND has run past
  // the configured maximum recovery duration deserves a human, not another
  // automated cycle. Gated on attemptCount >= 1 - an order that's simply old
  // but hasn't been tried yet isn't "stale automation," it's a first attempt
  // running late.
  if (
    (action === "wait" || action === "send_reminder" || action === "send_email" || action === "retry") &&
    input.attemptCount >= 1 &&
    input.recoveryDurationHours >= input.config.maxRecoveryDurationHours
  ) {
    checks.push({
      rule: "max_recovery_duration_exceeded",
      passed: false,
      detail: `${input.attemptCount} attempt(s) already made over ${Math.round(input.recoveryDurationHours)}h, past the ${input.config.maxRecoveryDurationHours}h maximum recovery duration.`,
    });
    escalate(
      `Case has run for ${Math.round(input.recoveryDurationHours)}h (over the configured ${input.config.maxRecoveryDurationHours}h maximum) across ${input.attemptCount} attempt(s) without resolution — escalating to a human.`
    );
  }

  return {
    action,
    ...(methodHint ? { methodHint } : {}),
    aiSuggestedAction: suggested.action,
    overridden: action !== suggested.action,
    reason,
    checks,
    escalationReasons,
  };
}
