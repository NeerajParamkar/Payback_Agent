// In-memory, per-process lock preventing the same order from being processed
// by two overlapping recovery-workflow calls at once - the concrete guarantee
// behind "the same agent run cannot create duplicate reminders or payment
// links" when two requests race (e.g. a double-clicked "Run Batch", or a
// batch run and a real customer's email click landing at the same moment).
// Single-process only, matching this app's architecture - same pattern as
// lib/batch-progress.ts.

const processing = new Set<string>();

export function tryAcquireLock(transactionId: string): boolean {
  if (processing.has(transactionId)) return false;
  processing.add(transactionId);
  return true;
}

export function releaseLock(transactionId: string): void {
  processing.delete(transactionId);
}
