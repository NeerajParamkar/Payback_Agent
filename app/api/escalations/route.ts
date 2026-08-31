import { NextResponse } from "next/server";
import { readEscalationQueue } from "@/lib/escalation-queue-store";
import { readTransactions } from "@/lib/transactions-store";

// Each row pairs the lightweight queue entry with its transaction's full
// recovery timeline (attempts) - the queue must show previous actions,
// customer responses, and the complete timeline, and that data already lives
// on Transaction.attempts rather than being duplicated onto the entry itself.
export async function GET() {
  try {
    const [entries, transactions] = await Promise.all([readEscalationQueue(), readTransactions()]);
    const transactionsById = new Map(transactions.map((t) => [t.id, t]));

    const rows = entries
      .map((entry) => ({
        entry,
        transaction: transactionsById.get(entry.transactionId) ?? null,
      }))
      .filter((row) => row.transaction !== null);

    return NextResponse.json({ rows });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to read escalation queue: ${error.message}`
            : "Failed to read escalation queue.",
      },
      { status: 500 }
    );
  }
}
