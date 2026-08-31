import { promises as fs } from "fs";
import path from "path";
import { deriveRecoveryCase } from "@/lib/recovery-case";
import type { RecoveryCase, Transaction } from "@/lib/types";

const DATA_FILE = path.join(process.cwd(), "data", "recovery-cases.json");

export async function readRecoveryCases(): Promise<RecoveryCase[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw) as RecoveryCase[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeRecoveryCases(cases: RecoveryCase[]): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(cases, null, 2) + "\n", "utf-8");
}

export async function resetRecoveryCases(): Promise<void> {
  await writeRecoveryCases([]);
}

/**
 * Re-derives and persists the single Recovery Case for one transaction - used
 * by every single-record resolution path (a real customer's email click, a
 * Razorpay webhook) that doesn't go through run-batch's own batched case pass.
 */
export async function syncRecoveryCaseFor(transaction: Transaction): Promise<void> {
  const cases = await readRecoveryCases();
  const existing = cases.find((c) => c.transactionId === transaction.id);
  const derived = deriveRecoveryCase(transaction, existing);
  if (!derived) return;
  await writeRecoveryCases([
    ...cases.filter((c) => c.transactionId !== transaction.id),
    derived,
  ]);
}
