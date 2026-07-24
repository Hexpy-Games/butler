import type { OperationResultProjection } from "../operation-result/index.ts";
import type { PhaseInvocation } from "../core/index.ts";
import type { PlanningObservationResultIndexEntry } from "./contracts.ts";

export function admitPlanningObservations(
  phase: PhaseInvocation,
  observations: PlanningObservationResultIndexEntry[],
): PhaseInvocation {
  if (observations.length === 0) return phase;
  return {
    ...phase,
    operationAuthority: {
      ...phase.operationAuthority,
      observationScopeRefs: [...new Set([
        ...phase.operationAuthority.observationScopeRefs,
        ...observations.map((entry) => entry.readScopeRef),
      ])],
    },
  };
}

export function retainPlanningObservations(
  prior: PlanningObservationResultIndexEntry[],
  current: OperationResultProjection[],
): PlanningObservationResultIndexEntry[] {
  const byResult = new Map(prior.map((entry) => [refKey(entry.resultRef), entry]));
  for (const result of current) {
    const entry = indexOperationResult(result);
    const key = refKey(entry.resultRef);
    if (!byResult.has(key)) byResult.set(key, entry);
  }
  return [...byResult.values()];
}

function indexOperationResult(
  result: OperationResultProjection,
): PlanningObservationResultIndexEntry {
  return {
    resultRef: result.resultRef,
    requestRef: result.requestRef,
    requestId: result.requestId,
    capabilityRef: result.capabilityRef,
    outcome: result.outcome,
    completeness: result.completeness,
    byteLength: result.byteLength,
    observationRef: result.observationRef,
    readScopeRef: result.readScopeRef,
    ...(result.artifactRevisionRef ? { artifactRevisionRef: result.artifactRevisionRef } : {}),
    ...(result.targetSnapshotRef ? { targetSnapshotRef: result.targetSnapshotRef } : {}),
    ...(result.validationReceiptRef ? { validationReceiptRef: result.validationReceiptRef } : {}),
  };
}

function refKey(ref: { id: string; sha256: string }): string {
  return `${ref.id}:${ref.sha256}`;
}
