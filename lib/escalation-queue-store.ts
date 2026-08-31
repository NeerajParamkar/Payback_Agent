import { promises as fs } from "fs";
import path from "path";
import { deriveEscalationEntry } from "@/lib/escalation-queue";
import type { EscalationQueueEntry, EscalationResolution, Transaction } from "@/lib/types";

const DATA_FILE = path.join(process.cwd(), "data", "escalation-queue.json");

export async function readEscalationQueue(): Promise<EscalationQueueEntry[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw) as EscalationQueueEntry[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeEscalationQueue(entries: EscalationQueueEntry[]): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(entries, null, 2) + "\n", "utf-8");
}

export async function resetEscalationQueue(): Promise<void> {
  await writeEscalationQueue([]);
}

/**
 * Re-derives and persists the single escalation queue entry for one
 * transaction - used by every single-record resolution path (a real
 * customer's email click, a Razorpay webhook) that doesn't go through
 * run-batch's own batched pass.
 */
export async function syncEscalationEntryFor(transaction: Transaction): Promise<void> {
  const entries = await readEscalationQueue();
  const existing = entries.find((e) => e.transactionId === transaction.id);
  const derived = deriveEscalationEntry(transaction, existing);
  if (!derived) return;
  await writeEscalationQueue([
    ...entries.filter((e) => e.transactionId !== transaction.id),
    derived,
  ]);
}

/**
 * Resolves any still-open escalation entry for a transaction - used by
 * general-purpose admin actions (lib/manual-payment-actions.ts) that mutate a
 * transaction outside the escalation-queue action route itself, so a payment
 * recorded that way still closes out a dangling escalation instead of leaving
 * it open forever. A safe no-op when there's no open entry for this order.
 */
export async function resolveEscalationForTransaction(
  transactionId: string,
  resolution: EscalationResolution
): Promise<void> {
  const entries = await readEscalationQueue();
  const index = entries.findIndex((e) => e.transactionId === transactionId && e.status !== "resolved");
  if (index === -1) return;
  entries[index] = {
    ...entries[index],
    status: "resolved",
    resolution,
    updatedAt: new Date().toISOString(),
  };
  await writeEscalationQueue(entries);
}
