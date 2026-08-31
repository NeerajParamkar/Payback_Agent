import { promises as fs } from "fs";
import path from "path";
import type { Transaction } from "@/lib/types";

const DATA_FILE = path.join(process.cwd(), "data", "transactions.json");
const SEED_FILE = path.join(process.cwd(), "data", "transactions-seed.json");

export async function readTransactions(): Promise<Transaction[]> {
  const raw = await fs.readFile(DATA_FILE, "utf-8");
  return JSON.parse(raw) as Transaction[];
}

export async function getTransaction(transactionId: string): Promise<Transaction | null> {
  const transactions = await readTransactions();
  return transactions.find((t) => t.id === transactionId) ?? null;
}

export async function writeTransactions(
  transactions: Transaction[]
): Promise<void> {
  await fs.writeFile(
    DATA_FILE,
    JSON.stringify(transactions, null, 2) + "\n",
    "utf-8"
  );
}

/**
 * Restores data/transactions.json from the permanent seed file, resetting
 * every transaction back to its original "pending" state with no attempts.
 */
export async function resetTransactions(): Promise<Transaction[]> {
  const raw = await fs.readFile(SEED_FILE, "utf-8");
  const seedTransactions = JSON.parse(raw) as Transaction[];
  await writeTransactions(seedTransactions);
  return seedTransactions;
}

/**
 * Reads fresh, applies `updater` to the one matching transaction, and writes
 * back immediately - the whole file is still rewritten (this is a flat-file
 * store, not a real per-record database), but reading right before writing
 * rather than working from an older snapshot narrows the window in which a
 * concurrent writer's changes to OTHER transactions could be lost to almost
 * nothing. Used by single-record mutators (the Razorpay webhook handler)
 * where there's no slow work between read and write.
 */
export async function updateTransaction(
  transactionId: string,
  updater: (transaction: Transaction) => Transaction
): Promise<Transaction | null> {
  const transactions = await readTransactions();
  const index = transactions.findIndex((t) => t.id === transactionId);
  if (index === -1) return null;
  const updated = updater(transactions[index]);
  transactions[index] = updated;
  await writeTransactions(transactions);
  return updated;
}
