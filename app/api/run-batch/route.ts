import { NextRequest, NextResponse } from "next/server";
import { runAgentForTransaction } from "@/lib/agent";
import { finishBatch, incrementBatch, setBatchStage, startBatch } from "@/lib/batch-progress";
import { buildCustomerRecoveryProfiles, customerIdentityKey } from "@/lib/customer-recovery";
import type { CustomerHistoryContext } from "@/lib/diagnose";
import { markCaseAnalysing, upsertRecoveryCases } from "@/lib/recovery-case";
import { readRecoveryCases, writeRecoveryCases } from "@/lib/recovery-case-store";
import { upsertEscalationEntries } from "@/lib/escalation-queue";
import { readEscalationQueue, writeEscalationQueue } from "@/lib/escalation-queue-store";
import { upsertPromisesToPay } from "@/lib/promise-to-pay";
import { readPromisesToPay, writePromisesToPay } from "@/lib/promise-to-pay-store";
import { readTransactions, writeTransactions } from "@/lib/transactions-store";
import type { Transaction } from "@/lib/types";

// Lightweight projection of a CustomerRecoveryProfile fed to the diagnosis prompt -
// see CustomerHistoryContext in lib/diagnose.ts for what each field means.
function toCustomerHistory(
  profile: ReturnType<typeof buildCustomerRecoveryProfiles>[number]
): CustomerHistoryContext {
  return {
    totalTransactions: profile.totalTransactions,
    successfulTransactions: profile.successfulTransactions,
    failedTransactions: profile.failedTransactions,
    previousRecoveryAttempts: profile.previousRecoveryAttempts,
    successfulRecoveryActions: profile.successfulRecoveryActions,
    failedRecoveryActions: profile.failedRecoveryActions,
    preferredRecoveryChannel: profile.preferredRecoveryChannel,
  };
}

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

  // Pre-run snapshot, keyed by id - the baseline every "what changed THIS run"
  // summary figure (recovery cases created, actions executed, new escalations)
  // is diffed against below.
  const originalById = new Map(transactions.map((t) => [t.id, t]));

  try {
    // Every unpaid order is genuinely at-risk revenue, whether or not it's part of
    // this run - ensure each has a Recovery Case (creating a "detected" one if
    // missing; already-paid orders never get one - see deriveRecoveryCase). Cases
    // for transactions this run is about to actually process get bumped to
    // "analysing" so they read as picked-up rather than merely detected.
    setBatchStage("finding_revenue_at_risk");
    let recoveryCases = await readRecoveryCases();
    const recoveryCaseIdsBefore = new Set(recoveryCases.map((c) => c.transactionId));
    recoveryCases = upsertRecoveryCases(recoveryCases, transactions);
    const recoveryCasesCreated = recoveryCases.filter(
      (c) => !recoveryCaseIdsBefore.has(c.transactionId)
    ).length;
    recoveryCases = recoveryCases.map((c) =>
      !selectedSet || selectedSet.has(c.transactionId) ? markCaseAnalysing(c) : c
    );
    await writeRecoveryCases(recoveryCases);

    // Computed once up front from the pre-run snapshot, not recomputed per
    // transaction - so a customer's history reflects their established pattern
    // from before this run, not attempts happening within this same batch call.
    setBatchStage("analysing_customer_history");
    const customerProfilesById = new Map(
      buildCustomerRecoveryProfiles(transactions).map((p) => [p.customerId, p])
    );

    // Transactions another overlapping request was already holding the lock for -
    // this run's own copy of them is stale (unmodified from its initial read) and
    // must never be written back, since the concurrent holder may have since
    // persisted real changes to them.
    const lockedElsewhereIds = new Set<string>();

    // Per-transaction diagnose -> decide -> execute runs concurrently across a
    // worker pool (see processWithConcurrency); incrementBatch() advances the
    // reported stage through calculating_scores / finding_root_causes /
    // selecting_strategies / executing_actions as real completions accrue.
    setBatchStage("calculating_scores");
    let updated: Transaction[] = await processWithConcurrency(
      transactions,
      CONCURRENCY,
      async (transaction) => {
        if (selectedSet && !selectedSet.has(transaction.id)) {
          return transaction; // not part of this run — left untouched
        }
        const profile = customerProfilesById.get(customerIdentityKey(transaction));
        const { transaction: result, error, locked } = await runAgentForTransaction(
          transaction,
          profile ? toCustomerHistory(profile) : undefined
        );
        if (error) {
          errors[transaction.id] = error;
        }
        if (locked) {
          lockedElsewhereIds.add(transaction.id);
        }
        incrementBatch();
        return result;
      }
    );

    setBatchStage("monitoring_payments");

    try {
      // Synchronization guard against a concurrent writer (another overlapping
      // batch request, a real customer's email click, or a Razorpay webhook):
      // re-read the current file right before writing, and for any transaction
      // this run did NOT itself genuinely process - lock-blocked, or simply
      // outside this run's own selection - keep whatever is currently on disk
      // instead of this run's stale pre-read copy. A blind whole-array overwrite
      // could otherwise silently erase a payment a webhook just recorded while
      // this batch was still running.
      const current = await readTransactions();
      const currentById = new Map(current.map((t) => [t.id, t]));
      const toWrite = updated.map((t) => {
        const genuinelyProcessed = (!selectedSet || selectedSet.has(t.id)) && !lockedElsewhereIds.has(t.id);
        return genuinelyProcessed ? t : (currentById.get(t.id) ?? t);
      });
      await writeTransactions(toWrite);
      updated = toWrite;
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

    // Finalize cases for exactly the transactions this run actually processed,
    // from their post-run state (recovery_active / awaiting_customer / recovered /
    // escalated / stopped / failed - see deriveRecoveryCase).
    const processedTransactions = selectedSet
      ? updated.filter((t) => selectedSet.has(t.id))
      : updated;
    recoveryCases = upsertRecoveryCases(recoveryCases, processedTransactions);
    await writeRecoveryCases(recoveryCases);

    // Any transaction this run just escalated gets a Human Escalation Queue
    // entry (lib/escalation-queue.ts); one that was already in the queue but
    // moved out of "escalated" (an admin resolved it earlier) is left untouched.
    const escalationQueue = upsertEscalationEntries(
      await readEscalationQueue(),
      processedTransactions
    );
    await writeEscalationQueue(escalationQueue);

    // Same for promises-to-pay: a fresh one is created for anything this run put
    // into "promise_to_pay" (the Decision Engine's automated inference), and any
    // existing pending one is resolved to kept/broken against the final state.
    const promisesToPay = upsertPromisesToPay(
      await readPromisesToPay(),
      processedTransactions
    );
    await writePromisesToPay(promisesToPay);

    // "Actions executed" counts only decisions that reached executeAction() in
    // lib/agent.ts (a real payment link, retry, email, or reminder) - wait/stop/
    // escalate_to_human/track_promise_to_pay are deliberate non-actions there.
    const EXECUTED_DECISION_ACTIONS = new Set([
      "generate_payment_link",
      "retry",
      "send_email",
      "send_reminder",
    ]);
    let actionsExecuted = 0;
    let humanEscalations = 0;
    for (const t of processedTransactions) {
      const original = originalById.get(t.id);
      const newAttempts = t.attempts.slice(original?.attempts.length ?? 0);
      if (newAttempts.some((a) => EXECUTED_DECISION_ACTIONS.has(a.decisionAction))) {
        actionsExecuted += 1;
      }
      if (t.status === "escalated" && original?.status !== "escalated") {
        humanEscalations += 1;
      }
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
        transactionsAnalysed: processedTransactions.length,
        totalAtRisk,
        totalRecovered,
        recoveryRate: Math.round(recoveryRate * 10) / 10,
        recoveryCasesCreated,
        actionsExecuted,
        humanEscalations,
        recoveredCount: recoveredTransactions.length,
        unrecoveredCount: unrecoveredTransactions.length,
      },
      transactions: updated,
      errors,
    });
  } finally {
    finishBatch();
  }
}
