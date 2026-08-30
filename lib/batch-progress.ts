// In-memory progress for the currently running (or most recently finished) batch.
// Single-process only — fine for local dev / a single server instance, which is
// this project's deployment target. Not shared across serverless instances.

export interface BatchProgress {
  total: number;
  completed: number;
  running: boolean;
}

let progress: BatchProgress = { total: 0, completed: 0, running: false };

export function startBatch(total: number): void {
  progress = { total, completed: 0, running: true };
}

export function incrementBatch(): void {
  progress = { ...progress, completed: progress.completed + 1 };
}

export function finishBatch(): void {
  progress = { ...progress, running: false };
}

export function getBatchProgress(): BatchProgress {
  return progress;
}
