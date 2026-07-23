import type { PhaseEnvelope } from "../../core/index.ts";
import type {
  OperationResultProjection,
  ResultRef,
} from "../../operation-result/index.ts";

export function projectOperationContext(envelope: PhaseEnvelope) {
  const latest = new Set(
    (envelope.latestOperationResultRefs ?? []).map(resultIdentity),
  );
  return {
    phaseContinuity: envelope.phaseContinuity ?? null,
    latestOperationResults: envelope.operationResults.filter(
      ({ resultRef }) => latest.has(resultIdentity(resultRef)),
    ),
    priorOperationResultIndex: envelope.operationResults
      .filter(({ resultRef }) => !latest.has(resultIdentity(resultRef)))
      .map(indexOperationResult),
  };
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
