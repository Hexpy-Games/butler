import type { OperationAuthority } from "../core/index.ts";
import type { ResultCandidateProduct } from "../execution/index.ts";

export function taskReviewAuthority(input: {
  baseline: OperationAuthority;
  result: ResultCandidateProduct["result"];
}): OperationAuthority {
  const exactResultScopes = input.result.operationResults.map((result) => result.readScopeRef);
  const observationScopeRefs = unique([
    ...input.baseline.observationScopeRefs,
    ...exactResultScopes,
  ]);
  if (input.result.kind !== "workspace_artifact") {
    return { ...input.baseline, observationScopeRefs };
  }
  return {
    observationScopeRefs: observationScopeRefs.filter(
      (scopeRef) => !scopeRef.startsWith("workspace:"),
    ),
    mutation: {
      kind: "validation_overlay_only",
      reviewSourceRef: input.result.workspaceRevisionRef,
    },
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
