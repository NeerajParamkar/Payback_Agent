import { NextRequest, NextResponse } from "next/server";
import { processRazorpayWebhookEvent } from "@/lib/razorpay-webhook";
import { verifyWebhookSignature } from "@/lib/razorpay";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature");

  // Security: verified BEFORE anything else touches the payload - an invalid
  // or missing signature never reaches the idempotency log or the transaction
  // store.
  if (!signature) {
    return NextResponse.json(
      { error: "Missing x-razorpay-signature header." },
      { status: 400 }
    );
  }

  let isValid: boolean;
  try {
    isValid = verifyWebhookSignature(rawBody, signature);
  } catch (error) {
    // Misconfiguration (missing RAZORPAY_WEBHOOK_SECRET) - not the caller's fault.
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Webhook secret not configured.",
      },
      { status: 500 }
    );
  }

  if (!isValid) {
    return NextResponse.json(
      { error: "Invalid webhook signature." },
      { status: 400 }
    );
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const result = await processRazorpayWebhookEvent(event);
    // "retry" means the target order was mid-mutation elsewhere and this
    // delivery wasn't processed - a 5xx tells Razorpay to redeliver later
    // rather than silently dropping the event (retry-safe).
    const status = result.outcome === "retry" || result.outcome === "error" ? 503 : 200;
    return NextResponse.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    // Return 500 so Razorpay retries delivery - this is for transient failures
    // (e.g. a concurrent write), not for events we simply don't care about.
    console.error("Failed to process Razorpay webhook:", error);
    return NextResponse.json(
      { error: "Failed to process webhook." },
      { status: 500 }
    );
  }
}
