import { NextResponse } from "next/server";
import { resetTransactions } from "@/lib/transactions-store";

export async function POST() {
  try {
    const transactions = await resetTransactions();
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
