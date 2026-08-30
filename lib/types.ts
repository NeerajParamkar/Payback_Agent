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
export type FailureReason =
  | "card_expired"
  | "insufficient_funds"
  | "otp_timeout"
  | "bank_server_error"
  | "international_card_block"
  | "customer_distraction" // for checkout_abandoned
  | "payment_method_declined"
  | "invoice_not_reviewed"; // for invoice_overdue

export const FAILURE_REASONS: FailureReason[] = [
  "card_expired",
  "insufficient_funds",
  "otp_timeout",
  "bank_server_error",
  "international_card_block",
  "customer_distraction",
  "payment_method_declined",
  "invoice_not_reviewed",
];

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
  | "awaiting_payment"; // a real Razorpay Payment Link was sent; frozen until Razorpay's webhook confirms payment

export type AttemptOutcome =
  | "paid"
  | "no_response"
  | "declined_again"
  | "paid_elsewhere" // customer settled outside our system (e.g. cash, another gateway) — not recovered by us
  | "awaiting_response" // real email sent, customer hasn't clicked a response link yet
  | "awaiting_payment"; // real payment link sent, Razorpay hasn't confirmed payment yet

export interface RecoveryAttempt {
  attemptNumber: number;
  timestamp: string;
  diagnosedReason: string; // what the LLM diagnosed
  recommendedAction: string; // what the LLM recommended
  actionTaken: string; // e.g. "sent_sms_reminder", "razorpay_retry", "sent_incentive_offer"
  actionDetail: string; // e.g. the actual message text, or Razorpay order id
  outcome: AttemptOutcome;
  razorpayOrderId?: string; // only if a real Razorpay test order was created
  paymentLinkId?: string; // only if a real Razorpay Payment Link was created (retry actions)
  paymentLinkUrl?: string; // the short_url a customer can actually pay against
  nextAttemptEligibleAt?: string; // ISO date-time; set when this attempt didn't resolve and a cool-down applies before the next one
  respondedAt?: string; // ISO date-time; when the customer clicked a response link (real-customer flow only)
}

export interface Transaction {
  id: string; // e.g. "TXN-0001"
  customerName: string;
  amount: number; // in INR
  type: TransactionType;
  trueFailureReason: FailureReason; // hidden "ground truth" for simulation logic
  createdAt: string; // ISO date
  status: TransactionStatus;
  attempts: RecoveryAttempt[];
  nextEligibleAttemptDate?: string; // ISO date-time; the agent loop won't process this transaction again until this passes
  customerEmail?: string; // if set, this is a REAL transaction — a real email is sent instead of simulating
  customerPhone?: string; // reserved for future real SMS/WhatsApp sending; not used yet
  pendingResponseToken?: string; // security token for the current outstanding email confirmation link
}
