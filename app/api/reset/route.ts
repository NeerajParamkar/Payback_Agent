import { NextResponse } from "next/server";
import { resetEscalationQueue } from "@/lib/escalation-queue-store";
import { resetPromisesToPay } from "@/lib/promise-to-pay-store";
import { resetRecoveryCases } from "@/lib/recovery-case-store";
import { resetTransactions } from "@/lib/transactions-store";
import { resetWebhookLog } from "@/lib/webhook-log-store";

export async function POST() {
  try {
    const transactions = await resetTransactions();
    await resetRecoveryCases();
    await resetWebhookLog();
    await resetEscalationQueue();
    await resetPromisesToPay();
    return NextResponse.json({ transactions });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to reset transactions: ${error.message}`
            : "Failed to reset transactions.",
      },
      { status: 500 }
    );
  }
}
