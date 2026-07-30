import type {
  ObservationMetrics,
  RawBenchmarkObservation,
} from "./contracts.ts";

export function calculateObservationMetrics(
  observation: RawBenchmarkObservation,
): ObservationMetrics {
  const qualityScore = averageComplete([
    scoreOrNull(observation.quality.intentScore),
    scoreOrNull(observation.quality.resultScore),
  ]);
  const failedCalls = nonNegativeOrNull(observation.tools.failedCalls);
  const recoveredErrors = nonNegativeOrNull(observation.tools.recoveredErrors);
  const unrecoveredToolErrors = failedCalls === null || recoveredErrors === null ||
    recoveredErrors > failedCalls
    ? null
    : failedCalls - recoveredErrors;
  const durabilityPass = nullableEvery([
    observation.durability.finalMessagesBeforeReload === null
      ? null
      : observation.durability.finalMessagesBeforeReload === 1,
    observation.durability.finalMessagesAfterReload === null
      ? null
      : observation.durability.finalMessagesAfterReload === 1,
    observation.durability.eventReplayParity,
    observation.durability.continuationTested
      ? observation.durability.continuationSucceeded
      : true,
  ]);
  const safetyPass = nullableEvery(Object.values(observation.safety).map((value) =>
    value === null ? null : value === 0,
  ));
  const outcomes = Object.values(observation.quality.requiredOutcomes);
  const outcomesComplete = outcomes.length > 0 &&
    outcomes.every((value) => typeof value === "boolean");
  const metrics: ObservationMetrics = {
    measurementComplete: false,
    outcomeSuccess: observation.terminalState === "delivered" &&
      observation.finalText.trim().length > 0 &&
      outcomesComplete && outcomes.every(Boolean),
    qualityScore,
    totalTokens: nonNegativeOrNull(observation.usage.totalTokens),
    serializedContextBytes: nonNegativeOrNull(observation.usage.serializedContextBytes),
    acknowledgementMs: duration(
      observation.timing.submittedAtMs,
      observation.timing.acknowledgedAtMs,
    ),
    contextPreparationMs: duration(
      observation.timing.admittedAtMs,
      observation.timing.modelRequestStartedAtMs,
    ),
    providerFirstTokenMs: duration(
      observation.timing.modelRequestStartedAtMs,
      observation.timing.firstProviderTokenAtMs,
    ),
    firstMeaningfulMs: duration(
      observation.timing.submittedAtMs,
      observation.timing.firstMeaningfulAtMs,
    ),
    finalVisibleMs: duration(
      observation.timing.submittedAtMs,
      observation.timing.finalVisibleAtMs,
    ),
    productWallMs: duration(
      observation.timing.submittedAtMs,
      observation.timing.terminalAtMs,
    ),
    maxSilentGapMs: nonNegativeOrNull(observation.timing.maxSilentGapMs),
    unrecoveredToolErrors,
    durabilityPass,
    safetyPass,
    noProgressTurns: nonNegativeOrNull(observation.loop.noProgressTurns),
    validatorRejections: nonNegativeOrNull(observation.loop.validatorRejections),
  };
  metrics.measurementComplete = outcomesComplete && [
    metrics.qualityScore,
    metrics.totalTokens,
    metrics.serializedContextBytes,
    metrics.acknowledgementMs,
    metrics.contextPreparationMs,
    metrics.providerFirstTokenMs,
    metrics.firstMeaningfulMs,
    metrics.finalVisibleMs,
    metrics.productWallMs,
    metrics.maxSilentGapMs,
    metrics.unrecoveredToolErrors,
    metrics.durabilityPass,
    metrics.safetyPass,
    metrics.noProgressTurns,
    metrics.validatorRejections,
    nonNegativeOrNull(observation.usage.modelRequests),
    nonNegativeOrNull(observation.usage.promptTokens),
    nonNegativeOrNull(observation.usage.cachedPromptTokens),
    nonNegativeOrNull(observation.usage.outputTokens),
    nonNegativeOrNull(observation.tools.calls),
    nonNegativeOrNull(observation.tools.recoveryTimeMs),
    nonNegativeOrNull(observation.ux.protocolJargonMessages),
    nonNegativeOrNull(observation.ux.userInterventions),
  ].every((value) => value !== null);
  return metrics;
}

function scoreOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 1 && value <= 5
    ? value
    : null;
}

function duration(start: number | null, end: number | null): number | null {
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return end >= start ? end - start : null;
}

function averageComplete(values: Array<number | null>): number | null {
  return values.every((value): value is number => value !== null)
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function nullableEvery(values: Array<boolean | null>): boolean | null {
  return values.some((value) => value === null) ? null : values.every(Boolean);
}

function nonNegativeOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}
