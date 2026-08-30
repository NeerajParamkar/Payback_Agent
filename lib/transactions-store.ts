import { promises as fs } from "fs";
import path from "path";
import type { Transaction } from "@/lib/types";

const DATA_FILE = path.join(process.cwd(), "data", "transactions.json");
const SEED_FILE = path.join(process.cwd(), "data", "transactions-seed.json");

export async function readTransactions(): Promise<Transaction[]> {
  const raw = await fs.readFile(DATA_FILE, "utf-8");
  return JSON.parse(raw) as Transaction[];
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
