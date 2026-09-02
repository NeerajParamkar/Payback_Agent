// Data model — see PROJECT_PLAN.md section 5.

export type TransactionType =
  | "payment_failed"
  | "checkout_abandoned"
  | "subscription_failed"
  | "invoice_overdue";

export const TRANSACTION_TYPES: TransactionType[] = [
  "payment_failed",
  "checkout_abandoned",
  "subscription_failed",
  "invoice_overdue",
];

// Fixed set — the LLM must pick from this list, not invent new categories.
// "unknown" is a first-class value, not an error case: the diagnosis prompt is
// explicitly told to use it (with low confidence) rather than force-fit a
// specific-sounding cause the available data doesn't actually support.
export type RootCause =
  | "bank_decline" // the issuing bank explicitly declined the transaction
  | "network_failure" // a transient network/gateway/bank-server error, not a real decline
  | "insufficient_funds" // the account likely didn't have enough balance
  | "card_failure" // the card itself is the problem (expired, blocked, damaged)
  | "upi_failure" // a UPI-specific failure (app timeout, wrong PIN, handle issue)
  | "authentication_failure" // OTP/3DS/authentication step failed or timed out
  | "checkout_abandonment" // customer likely just didn't complete checkout
  | "payment_pending" // payment appears genuinely still in progress, not failed
  | "repeated_payment_failure" // this customer has a pattern of repeated failures
  | "overdue_payment" // a B2B invoice or subscription payment past its due date
  | "payment_order_mismatch" // order and payment records don't line up
  | "unknown"; // data doesn't clearly support any specific cause

export const ROOT_CAUSES: RootCause[] = [
  "bank_decline",
  "network_failure",
  "insufficient_funds",
  "card_failure",
  "upi_failure",
  "authentication_failure",
  "checkout_abandonment",
  "payment_pending",
  "repeated_payment_failure",
  "overdue_payment",
  "payment_order_mismatch",
  "unknown",
];

export type Confidence = "low" | "medium" | "high";

// Fixed set — the LLM must pick from this list, not invent new categories.
export type RecoveryAction =
  | "send_sms_reminder"
  | "send_whatsapp_reminder"
  | "send_email_reminder"
  | "retry_payment_same_method"
  | "retry_payment_alternate_method"
  | "offer_incentive_discount"
  | "escalate_to_call"
  | "escalate_to_account_manager"
  | "mark_unrecoverable";

export const RECOVERY_ACTIONS: RecoveryAction[] = [
  "send_sms_reminder",
  "send_whatsapp_reminder",
  "send_email_reminder",
  "retry_payment_same_method",
  "retry_payment_alternate_method",
  "offer_incentive_discount",
  "escalate_to_call",
  "escalate_to_account_manager",
  "mark_unrecoverable",
];

export type TransactionStatus =
  | "pending"
  | "recovered"
  | "unrecovered"
  | "in_progress"
  | "waiting_for_response" // a real email was sent to the customer; frozen until they click a response link
  | "awaiting_payment" // a real Razorpay Payment Link was sent; frozen until Razorpay's webhook confirms payment
  | "escalated" // handed to a human - see lib/escalation-queue.ts; automated recovery is frozen, permanently, until an admin acts
  | "promise_to_pay"; // customer (or an inference from their behavior) committed to a pay-by date - see lib/promise-to-pay.ts; frozen until that date, then resumes normal policy

export type AttemptOutcome =
  | "paid"
  | "no_response"
  | "declined_again"
  | "paid_elsewhere" // customer settled outside our system (e.g. cash, another gateway) — not recovered by us
  | "awaiting_response" // real email sent, customer hasn't clicked a response link yet
  | "awaiting_payment" // real payment link sent, Razorpay hasn't confirmed payment yet
  | "deferred"; // the recovery decision engine chose to wait / track a promise-to-pay - no customer-facing action taken

// The recovery decision engine's own output vocabulary (lib/recovery-decision-engine.ts) -
// distinct from RecoveryAction (what the AI, upstream, raw-suggests). Every real
// financial or communication operation is gated behind one of these validated
// values; the AI's own recommendation never executes directly.
export type DecisionAction =
  | "wait" // insufficient signal or too soon to act - defer, no operation performed
  | "generate_payment_link" // mint a new real Razorpay Payment Link - the one true "financial operation"
  | "send_email"
  | "retry" // resend/nudge about an existing, still-unresolved Payment Link - no new one minted
  | "send_reminder" // a lighter-touch nudge (SMS/WhatsApp/incentive), not email
  | "track_promise_to_pay" // customer already indicated intent to pay - just note it and check back later
  | "escalate_to_human"
  | "stop"; // give up on this order - no further action, ever

