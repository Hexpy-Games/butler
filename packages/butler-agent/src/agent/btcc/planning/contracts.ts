import type { ContentRef } from "../core/index.ts";

export type TaskArtifactPolicy = {
  kind: "non_artifact";
  targetScopeRefs: string[];
};

export type ManagedCriterion = {
  ref: ContentRef;
  taskLogicalId: string;
  statement: string;
  sourceGoalFieldIds: Array<"request" | "intended_result">;
  sourceRequiredOutcomeRefs: string[];
};

export type ManagedVerificationQuestion = {
  ref: ContentRef;
  criterionRef: ContentRef;
  question: string;
};

export type ManagedTask = {
  ref: ContentRef;
  taskLogicalId: string;
  programId: string;
  workLogicalId: string;
  goalContractRef: ContentRef;
  intendedOutcome: string;
  executionOrdinal: number;
  dependencyTaskRefs: ContentRef[];
  artifactPolicy: TaskArtifactPolicy;
  criterionRefs: ContentRef[];
  verificationQuestionRefs: ContentRef[];
};

export type ManagedWork = {
  ref: ContentRef;
  workLogicalId: string;
  programId: string;
  goalContractRef: ContentRef;
  outcome: string;
  dependencyWorkRefs: ContentRef[];
  taskRefs: ContentRef[];
};

export type ManagedWorkGraph = {
  ref: ContentRef;
  programId: string;
  workRefs: ContentRef[];
  taskRefs: ContentRef[];
  dependencyEdges: Array<{ predecessorTaskRef: ContentRef; successorTaskRef: ContentRef }>;
};

export type ManagedArtifactLifecycle = {
  ref: ContentRef;
  programId: string;
  taskPolicies: Array<{ taskRef: ContentRef; policy: TaskArtifactPolicy }>;
  promotionSelectors: [];
  promotionTaskRefs: [];
  effectIntentRefs: [];
  integrationCriteria: [];
  promotionProtocol: "not_applicable";
};

export type ManagedPlan = {
  ref: ContentRef;
  programId: string;
  goalContractRef: ContentRef;
  strategy: string;
  workGraphRef: ContentRef;
  workRefs: ContentRef[];
  taskRefs: ContentRef[];
  criterionRefs: ContentRef[];
  verificationQuestionRefs: ContentRef[];
  artifactLifecycleRef: ContentRef;
};

export type PlanningCandidate = {
  ref: ContentRef;
  ledgerId: string;
  programId: string;
  observedManifestRevision: number;
  goalContractRef: ContentRef;
  authorityRef: ContentRef;
  revisionOrigin:
    | { kind: "initial" }
    | { kind: "review_revision"; previousCandidateRef: ContentRef; findingSetRef: ContentRef };
  plan: ManagedPlan;
  works: ManagedWork[];
  tasks: ManagedTask[];
  criteria: ManagedCriterion[];
  verificationQuestions: ManagedVerificationQuestion[];
  workGraph: ManagedWorkGraph;
  artifactLifecycle: ManagedArtifactLifecycle;
  bundle: { ref: ContentRef; recordRefs: ContentRef[] };
};

export type PlanningCandidateProduct = {
  kind: "plan_candidate";
  candidate: PlanningCandidate;
};

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
  reviewedArtifactLifecycleRef: ContentRef;
  verdict: "accepted" | "revision_required";
  findings: string[];
  findingSetRef?: ContentRef;
};

export type PlanningAcceptedProduct = {
  kind: "planning_accepted";
  candidate: PlanningCandidate;
  review: PlanningReview & { verdict: "accepted"; findings: [] };
};

export type PlanningRevisionRequiredProduct = {
  kind: "planning_revision_required";
  candidate: PlanningCandidate;
  review: PlanningReview & {
    verdict: "revision_required";
    findings: [string, ...string[]];
    findingSetRef: ContentRef;
  };
};

export type PlanningReviewProduct =
  | PlanningAcceptedProduct
  | PlanningRevisionRequiredProduct;

export type FeedbackPlanProduct = {
  kind: "feedback_plan_candidate";
  candidate: {
    ref: ContentRef;
    revisionOrigin:
      | { kind: "initial" }
      | { kind: "review_revision"; previousCandidateRef: ContentRef; findingSetRef: ContentRef };
    feedbackIntentRef: ContentRef;
    correctionScopeRef: ContentRef;
    correctionPlan: {
      ref: ContentRef;
      kind: "correction_plan";
      governingWorkPlanRef: ContentRef;
      targetTaskRef: ContentRef;
      correctionAction: string;
      artifactLifecycleRef: ContentRef;
    };
  };
};

export type FeedbackPlanningReview = {
  ref: ContentRef;
  candidateRef: ContentRef;
  originalGoalContractRef: ContentRef;
  correctionKind: "implementation_repair";
  verdict: "accepted" | "revision_required";
  findings: string[];
  findingSetRef?: ContentRef;
};

export type FeedbackPlanningAcceptedProduct = {
  kind: "feedback_planning_accepted";
  candidate: FeedbackPlanProduct["candidate"];
  review: FeedbackPlanningReview & { verdict: "accepted"; findings: [] };
};

export type FeedbackPlanningRevisionRequiredProduct = {
  kind: "feedback_planning_revision_required";
  candidate: FeedbackPlanProduct["candidate"];
  review: FeedbackPlanningReview & {
    verdict: "revision_required";
    findings: [string, ...string[]];
    findingSetRef: ContentRef;
  };
};

export type FeedbackPlanningReviewProduct =
  | FeedbackPlanningAcceptedProduct
  | FeedbackPlanningRevisionRequiredProduct;
