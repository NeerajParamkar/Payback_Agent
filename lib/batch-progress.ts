// In-memory progress for the currently running (or most recently finished) batch.
// Single-process only — fine for local dev / a single server instance, which is
// this project's deployment target. Not shared across serverless instances.

// Named pipeline stages shown in the UI while "Run Agent" is in flight. The first
// three are set explicitly by run-batch/route.ts at the point each genuinely
// happens (they run once, before the concurrent per-transaction loop starts).
// The middle four are per-transaction work (diagnose → decide → execute) that
// runs concurrently across a worker pool, so there's no single moment "all
// transactions" cross a boundary between them — instead they're driven by
// overall completion fraction (see stageForProgress), which is a real signal
// (genuine completions), not a fake timer. "monitoring_payments" covers the
// final re-sync/finalize pass after the loop, and "completed" is terminal.
export type BatchStage =
  | "idle"
  | "scanning"
  | "finding_revenue_at_risk"
  | "analysing_customer_history"
  | "calculating_scores"
  | "finding_root_causes"
  | "selecting_strategies"
  | "executing_actions"
  | "monitoring_payments"
  | "completed";

export const BATCH_STAGE_LABELS: Record<BatchStage, string> = {
  idle: "Idle",
  scanning: "Scanning transactions...",
  finding_revenue_at_risk: "Finding revenue at risk...",
  analysing_customer_history: "Analysing customer history...",
  calculating_scores: "Calculating recovery scores...",
  finding_root_causes: "Finding root causes...",
  selecting_strategies: "Selecting recovery strategies...",
  executing_actions: "Executing recovery actions...",
  monitoring_payments: "Monitoring payments...",
  completed: "Agent run completed.",
};

export interface BatchProgress {
  total: number;
  completed: number;
  running: boolean;
  stage: BatchStage;
}

let progress: BatchProgress = { total: 0, completed: 0, running: false, stage: "idle" };

export function startBatch(total: number): void {
  progress = { total, completed: 0, running: true, stage: "scanning" };
}

export function setBatchStage(stage: BatchStage): void {
  progress = { ...progress, stage };
}

// Maps how far through the concurrent per-transaction pool the batch is into
// one of the four "per-transaction" stage labels. Approximate by nature (workers
// run independently), but grounded in real completions rather than a timer.
function stageForProgress(completed: number, total: number): BatchStage {
  if (total <= 0) return "executing_actions";
  const fraction = completed / total;
  if (fraction < 0.25) return "calculating_scores";
  if (fraction < 0.5) return "finding_root_causes";
  if (fraction < 0.75) return "selecting_strategies";
  return "executing_actions";
}

export function incrementBatch(): void {
  const completed = progress.completed + 1;
  progress = { ...progress, completed, stage: stageForProgress(completed, progress.total) };
}

export function finishBatch(): void {
  progress = { ...progress, running: false, stage: "completed" };
}

export function getBatchProgress(): BatchProgress {
  return progress;
}
