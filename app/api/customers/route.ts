import { NextResponse } from "next/server";
import { buildCustomerRecoveryProfiles } from "@/lib/customer-recovery";
import { readTransactions } from "@/lib/transactions-store";

export async function GET() {
  try {
    const transactions = await readTransactions();
    const customers = buildCustomerRecoveryProfiles(transactions);
    return NextResponse.json({ customers });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to build customer recovery profiles: ${error.message}`
            : "Failed to build customer recovery profiles.",
      },
      { status: 500 }
    );
  }
}
