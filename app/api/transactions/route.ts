import { NextResponse } from "next/server";
import { readTransactions } from "@/lib/transactions-store";

export async function GET() {
  try {
    const transactions = await readTransactions();
    return NextResponse.json({ transactions });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to read transactions.json: ${error.message}`
            : "Failed to read transactions.json.",
      },
      { status: 500 }
    );
  }
}