export const DECISION_ACTIONS: DecisionAction[] = [
  "wait",
  "generate_payment_link",
  "send_email",
  "retry",
  "send_reminder",
  "track_promise_to_pay",
  "escalate_to_human",
  "stop",
];

export type PaymentMethodHint = "same" | "alternate";

// Every reason an order can land in the Human Escalation Queue
// (lib/escalation-queue.ts). Some are detected automatically from existing
// data (low_ai_confidence, max_attempts_reached, high_value_transaction,
// duplicate_successful_payments, ambiguous_payment_status); others are
// reported by an external signal - a customer's own response, or an admin/
// support flag (see Transaction's manual escalation flags below).
export type EscalationReason =
  | "customer_disputed_payment"
  | "customer_claims_paid_unverified"
  | "duplicate_successful_payments"
  | "suspected_fraud"
  | "high_value_transaction"
  | "unusual_amount_spike" // amount is many times this specific customer's own historical average - see lib/recovery-decision-engine.ts
  | "low_ai_confidence"
  | "max_attempts_reached"
  | "customer_requested_human"
  | "ambiguous_payment_status"
  | "complex_refund_issue";

export const ESCALATION_REASONS: EscalationReason[] = [
  "customer_disputed_payment",
  "customer_claims_paid_unverified",
  "duplicate_successful_payments",
  "suspected_fraud",
  "high_value_transaction",
  "unusual_amount_spike",
  "low_ai_confidence",
  "max_attempts_reached",
  "customer_requested_human",
  "ambiguous_payment_status",
  "complex_refund_issue",
];

export type EscalationQueueStatus = "open" | "owned" | "resolved";

export type EscalationResolutionAction =
  | "resolved"
  | "recovery_stopped"
  | "marked_recovered"
  | "offline_payment_recorded"
  | "payment_link_sent"
  | "promise_to_pay_recorded";

export interface EscalationResolution {
  action: EscalationResolutionAction;
  note?: string;
  resolvedBy: string;
  resolvedAt: string;
}

// One row per escalated order - a lightweight pointer plus the escalation-
// specific admin state (ownership, resolution). The full recovery timeline,
// previous actions, and customer responses this queue must show are NOT
// duplicated here - they're Transaction.attempts, fetched alongside this by
// transactionId, the same "derive, don't duplicate" pattern as RecoveryCase.
export interface EscalationQueueEntry {
  id: string; // e.g. "ESC-0001" - deterministic from the transaction id
  transactionId: string;
  customerName: string;
  customerEmail?: string;
  amount: number;
  rootCause?: string;
  recoveryScore: number;
  recoveryProbability: number;
  reasons: EscalationReason[]; // can be more than one at once
  status: EscalationQueueStatus;
  ownedBy?: string;
  ownedAt?: string;
  resolution?: EscalationResolution;
  createdAt: string;
  updatedAt: string;
}

// A customer's (or an inference from their behavior's) commitment to pay by a
// given date - see lib/promise-to-pay.ts. One current promise per order; a new
// one recorded after an old one resolves reuses the same id.
export type PromiseToPayStatus = "pending" | "kept" | "broken";
export type PromiseToPaySource = "admin_recorded" | "automated_inference";

