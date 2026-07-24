import {
  indexOperationResult,
  type OperationResultIndexEntry,
  type OperationResultProjection,
} from "../operation-result/index.ts";

export type ConceptionPlanningContext = {
  observationResultIndex: OperationResultIndexEntry[];
};

export function retainConceptionPlanningContext(
  current: OperationResultProjection[],
  prior: ConceptionPlanningContext = { observationResultIndex: [] },
): ConceptionPlanningContext {
  const byResult = new Map(
    prior.observationResultIndex.map((entry) => [refKey(entry.resultRef), entry]),
  );
  for (const result of current) {
    const entry = indexOperationResult(result);
    const key = refKey(entry.resultRef);
    if (!byResult.has(key)) byResult.set(key, entry);
  }
  return { observationResultIndex: [...byResult.values()] };
}

function refKey(ref: { id: string; sha256: string }): string {
  return `${ref.id}:${ref.sha256}`;
}
