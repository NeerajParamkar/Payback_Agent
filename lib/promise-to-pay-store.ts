import { promises as fs } from "fs";
import path from "path";
import { derivePromiseToPay } from "@/lib/promise-to-pay";
import type { PromiseToPay, Transaction } from "@/lib/types";

const DATA_FILE = path.join(process.cwd(), "data", "promises-to-pay.json");

export async function readPromisesToPay(): Promise<PromiseToPay[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw) as PromiseToPay[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writePromisesToPay(promises: PromiseToPay[]): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(promises, null, 2) + "\n", "utf-8");
}

export async function resetPromisesToPay(): Promise<void> {
  await writePromisesToPay([]);
}

/** Upserts one promise-to-pay record directly - used by the admin-recording
 * route (lib/promise-to-pay.ts's buildAdminRecordedPromise builds the record;
 * this just persists it). */
export async function recordPromiseToPay(promise: PromiseToPay): Promise<void> {
  const promises = await readPromisesToPay();
  await writePromisesToPay([
    ...promises.filter((p) => p.transactionId !== promise.transactionId),
    promise,
  ]);
}

/**
 * Re-derives and persists the single promise-to-pay record for one
 * transaction - used by every single-record resolution path (a real
 * customer's email click, a Razorpay webhook) that doesn't go through
 * run-batch's own batched pass, so a kept/broken promise is resolved the
 * moment payment actually happens, not just on the next batch run.
 */
export async function syncPromiseToPayFor(transaction: Transaction): Promise<void> {
  const promises = await readPromisesToPay();
  const existing = promises.find((p) => p.transactionId === transaction.id);
  const derived = derivePromiseToPay(transaction, existing);
  if (!derived) return;
  await writePromisesToPay([
    ...promises.filter((p) => p.transactionId !== transaction.id),
    derived,
  ]);
}
