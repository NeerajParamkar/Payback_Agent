import { NextResponse } from "next/server";
import { buildCustomerRecoveryProfiles } from "@/lib/customer-recovery";
import { readCustomerHistoryTransactions } from "@/lib/customer-history-store";
import { readTransactions } from "@/lib/transactions-store";

export async function GET() {
  try {
    const [transactions, history] = await Promise.all([
      readTransactions(),
      readCustomerHistoryTransactions(),
    ]);
    const customers = buildCustomerRecoveryProfiles([...history, ...transactions]);
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
