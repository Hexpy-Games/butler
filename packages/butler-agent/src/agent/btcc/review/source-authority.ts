import type { ContentRef, OperationAuthority } from "../core/index.ts";
import type { ResultCandidateProduct, WorkspaceRevision } from "../execution/index.ts";

export type ReviewValidationSourceProjection =
  | Record<string, never>
  | {
      reviewSourceRef: ContentRef;
      reviewValidationSource: WorkspaceRevision;
    };

export function taskReviewAuthority(input: {
  baseline: OperationAuthority;
  result: ResultCandidateProduct["result"];
  predecessorResults?: ResultCandidateProduct["result"][];
}): OperationAuthority {
  const observationScopeRefs = unique([
    ...input.baseline.observationScopeRefs,
    ...input.result.operationResultReadScopeRefs,
    ...(input.predecessorResults ?? []).flatMap(
      (result) => result.operationResultReadScopeRefs,
    ),
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

export function projectReviewValidationSource(
  result: ResultCandidateProduct["result"],
): ReviewValidationSourceProjection {
  if (result.kind !== "workspace_artifact") return {};
  return {
    reviewSourceRef: result.workspaceRevisionRef,
    reviewValidationSource: result.workspaceRevision,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
