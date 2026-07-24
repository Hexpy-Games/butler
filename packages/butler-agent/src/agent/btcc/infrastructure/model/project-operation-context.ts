import type { PhaseEnvelope } from "../../core/index.ts";
import type {
  OperationResultIndexEntry,
  OperationResultProjection,
  ResultRef,
} from "../../operation-result/index.ts";
import {
  indexOperationResult,
  isResultReadRequest,
  stableJson,
} from "../../operation-result/index.ts";

export type ProjectedOperationContext = {
  phaseContinuity: PhaseEnvelope["phaseContinuity"] | null;
  latestOperationResults: OperationResultProjection[];
  selectedOperationResultViews: OperationResultProjection[];
  priorOperationResultIndex: OperationResultIndexEntry[];
};

export function projectOperationContext(envelope: PhaseEnvelope): ProjectedOperationContext {
  const latestCount = envelope.latestOperationResultCount ?? 0;
  const latestStart = envelope.operationResults.length - latestCount;
  if (latestStart < 0) {
    throw new Error("Latest operation batch exceeds the persisted result sequence");
  }
  const prior = envelope.operationResults.slice(0, latestStart);
  const latest = envelope.operationResults.slice(latestStart);
  return {
    phaseContinuity: envelope.phaseContinuity ?? null,
    latestOperationResults: latest,
    selectedOperationResultViews: selectedViews(prior, latest),
    priorOperationResultIndex: indexPriorResults(prior),
  };
}

export function operationContextCompactionCandidates(
  projected: ProjectedOperationContext,
): ProjectedOperationContext[] {
  const candidates = [projected];
  let selected = [...projected.selectedOperationResultViews];
  let latest = [...projected.latestOperationResults];

  while (selected.length > 0) {
    selected = selected.slice(1);
    candidates.push(withPayloadSet(projected, latest, selected));
  }
  while (latest.length > 0) {
    latest = latest.slice(1);
    candidates.push(withPayloadSet(projected, latest, selected));
  }
  return candidates;
}

function selectedViews(
  prior: OperationResultProjection[],
  latest: OperationResultProjection[],
): OperationResultProjection[] {
  const latestKeys = new Set(latest.filter(hasSelectedView).map(viewKey));
  const byView = new Map<string, OperationResultProjection>();
  for (const result of prior) {
    if (!hasSelectedView(result)) continue;
    const key = viewKey(result);
    if (!latestKeys.has(key)) byView.set(key, result);
  }
  return [...byView.values()];
}

function hasSelectedView(result: OperationResultProjection): boolean {
  return isResultReadRequest(result.request) && Boolean(result.view);
}

function viewKey(result: OperationResultProjection): string {
  return `${resultIdentity(result.resultRef)}\0${stableJson(result.request.input)}`;
}

function withPayloadSet(
  projected: ProjectedOperationContext,
  latest: OperationResultProjection[],
  selected: OperationResultProjection[],
): ProjectedOperationContext {
  const retained = new Set([...latest, ...selected]);
  const compacted = [
    ...projected.latestOperationResults,
    ...projected.selectedOperationResultViews,
  ].filter((result) => !retained.has(result));
  return {
    ...projected,
    latestOperationResults: latest,
    selectedOperationResultViews: selected,
    priorOperationResultIndex: indexPriorResults([
      ...projected.priorOperationResultIndex,
      ...compacted,
    ]),
  };
}

function indexPriorResults(
  results: Array<OperationResultProjection | OperationResultIndexEntry>,
) {
  const byResult = new Map<string, OperationResultIndexEntry>();
  for (const result of results) {
    if (isIndexEntry(result)) {
      const identity = resultIdentity(result.resultRef);
      if (!byResult.has(identity)) byResult.set(identity, result);
      continue;
    }
    const identity = resultIdentity(result.resultRef);
    if (!byResult.has(identity)) byResult.set(identity, indexOperationResult(result));
  }
  return [...byResult.values()];
}

function isIndexEntry(
  result: OperationResultProjection | OperationResultIndexEntry,
): result is OperationResultIndexEntry {
  return "source" in result;
}

function resultIdentity(ref: ResultRef): string {
  return `${ref.id}\0${ref.sha256}`;
}
