import type { ContentRef } from "../core/index.ts";
import type {
  PlanningCandidate,
  PlanningObservationResultIndexEntry,
  PlanningProposal,
} from "./contracts.ts";

export type PlanningReview = {
  ref: ContentRef;
  candidateRef: ContentRef;
  originalGoalContractRef: ContentRef;
  reviewedBundleRef: ContentRef;
  reviewedWorkGraphRef: ContentRef;
  reviewedWorkRefs: ContentRef[];
  reviewedTaskRefs: ContentRef[];
  reviewedCriterionRefs: ContentRef[];
  reviewedVerificationQuestionRefs: ContentRef[];
  reviewedEffectIntentRefs: ContentRef[];
  reviewedIntegrationCriterionRefs: ContentRef[];
  reviewedArtifactLifecycleRef: ContentRef;
  reviewedSpecRevisionRefs: ContentRef[];
  reviewedSubjects: PlanningReviewSubjectCoverage[];
  coverage: PlanningReviewCoverage[];
  verdict: "accepted" | "revision_required";
  findings: string[];
  findingVerdicts: PlanningReviewFindingVerdict[];
  findingSet?: PlanningFindingSet;
  findingSetRef?: ContentRef;
};

export type PlanningReviewDimension =
  | "original_goal"
  | "governing_specs"
  | "work_cohesion"
  | "task_executability"
  | "dependencies"
  | "verification_integration"
  | "effect_authority"
  | "artifact_lifecycle";

export type PlanningReviewCoverage = {
  dimension: PlanningReviewDimension;
  verdict: "passed" | "failed";
  findings: string[];
};

export type PlanningReviewSubjectKind =
  | "original_goal"
  | "governing_spec"
  | "plan"
  | "work_graph"
  | "work"
  | "task"
  | "criterion"
  | "verification_question"
  | "risk"
  | "assumption"
  | "integration_criterion"
  | "effect_intent"
  | "artifact_lifecycle";

export type PlanningReviewSubject = {
  subjectId: string;
  kind: PlanningReviewSubjectKind;
  subjectRef: ContentRef;
};

export type PlanningReviewSubjectFinding = {
  ref: ContentRef;
  rootCauseKey: string;
  affectedSubjectIds: string[];
  dimension: PlanningReviewDimension;
  message: string;
  priority: "P0" | "P1" | "P2";
  scopeRelation:
    | "current_plan"
    | "governing_contract"
    | "outside_current_scope";
  recommendedDisposition: "required_now" | "backlog";
  dispositionRationale: string;
  origin:
    | { kind: "initial_review" }
    | { kind: "prior_finding"; findingRef: ContentRef }
    | { kind: "backlog_candidate" };
};

export type PlanningReviewFindingVerdict = {
  findingRef: ContentRef;
  verdict: "resolved" | "unresolved";
  observation: string;
};

export type PlanningReviewSubjectCoverage = PlanningReviewSubject & {
  verdict: "passed" | "failed";
  findings: PlanningReviewSubjectFinding[];
};

export type PlanningFindingSet = {
  ref: ContentRef;
  candidateRef: ContentRef;
  findings: PlanningReviewSubjectFinding[];
};

export type PlanningAcceptedProduct = {
  kind: "planning_accepted";
  candidate: PlanningCandidate;
  review: PlanningReview & { verdict: "accepted"; findings: [] };
};

export type PlanningRevisionRequiredProduct = {
  kind: "planning_revision_required";
  candidate: PlanningProposal;
  observationResultIndex: PlanningObservationResultIndexEntry[];
  review: Pick<PlanningReview,
    "ref" | "candidateRef" | "originalGoalContractRef"
  > & Partial<Omit<PlanningReview,
    "ref" | "candidateRef" | "originalGoalContractRef" | "verdict" | "findings" | "findingSetRef"
  >> & {
    verdict: "revision_required";
    findings: [string, ...string[]];
    findingSet: PlanningFindingSet;
    findingSetRef: ContentRef;
  };
};

export type PlanningReviewProduct =
  | PlanningAcceptedProduct
  | PlanningRevisionRequiredProduct;
