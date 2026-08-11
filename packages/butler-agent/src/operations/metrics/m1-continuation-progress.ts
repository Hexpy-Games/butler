import { recordOperationalMetric } from "./operational-metrics.ts";
import type { ModelRouteEvent } from
  "../../agent/btcc/model-route/contracts.ts";
import { isTurnContinuationBudgetExhaustedError } from
  "../../agent/btcc/turn/continuation-budget.ts";

export const M1_CONTINUATION_PROGRESS_METRIC_NAME =
  "m1_continuation_progress" as const;

export function createM1ContinuationProgressRecorder(input: {
  butlerData: string;
  turnId: string;
  routeDigest: string;
  cachePrefixHash: string;
  flagRevision: string;
}) {
  let errorRecorded = false;
  let recordCount = 0;
  const record = (
    status: "ok" | "error" | "skipped",
    event: ModelRouteEvent | null,
    terminalReason: string | null,
  ): void => {
    recordCount += 1;
    recordOperationalMetric({
      category: "runtime",
      name: M1_CONTINUATION_PROGRESS_METRIC_NAME,
      status,
      value: event?.type === "model.attempt.started" ? 1 : 0,
      unit: "model_round",
      dimensions: {
        turnId: input.turnId,
        phaseId: "guided",
        routeDigest: input.routeDigest,
        cursor: event?.candidateIndex ?? null,
        terminalReason,
        flagRevision: input.flagRevision,
        requestHash: event?.requestHash ?? null,
        cachePrefixHash: input.cachePrefixHash,
        remainingBudget: null,
        novelResultRef: null,
        terminalReceiptCode: terminalReason
          ? "turn_continuation_budget_exhausted"
          : null,
      },
    }, { butlerData: input.butlerData });
  };

  return {
    observeRouteEvent(event: ModelRouteEvent): void {
      if (event.type === "model.attempt.started") record("ok", event, null);
    },
    observeError(error: unknown): void {
      if (errorRecorded) return;
      errorRecorded = true;
      record(
        "error",
        null,
        isTurnContinuationBudgetExhaustedError(error)
          ? error.receipt.reason
          : null,
      );
    },
    finalize(): void {
      if (recordCount === 0) record("skipped", null, null);
    },
  };
}
