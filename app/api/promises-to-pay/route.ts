import { NextResponse } from "next/server";
import { readPromisesToPay } from "@/lib/promise-to-pay-store";

export async function GET() {
  try {
    const promises = await readPromisesToPay();
    return NextResponse.json({ promises });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to read promises-to-pay.json: ${error.message}`
            : "Failed to read promises-to-pay.json.",
      },
      { status: 500 }
    );
  }
}
