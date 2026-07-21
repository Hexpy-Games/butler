import type { ContentRef } from "../core/index.ts";

export type ManagedPlan = {
  ref: ContentRef;
  programId: string;
  goalContractRef: ContentRef;
  strategy: string;
  workRef: ContentRef;
  taskRef: ContentRef;
  criterionRef: ContentRef;
  verificationQuestionRef: ContentRef;
  artifactLifecycleRef: ContentRef;
};

export type ManagedWork = {
  ref: ContentRef;
  workId: string;
  programId: string;
  goalContractRef: ContentRef;
  outcome: string;
  taskRef: ContentRef;
};

export type ManagedTask = {
  ref: ContentRef;
  programId: string;
  workId: string;
  goalContractRef: ContentRef;
  intendedOutcome: string;
  executionOrdinal: 1;
  artifactPolicy: "non_artifact";
  criterionRef: ContentRef;
  verificationQuestionRef: ContentRef;
};

export type PlanningCandidateProduct = {
  kind: "plan_candidate";
  candidate: {
    ref: ContentRef;
    ledgerId: string;
    programId: string;
    goalContractRef: ContentRef;
    authorityRef: ContentRef;
    plan: ManagedPlan;
    work: ManagedWork;
    task: ManagedTask;
    criterion: {
      ref: ContentRef;
      statement: string;
      sourceGoalFieldIds: readonly ["request", "intended_result"];
      sourceRequiredOutcomeRefs: readonly [string];
    };
    verificationQuestion: { ref: ContentRef; criterionRef: ContentRef; question: string };
    artifactLifecycle: {
      ref: ContentRef;
      taskRef: ContentRef;
      policy: "non_artifact";
      promotionBindings: [];
    };
    bundle: {
      ref: ContentRef;
      recordRefs: readonly ContentRef[];
    };
  };
};

export type PlanningAcceptedProduct = {
  kind: "planning_accepted";
  candidate: PlanningCandidateProduct["candidate"];
  review: {
    ref: ContentRef;
    candidateRef: ContentRef;
    originalGoalContractRef: ContentRef;
    reviewedBundleRef: ContentRef;
    reviewedWorkRef: ContentRef;
    reviewedTaskRef: ContentRef;
    reviewedCriterionRef: ContentRef;
    reviewedVerificationQuestionRef: ContentRef;
    reviewedArtifactLifecycleRef: ContentRef;
    verdict: "accepted";
  };
};

export type FeedbackPlanProduct = {
  kind: "feedback_plan_candidate";
  candidate: {
    ref: ContentRef;
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

export type FeedbackPlanningAcceptedProduct = {
  kind: "feedback_planning_accepted";
  candidate: FeedbackPlanProduct["candidate"];
  review: {
    ref: ContentRef;
    candidateRef: ContentRef;
    originalGoalContractRef: ContentRef;
    correctionKind: "implementation_repair";
    verdict: "accepted";
  };
};
