import type { ContentRef } from "../core/index.ts";

export type ReviewFindingCategory =
  | "implementation_nonconformance"
  | "authority_contradiction"
  | "goal_drift"
  | "task_decomposition"
  | "dependency_invalid"
  | "verification_incomplete"
  | "missing_observation";

export type CriterionVerdict = {
  criterionRef: ContentRef;
  verificationQuestionRefs: ContentRef[];
  currentTargetRevisionRefs: ContentRef[];
  reviewedResultRefs: ContentRef[];
  observationRefs: ContentRef[];
  verdict: "satisfied" | "not_satisfied";
  findingRefs: ContentRef[];
};

export type ReviewObservation = {
  ref: ContentRef;
  taskRef: ContentRef;
  attemptRef: ContentRef;
  executionTargetRef: ContentRef;
  targetRevisionRefs: ContentRef[];
  description: string;
  reviewedResultRefs: ContentRef[];
  reviewCheckpointRef: string;
};

export type ReviewFinding = {
  ref: ContentRef;
  rootCauseKey: string;
  affectedCriterionRefs: ContentRef[];
  taskRef: ContentRef;
  attemptRef: ContentRef;
  category: ReviewFindingCategory;
  statement: string;
  priority: "P0" | "P1" | "P2";
  recommendedDisposition: "required_now" | "backlog";
  origin:
    | { kind: "initial_review" }
    | { kind: "backlog_candidate" };
  targetRevisionRefs: ContentRef[];
};

export type ReviewFindingSet = {
  ref: ContentRef;
  owner: "task_review";
  findingRefs: ContentRef[];
};

export type ReviewFindingVerdict = {
  findingRef: ContentRef;
  verdict: "resolved" | "unresolved" | "regressed";
  observation: string;
};

export type TaskCorrectionScope = {
  ref: ContentRef;
  origin: "task_review";
  sourceTaskRef: ContentRef;
  sourceAttemptRef: ContentRef;
  findingSetRef: ContentRef;
};

export type TaskReviewProduct = {
  kind: "task_review";
  review: {
    ref: ContentRef;
    kind: "non_artifact" | "workspace_artifact" | "repository_promotion";
    turnId: string;
    goalContractRef: ContentRef;
    authorityRef: ContentRef;
    resultAuthorityRef: ContentRef;
    resultCandidateRef: ContentRef;
    workRef: ContentRef;
    taskRef: ContentRef;
    taskRevisionSha256: string;
    attemptRef: ContentRef;
    executionTargetRef: ContentRef;
    reviewCheckpointRef: string;
    criterionVerdicts: CriterionVerdict[];
    observations: ReviewObservation[];
    findings: ReviewFinding[];
    findingVerdicts: ReviewFindingVerdict[];
    reviewedResultRefs: ContentRef[];
    reviewedTargetStateRevisionRefs: ContentRef[];
    reviewedArtifactRevisionRefs: ContentRef[];
    reviewedEffectReceiptRefs: [];
    reviewValidationReceiptSetRefs: ContentRef[];
    reviewSourceRef?: ContentRef;
  } & (
    | { verdict: "passed"; findingSetRef?: never; correctionScopeRef?: never }
    | {
        verdict: "not_passed";
        findingSetRef: ContentRef;
        findingSet: ReviewFindingSet;
        correctionScopeRef: ContentRef;
        correctionScope: TaskCorrectionScope;
      }
  );
};
