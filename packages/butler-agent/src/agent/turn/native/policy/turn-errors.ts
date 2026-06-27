const DEFAULT_GOAL_COMPLETION_CONTINUATION_ATTEMPTS = 8;
const DIRECT_WORK_FINALIZATION_REPAIR_ATTEMPTS = 1;

export function runtimeTurnAbortError(): Error {
  const error = new Error("Runtime turn was cancelled.");
  error.name = "AbortError";
  return error;
}

export function goalCompletionIncompleteError(reason: string, progressFinalizationText?: string): Error {
  const error = new Error(reason || "Butler could not complete this turn.");
  error.name = "GoalCompletionIncompleteError";
  if (progressFinalizationText?.trim()) {
    (error as Error & { progressFinalizationText?: string }).progressFinalizationText =
      progressFinalizationText.trim();
  }
  return error;
}

export function goalCompletionContinuationAttempts(): number {
  const raw = process.env.BUTLER_GOAL_COMPLETION_CONTINUATION_ATTEMPTS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_GOAL_COMPLETION_CONTINUATION_ATTEMPTS;
  return Math.max(0, Math.min(parsed, 100));
}

export function directWorkContinuationAttempts(): number {
  const raw = process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return DIRECT_WORK_FINALIZATION_REPAIR_ATTEMPTS;
  return Math.max(0, Math.min(parsed, DIRECT_WORK_FINALIZATION_REPAIR_ATTEMPTS));
}

export function throwIfRuntimeTurnAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw runtimeTurnAbortError();
}
