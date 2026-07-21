import type { ContentRef } from "../core/index.ts";

export type ManagedAttempt = {
  ref: ContentRef;
  taskRef: ContentRef;
  owningTurnId: string;
  createdByTurnRevision: number;
  previousAttemptRef?: ContentRef;
  correctionPlanRef?: ContentRef;
  executionTargetRef: ContentRef;
  executionTarget: {
    ref: ContentRef;
    taskRef: ContentRef;
    attemptRef: ContentRef;
    target: { kind: "non_artifact"; targetScopeRefs: string[] };
  };
  executionTargetBinding: {
    ref: ContentRef;
    programId: string;
    taskRef: ContentRef;
    attemptRef: ContentRef;
    executionTargetRef: ContentRef;
    creation: "accepted_non_artifact_selection";
  };
  status: "ready" | "result_submitted" | "review_failed" | "accepted" | "closed_unaccepted";
};

export type WorkFrontierDecision =
  | { kind: "select_task"; attempt: ManagedAttempt }
  | { kind: "close_frontier" };
