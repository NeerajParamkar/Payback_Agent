import { promises as fs } from "fs";
import path from "path";
import type { Transaction } from "@/lib/types";

const DATA_FILE = path.join(process.cwd(), "data", "customer-history.json");

/**
 * Permanent reference data: past, already-resolved transactions that give
 * Customer Recovery Intelligence (lib/customer-recovery.ts) genuine history
 * to score from instead of deriving a customer's whole profile from a single
 * open transaction. Deliberately its own file, separate from
 * transactions.json/transactions-seed.json:
 * - never shown in the operational Dashboard/Insights/Overview tables, which
 *   should only ever reflect the CURRENT at-risk batch, not old closed-out
 *   history mixed in;
 * - never touched by POST /api/reset ("Reset Demo Data" resets the current
 *   session's mutable state, not this permanent baseline history).
 * Combined with the live transactions wherever a customer's full profile or
 * score is built - see app/api/customers/**, app/api/run-batch/route.ts.
 */
export async function readCustomerHistoryTransactions(): Promise<Transaction[]> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw) as Transaction[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
