import type { ModelRouteAttemptHistory } from "./contracts.ts";
import { ModelRouteRecoveredFailureError } from "./contracts.ts";

export function emptyAttemptHistory(): ModelRouteAttemptHistory {
  return { started: [], failed: [], succeeded: [], abandoned: [] };
}

export function maxAttempt(history: ModelRouteAttemptHistory): number {
  return Math.max(
    0,
    ...history.started,
    ...history.failed,
    ...(history.failedDetails ?? []).map((detail) => detail.transportAttempt),
    ...history.succeeded,
    ...history.abandoned,
  );
}

export function latestFailureAtCurrentAttempt(
  history: ModelRouteAttemptHistory,
): NonNullable<ModelRouteAttemptHistory["failedDetails"]>[number] | undefined {
  const details = [...(history.failedDetails ?? [])]
    .filter((detail) => history.failed.includes(detail.transportAttempt))
    .sort((a, b) => a.transportAttempt - b.transportAttempt);
  const latest = details.at(-1);
  return latest?.transportAttempt === maxAttempt(history) ? latest : undefined;
}

export function recoveredFailure(
  detail: NonNullable<ModelRouteAttemptHistory["failedDetails"]>[number],
): ModelRouteRecoveredFailureError {
  return new ModelRouteRecoveredFailureError(detail.errorCode, detail.disposition);
}
