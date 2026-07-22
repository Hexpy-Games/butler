import type { ContentRef, OperationAuthority } from "../core/index.ts";

export function artifactReviewAuthority(input: {
  baseline: OperationAuthority;
  reviewSourceRef: ContentRef;
}): OperationAuthority {
  return {
    observationScopeRefs: input.baseline.observationScopeRefs.filter(
      (scopeRef) => !scopeRef.startsWith("workspace:"),
    ),
    mutation: {
      kind: "validation_overlay_only",
      reviewSourceRef: input.reviewSourceRef,
    },
  };
}
