import type { PhaseEnvelope } from "../../core/index.ts";
import type {
  OperationResultIndexEntry,
  OperationResultProjection,
  ResultRef,
} from "../../operation-result/index.ts";
import { indexOperationResult } from "../../operation-result/index.ts";

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
  const byResult = new Map<string, OperationResultIndexEntry>();
  for (const result of results) {
    const identity = resultIdentity(result.resultRef);
    if (!byResult.has(identity)) byResult.set(identity, indexOperationResult(result));
  }
  return [...byResult.values()];
}

function resultIdentity(ref: ResultRef): string {
  return `${ref.id}\0${ref.sha256}`;
}
