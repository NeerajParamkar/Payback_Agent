import { NextResponse } from "next/server";
import { readWebhookLog } from "@/lib/webhook-log-store";

export async function GET() {
  try {
    const events = await readWebhookLog();
    return NextResponse.json({ events });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to read webhook-events.json: ${error.message}`
            : "Failed to read webhook-events.json.",
      },
      { status: 500 }
    );
  }
}
