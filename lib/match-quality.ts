// Pure, no server-only dependencies (no fs/path) - safe to import from both
// server code (lib/agent.ts) and client components (app/insights/page.tsx).

import type { RecoveryAction, RootCause } from "@/lib/types";

// Shared by the outcome simulation (lib/agent.ts) - one number for "well-matched"
// and one for "generic/mismatched", so the simulation stays driven by one signal.
export const WELL_MATCHED_SUCCESS_RATE = 0.7;
export const MISMATCHED_SUCCESS_RATE = 0.3;

// Ground-truth root cause -> recovery actions considered a strong match for it.
// Drives the simulated success-rate weighting: a well-matched action succeeds far
// more often than a generic/mismatched one, so diagnosis quality visibly moves the
// final recovery rate. "unknown" has no well-matched action by design - not knowing
// the cause should never itself boost the odds of picking the right fix.
export const WELL_MATCHED_ACTIONS: Record<RootCause, RecoveryAction[]> = {
  bank_decline: ["retry_payment_alternate_method", "offer_incentive_discount"],
  network_failure: ["retry_payment_same_method", "retry_payment_alternate_method"],
  insufficient_funds: [
    "send_sms_reminder",
    "send_whatsapp_reminder",
    "retry_payment_same_method",
  ],
  card_failure: ["retry_payment_alternate_method", "send_sms_reminder"],
  upi_failure: ["retry_payment_same_method", "retry_payment_alternate_method"],
  authentication_failure: ["retry_payment_same_method", "send_sms_reminder"],
  checkout_abandonment: [
    "send_whatsapp_reminder",
    "send_sms_reminder",
    "offer_incentive_discount",
  ],
  payment_pending: ["send_sms_reminder", "send_email_reminder"],
  repeated_payment_failure: [
    "escalate_to_call",
    "escalate_to_account_manager",
    "offer_incentive_discount",
  ],
  overdue_payment: ["send_email_reminder", "escalate_to_account_manager"],
  payment_order_mismatch: ["escalate_to_account_manager"],
  unknown: [],
};

export function isWellMatched(trueReason: RootCause, action: RecoveryAction): boolean {
  return WELL_MATCHED_ACTIONS[trueReason]?.includes(action) ?? false;
}
