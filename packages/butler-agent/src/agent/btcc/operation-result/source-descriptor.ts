import type { OperationRequest } from "../core/contracts.ts";
import type {
  OperationResultIndexEntry,
  OperationResultProjection,
  OperationSourceDescriptor,
} from "./contracts.ts";

export function describeOperationSource(
  request: OperationRequest,
): OperationSourceDescriptor {
  if (request.kind === "observe") {
    return {
      kind: request.kind,
      capabilityRef: request.capabilityRef,
      scopeRef: request.scopeRef,
      input: request.input,
    };
  }
  if (request.kind === "workspace_artifact_observation") {
    return {
      kind: request.kind,
      capabilityRef: request.capabilityRef,
      workspaceRef: request.workspaceRef,
      input: request.input,
    };
  }
  if (request.kind === "review_validation") {
    return {
      kind: request.kind,
      capabilityRef: request.capabilityRef,
      reviewSourceRef: request.reviewSourceRef,
      input: request.input,
    };
  }
  if (request.kind === "workspace_artifact_action") {
    return {
      kind: request.kind,
      capabilityRef: request.capabilityRef,
      workspaceRef: request.workspaceRef,
      relativeTarget: request.relativeTarget,
    };
  }
  if (request.kind === "external_effect") {
    return {
      kind: request.kind,
      capabilityRef: request.capabilityRef,
      effectIntentRef: request.effectIntentRef,
      occurrenceKey: request.occurrenceKey,
      targetScopeRef: request.targetScopeRef,
      input: request.input,
    };
  }
  return {
    kind: request.kind,
    capabilityRef: request.capabilityRef,
    authorizationRef: request.authorizationRef,
    candidateRef: request.candidateRef,
    resolutionRef: request.resolutionRef,
    baselineRef: request.baselineRef,
    finalSnapshotRef: request.finalSnapshotRef,
  };
}

export function indexOperationResult(
  result: OperationResultProjection,
): OperationResultIndexEntry {
  return {
    resultRef: result.resultRef,
    requestRef: result.requestRef,
    requestId: result.requestId,
    capabilityRef: result.capabilityRef,
    source: describeOperationSource(result.request),
    outcome: result.outcome,
    completeness: result.completeness,
    byteLength: result.byteLength,
    observationRef: result.observationRef,
    readScopeRef: result.readScopeRef,
    ...(result.executionSummary ? { executionSummary: result.executionSummary } : {}),
    ...resultRefs(result),
  };
}

function resultRefs(result: OperationResultProjection) {
  return {
    ...(result.artifactRevisionRef ? { artifactRevisionRef: result.artifactRevisionRef } : {}),
    ...(result.targetSnapshotRef ? { targetSnapshotRef: result.targetSnapshotRef } : {}),
    ...(result.validationReceiptRef ? { validationReceiptRef: result.validationReceiptRef } : {}),
    ...(result.effectReceiptRef ? { effectReceiptRef: result.effectReceiptRef } : {}),
    ...(result.transactionRef ? { transactionRef: result.transactionRef } : {}),
    ...(result.commitJournalRef ? { commitJournalRef: result.commitJournalRef } : {}),
    ...(result.promotionReceiptRef ? { promotionReceiptRef: result.promotionReceiptRef } : {}),
    ...(result.promotedSnapshotRef ? { promotedSnapshotRef: result.promotedSnapshotRef } : {}),
  };
}