export interface PromiseToPay {
  id: string; // e.g. "PTP-0001" - deterministic from the transaction id
  transactionId: string;
  customerName: string;
  customerEmail?: string;
  amount: number;
  promiseDate: string; // ISO date (YYYY-MM-DD) as stated/inferred, for display
  promiseTimeProvided: boolean; // whether a specific time was given, not just a date
  promiseAt: string; // ISO date-time - the actual computed deadline this is checked against
  status: PromiseToPayStatus;
  source: PromiseToPaySource;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

// One row per Razorpay webhook delivery this system has seen - the persisted
// half of idempotent processing (lib/razorpay-webhook.ts): before doing
// anything, a delivery's eventKey is checked against this log, and every
// delivery (processed, a recognized duplicate, ignored, or errored) is
// recorded here for audit, regardless of outcome.
export type WebhookLogStatus = "processed" | "duplicate" | "ignored" | "error";

export interface WebhookLogEntry {
  id: string;
  eventKey: string; // "<event type>:<entity id>" - the idempotency key
  eventType: string; // e.g. "payment_link.paid"
  transactionId?: string;
  amount?: number;
  status: WebhookLogStatus;
  detail: string;
  receivedAt: string;
}

// A raw gateway-level try at collecting payment against an order. One order can
// have many of these — a failed attempt never means the order is lost, only the
// presence of one "captured" attempt does, however many failed before it.
export type PaymentAttemptStatus =
  | "created" // a real Razorpay Payment Link exists for this try; outcome not known yet
  | "pending" // Razorpay reports the payment authorized but not yet captured - still in flight
  | "captured" // money was actually collected — this is what makes an order PAID
  | "failed" // this specific try did not result in payment
  | "refunded" // a previously captured payment was refunded - no longer counts toward isOrderPaid
  | "paid_elsewhere"; // customer settled outside our system — not captured by us

// Whether the order has been paid at all, derived from paymentAttempts (see
// lib/payment-attempts.ts) — not stored redundantly, so it can never drift out
// of sync with the attempts it's computed from.
export type OrderPaymentStatus = "paid" | "unpaid";

export interface PaymentAttempt {
  id: string;
  recoveryAttemptNumber: number; // which RecoveryAttempt (diagnosis/action cycle) produced this try
  status: PaymentAttemptStatus;
  amount: number; // INR — same amount/currency as the parent Transaction
  method?: string; // e.g. "card", "upi", "netbanking" — only known once Razorpay reports it
  failureReason?: string; // why this specific try failed; gateway-reported when known, else our diagnosis
  razorpayOrderId?: string;
  paymentLinkId?: string;
  razorpayPaymentId?: string; // pay_xxx — only known once Razorpay reports a specific payment
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryAttempt {
  attemptNumber: number;
  timestamp: string;
  diagnosedReason: string; // what the LLM diagnosed - one of ROOT_CAUSES
  recommendedAction: string; // what the LLM recommended
  actionTaken: string; // e.g. "sent_sms_reminder", "razorpay_retry", "sent_incentive_offer"
  actionDetail: string; // e.g. the actual message text, or Razorpay order id
  outcome: AttemptOutcome;
  // AI analysis - part of the same diagnosis call as diagnosedReason/recommendedAction,
  // always present since every attempt goes through diagnosis first (see lib/diagnose.ts).
  confidence: Confidence; // how well the available data supported the diagnosedReason call
  recoveryProbability: number; // 0-1, the AI's own estimate for this specific attempt
  priority: RecoveryPriority; // the AI's assessed urgency for this case
  diagnosisRationale: string; // AI's internal explanation for its analysis - not shown to the customer
  // Recovery Decision Engine output (lib/recovery-decision-engine.ts) - the AI's
  // recommendedAction above is only ever a SUGGESTION; decisionAction is what the
  // deterministic policy engine actually validated and executed, which may differ.
  decisionAction: DecisionAction;
  policyOverridden: boolean; // true if decisionAction departs from what recommendedAction implied
  policyReason: string; // the policy engine's explanation for its decision
  escalationReasons?: EscalationReason[]; // set when decisionAction === "escalate_to_human"
  razorpayOrderId?: string; // only if a real Razorpay test order was created
  paymentLinkId?: string; // only if a real Razorpay Payment Link was created (retry actions)
  paymentLinkUrl?: string; // the short_url a customer can actually pay against
  nextAttemptEligibleAt?: string; // ISO date-time; set when this attempt didn't resolve and a cool-down applies before the next one
  respondedAt?: string; // ISO date-time; when the customer clicked a response link (real-customer flow only)
}

// A Recovery Case is the ops-facing wrapper around one at-risk Order: it tracks
// the case-management lifecycle (detected -> ... -> recovered/stopped/failed),
// separately from `Transaction.attempts`/`status`, which stay the agent's own
// diagnosis/execution history. One Transaction has at most one open RecoveryCase.
export type RecoveryCaseStatus =
  | "detected" // order identified as at-risk; no recovery action taken yet
  | "analysing" // picked up by a run, diagnosis about to happen
  | "recovery_active" // automated attempts in progress (including cool-down waits)
  | "awaiting_customer" // a real customer was emailed; waiting on their response
  | "awaiting_promise" // tracking a promise-to-pay - see lib/promise-to-pay.ts
  | "recovered" // the order is paid - see lib/payment-attempts.ts
  | "escalated" // exhausted automated recovery; last action handed this to a human
  | "stopped" // customer settled outside our system (paid elsewhere) - moot, not failed
  | "failed"; // exhausted all attempts with no payment and no escalation

export type RecoveryPriority = "low" | "medium" | "high" | "critical";

// Where the case sits in the attempt sequence - "resolved" once status is terminal.
export type RecoveryStage = "new" | "attempt_1" | "attempt_2" | "attempt_3" | "resolved";

export interface RecoveryCase {
  id: string; // e.g. "CASE-0001" - deterministic from the transaction id
  transactionId: string; // the Order this case tracks, one-to-one
  customerName: string;
  customerEmail?: string;
  amountAtRisk: number; // snapshot of the order amount - kept as history once resolved
  status: RecoveryCaseStatus;
  rootCause?: string; // most recently diagnosed reason (never the hidden trueFailureReason)
  recoveryScore: number; // 0-100, deterministic composite - see lib/recovery-case.ts
  recoveryProbability: number; // 0-1 - the AI's own estimate from the latest attempt's diagnosis
  priority: RecoveryPriority;
  stage: RecoveryStage;
  nextAction?: string; // human-readable description of what happens next, if anything
  nextActionAt?: string; // ISO date-time the next action is scheduled for, if known
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

// Customer Recovery Intelligence - aggregated across ALL of a customer's orders,
// purely derived from Transaction history (no separate persisted store; see
// lib/customer-recovery.ts). Distinct from RecoveryCase.recoveryScore, which
// scores one order's likelihood - this scores the customer's overall pattern.
export interface CustomerScoreFactor {
  key: string;
  label: string;
  value: number; // 0-1, normalized so 1 always means "ideal customer behavior" for this factor
  weight: number; // 0-1, this factor's share of the final score
  contribution: number; // value * weight * 100 - points this factor contributed
  hasData: boolean; // false when there was no history yet and a neutral default was used
}

export interface CustomerRecoveryProfile {
  customerId: string; // canonical identity - see customerIdentityKey in lib/customer-recovery.ts
  customerName: string;
  customerEmail?: string;
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  totalAmount: number;
  amountRecovered: number;
  amountAtRisk: number; // sum of amount for orders still open (not paid, not given up on)
  averagePaymentDelayHours: number | null; // order-creation -> paid, averaged over recovered orders; null = none yet
  previousRecoveryAttempts: number;
  successfulRecoveryActions: number;
  failedRecoveryActions: number;
  preferredRecoveryChannel: string | null; // the actionTaken most often followed by a "paid" outcome
  recoveryScore: number; // 0-100, from the pluggable scoring service (lib/customer-scoring.ts)
  scoreBreakdown: CustomerScoreFactor[];
}

export interface Transaction {
  id: string; // e.g. "TXN-0001"
  customerName: string;
  amount: number; // in INR
  type: TransactionType;
  trueFailureReason: RootCause; // hidden "ground truth" for simulation logic - never sent to the LLM
  // The gateway-reported error text available at the time of the ORIGINAL
  // failure - a realistic stand-in for what Razorpay's own failed-payment
  // webhook/API response would already show a merchant before any recovery
  // attempt. Genuinely fed into diagnosis (lib/diagnose.ts) so the AI has
  // real evidence to reason from instead of guessing blind off `type` alone.
  // Deliberately omitted for checkout-abandonment/overdue-invoice cases,
  // where no payment attempt was ever actually made at the gateway - there's
  // nothing a gateway could have reported. Not the same as `trueFailureReason`:
  // this is realistically noisy (sometimes a precise reason code, sometimes a
  // bare "declined, no further detail"), so honest uncertainty is still
  // possible - it's not a disguised answer key.
  gatewayErrorHint?: string;
  createdAt: string; // ISO date
  status: TransactionStatus;
  attempts: RecoveryAttempt[];
  // Order -> many Payment Attempts. This is the source of truth for whether the
  // order is actually paid (see getOrderPaymentStatus in lib/payment-attempts.ts) —
  // distinct from `attempts`, which is the agent's diagnosis/action history.
  paymentAttempts: PaymentAttempt[];
  nextEligibleAttemptDate?: string; // ISO date-time; the agent loop won't process this transaction again until this passes
  customerEmail?: string; // if set, this is a REAL transaction — a real email is sent instead of simulating
  customerPhone?: string; // reserved for future real SMS/WhatsApp sending; not used yet
  pendingResponseToken?: string; // security token for the current outstanding email confirmation link
  customerOptedOut?: boolean; // customer explicitly asked not to be contacted further - see lib/recovery-decision-engine.ts
  // Manual escalation flags - set via POST /api/transactions/[id]/flags (support/
  // ops reporting a signal this system has no other way to observe) or by the
  // webhook handler (duplicate/ambiguous payment states). Any true flag forces
  // escalation on the next decision cycle - see lib/recovery-decision-engine.ts.
  customerDisputed?: boolean;
  customerClaimsPaidUnverified?: boolean;
  suspectedFraud?: boolean;
  complexIssueFlag?: boolean;
}
