import { NextRequest, NextResponse } from "next/server";
import { runAgentForTransaction } from "@/lib/agent";
import { finishBatch, incrementBatch, startBatch } from "@/lib/batch-progress";
import { readTransactions, writeTransactions } from "@/lib/transactions-store";
import type { Transaction } from "@/lib/types";

// Number of transactions processed concurrently. Each transaction's own attempts
// are inherently sequential (escalation depends on the prior outcome), but
// different transactions are independent, so a small worker pool keeps a
// batch fast without hammering the Groq/Razorpay APIs at once.
const CONCURRENCY = 5;

async function processWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    runWorker
  );
  await Promise.all(workers);
  return results;
}

export async function POST(request: NextRequest) {
  let transactionIds: string[] | undefined;
  const body = await request.json().catch(() => null);
  if (body && Array.isArray(body.transactionIds)) {
    transactionIds = body.transactionIds.filter(
      (id: unknown): id is string => typeof id === "string"
    );
  }
  const selectedSet =
    transactionIds && transactionIds.length > 0
      ? new Set(transactionIds)
      : null;

  let transactions: Transaction[];
  try {
    transactions = await readTransactions();
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

  const errors: Record<string, string> = {};
  const runCount = selectedSet
    ? transactions.filter((t) => selectedSet.has(t.id)).length
    : transactions.length;
  startBatch(runCount);

  let updated: Transaction[];
  try {
    updated = await processWithConcurrency(
      transactions,
      CONCURRENCY,
      async (transaction) => {
        if (selectedSet && !selectedSet.has(transaction.id)) {
          return transaction; // not part of this run — left untouched
        }
        const { transaction: result, error } = await runAgentForTransaction(
          transaction
        );
        if (error) {
          errors[transaction.id] = error;
        }
        incrementBatch();
        return result;
      }
    );
  } finally {
    finishBatch();
  }

  try {
    await writeTransactions(updated);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to save transactions.json: ${error.message}`
            : "Failed to save transactions.json.",
      },
      { status: 500 }
    );
  }

  const totalAtRisk = updated.reduce((sum, t) => sum + t.amount, 0);
  const recoveredTransactions = updated.filter((t) => t.status === "recovered");
  const unrecoveredTransactions = updated.filter(
    (t) => t.status === "unrecovered"
  );
  const totalRecovered = recoveredTransactions.reduce(
    (sum, t) => sum + t.amount,
    0
  );
  const recoveryRate =
    totalAtRisk > 0 ? (totalRecovered / totalAtRisk) * 100 : 0;

  return NextResponse.json({
    summary: {
      totalAtRisk,
      totalRecovered,
      recoveryRate: Math.round(recoveryRate * 10) / 10,
      casesProcessed: updated.length,
      recoveredCount: recoveredTransactions.length,
      unrecoveredCount: unrecoveredTransactions.length,
    },
    transactions: updated,
    errors,
  });
}
