import Razorpay from "razorpay";

export interface CreateRecoveryOrderInput {
  transactionId: string;
  amount: number; // INR
  reason: string; // diagnosed failure reason, stored in the order's notes
}

export interface CreateRecoveryOrderResult {
  razorpayOrderId: string;
  amount: number; // paise
  currency: string;
  receipt: string;
  status: string;
}

export interface CreateRecoveryPaymentLinkInput {
  transactionId: string;
  amount: number; // INR
  reason: string; // diagnosed failure reason, stored in the link's notes
  attemptNumber: number;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
}

export interface CreateRecoveryPaymentLinkResult {
  paymentLinkId: string;
  paymentLinkUrl: string;
  status: string;
}

function getClient(): Razorpay {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error(
      "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set. Add them to .env.local (see .env.local.example)."
    );
  }
  if (!keyId.startsWith("rzp_test_")) {
    throw new Error(
      "RAZORPAY_KEY_ID must be a test-mode key (starting with 'rzp_test_'). This project only creates test-mode orders."
    );
  }

  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

export async function createRecoveryOrder(
  input: CreateRecoveryOrderInput
): Promise<CreateRecoveryOrderResult> {
  const { transactionId, amount, reason } = input;

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("amount must be a positive number (in INR).");
  }

  const client = getClient();
  const amountInPaise = Math.round(amount * 100);
  const receipt = `recovery-${transactionId}-${Date.now()}`.slice(0, 40);

  const order = await client.orders.create({
    amount: amountInPaise,
    currency: "INR",
    receipt,
    notes: {
      transactionId,
      reason,
    },
  });

  return {
    razorpayOrderId: order.id,
    amount: Number(order.amount),
    currency: order.currency,
    receipt: order.receipt ?? receipt,
    status: order.status,
  };
}

/**
 * Creates a real, payable Razorpay Payment Link (a hosted checkout page a
 * customer can actually complete) instead of a bare order. Used for retry
 * actions - notes carry original_transaction_id/attempt_number so the
 * webhook route can match a real payment back to the right attempt.
 */
export async function createRecoveryPaymentLink(
  input: CreateRecoveryPaymentLinkInput
): Promise<CreateRecoveryPaymentLinkResult> {
  const { transactionId, amount, reason, attemptNumber, customerName } = input;

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("amount must be a positive number (in INR).");
  }

  const client = getClient();
  const amountInPaise = Math.round(amount * 100);

  const link = await client.paymentLink.create({
    amount: amountInPaise,
    currency: "INR",
    description: `Revenue recovery retry for ${transactionId}`,
    customer: {
      name: customerName,
      ...(input.customerEmail ? { email: input.customerEmail } : {}),
      ...(input.customerPhone ? { contact: input.customerPhone } : {}),
    },
    // We send our own notification (or the app logs it as simulated) - don't
    // let Razorpay also email/SMS the customer directly.
    notify: { email: false, sms: false },
    notes: {
      original_transaction_id: transactionId,
      attempt_number: attemptNumber,
      reason,
    },
  });

  return {
    paymentLinkId: link.id,
    paymentLinkUrl: link.short_url,
    status: link.status,
  };
}

/**
 * Verifies a Razorpay webhook's signature. Uses RAZORPAY_WEBHOOK_SECRET - a
 * separate secret you set when configuring the webhook in the Razorpay
 * dashboard, NOT your API key secret (RAZORPAY_KEY_SECRET). Razorpay signs
 * webhook payloads with whatever secret you typed in for that specific
 * webhook endpoint, so verifying against the API key secret would always fail.
 */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "RAZORPAY_WEBHOOK_SECRET is not set. Add it to .env.local — it must match the secret you configure for this webhook in the Razorpay dashboard."
    );
  }
  return Razorpay.validateWebhookSignature(rawBody, signature, secret);
}
