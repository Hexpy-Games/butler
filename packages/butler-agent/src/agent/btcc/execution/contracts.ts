import type { ContentRef } from "../core/index.ts";

export type ResultCandidateProduct = {
  kind: "result_candidate";
  result: {
    ref: ContentRef;
    goalContractRef: ContentRef;
    authorityRef: ContentRef;
    workRef: ContentRef;
    taskRef: ContentRef;
    attemptRef: ContentRef;
    executionTargetRef: ContentRef;
    resultSummary: string;
    observedState: {
      ref: ContentRef;
      state: "present";
      description: string;
    };
    artifactRevisionRefs: [];
    effectReceiptRefs: [];
  };
};
