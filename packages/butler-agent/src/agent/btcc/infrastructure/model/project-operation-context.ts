import type { PhaseEnvelope } from "../../core/index.ts";
import type {
  OperationResultProjection,
  ResultRef,
} from "../../operation-result/index.ts";

export function projectOperationContext(envelope: PhaseEnvelope) {
  const latestCount = envelope.latestOperationResultCount ?? 0;
  const latestStart = envelope.operationResults.length - latestCount;
  if (latestStart < 0) {
    throw new Error("Latest operation batch exceeds the persisted result sequence");
  }
  const prior = envelope.operationResults.slice(0, latestStart);
  return {
    phaseContinuity: envelope.phaseContinuity ?? null,
    latestOperationResults: envelope.operationResults.slice(latestStart),
    priorOperationResultIndex: indexPriorResults(prior),
  };
}

function indexPriorResults(results: OperationResultProjection[]) {
  const byResult = new Map<string, ReturnType<typeof indexOperationResult>>();
  for (const result of results) {
    const identity = resultIdentity(result.resultRef);
    if (!byResult.has(identity)) byResult.set(identity, indexOperationResult(result));
  }
  return [...byResult.values()];
}

function indexOperationResult(result: OperationResultProjection) {
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
    ...(result.artifactRevisionRef
      ? { artifactRevisionRef: result.artifactRevisionRef }
      : {}),
    ...(result.targetSnapshotRef
      ? { targetSnapshotRef: result.targetSnapshotRef }
      : {}),
    ...(result.validationReceiptRef
      ? { validationReceiptRef: result.validationReceiptRef }
      : {}),
  };
}

function resultIdentity(ref: ResultRef): string {
  return `${ref.id}\0${ref.sha256}`;
}
