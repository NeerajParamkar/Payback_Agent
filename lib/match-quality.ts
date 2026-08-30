// Pure, no server-only dependencies (no fs/path) - safe to import from both
// server code (lib/agent.ts) and client components (app/insights/page.tsx).

import type { FailureReason, RecoveryAction } from "@/lib/types";

// Ground-truth failure reason -> recovery actions considered a strong match for it.
// Drives the simulated success-rate weighting: a well-matched action succeeds far
// more often than a generic/mismatched one, so diagnosis quality visibly moves the
// final recovery rate.
export const WELL_MATCHED_ACTIONS: Record<FailureReason, RecoveryAction[]> = {
  card_expired: ["retry_payment_alternate_method", "send_sms_reminder"],
  insufficient_funds: [
    "send_sms_reminder",
    "send_whatsapp_reminder",
    "retry_payment_same_method",
  ],
  otp_timeout: ["retry_payment_same_method", "send_sms_reminder"],
  bank_server_error: [
    "retry_payment_same_method",
    "retry_payment_alternate_method",
  ],
  international_card_block: ["retry_payment_alternate_method"],
  customer_distraction: [
    "send_whatsapp_reminder",
    "send_sms_reminder",
    "offer_incentive_discount",
  ],
  payment_method_declined: [
    "retry_payment_alternate_method",
    "offer_incentive_discount",
  ],
  invoice_not_reviewed: ["send_email_reminder", "escalate_to_account_manager"],
};

export function isWellMatched(
  trueReason: FailureReason,
  action: RecoveryAction
): boolean {
  return WELL_MATCHED_ACTIONS[trueReason]?.includes(action) ?? false;
}
