import type { ContentRef } from "../core/index.ts";

export type TaskReviewProduct = {
  kind: "task_review";
  review: {
    ref: ContentRef;
    goalContractRef: ContentRef;
    authorityRef: ContentRef;
    resultCandidateRef: ContentRef;
    taskRef: ContentRef;
    attemptRef: ContentRef;
    criterionRef: ContentRef;
    observation: { ref: ContentRef; observedStateRef: ContentRef; description: string };
  } & (
    | { verdict: "passed"; findingSetRef?: never; correctionScopeRef?: never }
    | {
        verdict: "not_passed";
        findingSetRef: ContentRef;
        correctionScopeRef: ContentRef;
        finding: { ref: ContentRef; category: "implementation_nonconformance"; statement: string };
      }
  );
};
