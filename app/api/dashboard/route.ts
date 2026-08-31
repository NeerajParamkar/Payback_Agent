import { NextResponse } from "next/server";
import { buildDashboardAnalytics } from "@/lib/dashboard-analytics";
import { readEscalationQueue } from "@/lib/escalation-queue-store";
import { readRecoveryCases } from "@/lib/recovery-case-store";
import { readTransactions } from "@/lib/transactions-store";

export async function GET() {
  try {
    const [transactions, recoveryCases, escalationEntries] = await Promise.all([
      readTransactions(),
      readRecoveryCases(),
      readEscalationQueue(),
    ]);
    const analytics = buildDashboardAnalytics(transactions, recoveryCases, escalationEntries);
    return NextResponse.json(analytics);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to build dashboard analytics: ${error.message}`
            : "Failed to build dashboard analytics.",
      },
      { status: 500 }
    );
  }
}
