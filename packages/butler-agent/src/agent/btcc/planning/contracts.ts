import type { ContentRef } from "../core/index.ts";
import type { ContinuationBinding } from "../continuation/index.ts";

export type TaskArtifactPolicy =
  | { kind: "non_artifact"; targetScopeRefs: string[] }
  | {
      kind: "workspace_artifact";
      targetScopeRef: string;
      targetPath: string;
      baselinePolicy: "capture_at_workspace_provision";
    }
  | { kind: "repository_promotion"; targetScopeRef: string; targetPath: string };

export type ManagedCriterion = {
  ref: ContentRef;
  ordinal: number;
  taskLogicalId: string;
  statement: string;
  sourceGoalFieldIds: Array<"request" | "intended_result">;
  sourceRequiredOutcomeRefs: string[];
};

export type ManagedPlanningRisk = {
  ref: ContentRef;
  logicalId: string;
  programId: string;
  statement: string;
  affectedTaskRefs: ContentRef[];
  mitigation: string;
  residualRisk?: string;
};

export type ManagedPlanningAssumption = {
  ref: ContentRef;
  logicalId: string;
  programId: string;
  statement: string;
  affectedTaskRefs: ContentRef[];
  validationQuestion: string;
  invalidationConsequence: string;
};

export type ManagedEffectIntent = {
  ref: ContentRef;
  programId: string;
  occurrenceKey: string;
  owningTaskKey: { programId: string; taskLogicalId: string };
  sourceGoalFieldIds: Array<"request" | "intended_result">;
  sourceRequiredOutcomeRefs: string[];
  targetScopeRef: string;
  action:
    | { kind: "external_operation"; action: string }
    | {
        kind: "repository_promotion";
        selectorRef: ContentRef;
        promotionProtocol: "journaled_complete_target_exchange_v1";
      };
  normalizedPayloadSha256: string;
  desiredOutcomeSha256: string;
  authorityRef: ContentRef;
};

export type ManagedIntegrationCriterion = {
  ref: ContentRef;
  logicalId: string;
  programId: string;
  statement: string;
  sourceGoalFieldIds: Array<"request" | "intended_result">;
  sourceRequiredOutcomeRefs: string[];
  participatingTaskRefs: ContentRef[];
  integrationTaskRef: ContentRef;
  promotionTaskRef: ContentRef;
  targetScopeRefs: string[];
  observableCompatibility: string;
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
  effectClass: "none" | "external_effect";
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
  integrationCriterionRefs: ContentRef[];
  effectIntentRefs: ContentRef[];
  dependencyEdges: Array<{ predecessorTaskRef: ContentRef; successorTaskRef: ContentRef }>;
};

export type ManagedArtifactLifecycle = {
  ref: ContentRef;
  programId: string;
  taskPolicies: Array<{
    taskRef: ContentRef;
    policy: TaskArtifactPolicy;
    effectIntentRefs: ContentRef[];
  }>;
  promotionSelectors: Array<{
    ref: ContentRef;
    targetScopeRef: string;
    implementationTaskRefs: ContentRef[];
    integrationTaskRef: ContentRef;
    promotionTaskRef: ContentRef;
    baselinePolicy: "capture_at_workspace_provision";
    promotionProtocol: "journaled_complete_target_exchange_v1";
  }>;
  promotionTaskRefs: ContentRef[];
  effectIntentRefs: ContentRef[];
  integrationCriterionRefs: ContentRef[];
  promotionProtocol: "not_applicable" | "journaled_complete_target_exchange_v1";
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
  integrationCriterionRefs: ContentRef[];
  effectIntentRefs: ContentRef[];
  riskRefs: ContentRef[];
  assumptionRefs: ContentRef[];
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
    | {
        kind: "deferred_continuation";
        continuationBindingRef: ContentRef;
        sourceTurnId: string;
        deferredAnchorRef: ContentRef;
      }
    | { kind: "review_revision"; previousCandidateRef: ContentRef; findingSetRef: ContentRef };
  resolvedDeferralAnchorRefs: ContentRef[];
  plan: ManagedPlan;
  works: ManagedWork[];
  tasks: ManagedTask[];
  criteria: ManagedCriterion[];
  verificationQuestions: ManagedVerificationQuestion[];
  integrationCriteria: ManagedIntegrationCriterion[];
  effectIntents: ManagedEffectIntent[];
  risks: ManagedPlanningRisk[];
  assumptions: ManagedPlanningAssumption[];
  workGraph: ManagedWorkGraph;
  artifactLifecycle: ManagedArtifactLifecycle;
  bundle: {
    ref: ContentRef;
    ledgerId: string;
    programId: string;
    observedManifestRevision: number;
    recordRefs: ContentRef[];
  };
};

export type PlanningCandidateProduct = {
  kind: "plan_candidate";
  candidate: PlanningCandidate;
};

export type PlanningContinuation = Extract<ContinuationBinding, { kind: "deferred_goal" }>;

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

export type TaskImpact = {
  priorTaskRef: ContentRef;
  disposition: "unaffected" | "revalidate" | "rework" | "replan";
  successorTaskRef?: ContentRef;
};

type CorrectionPlan = {
  ref: ContentRef;
  kind: "correction_plan";
  governingWorkPlanRef: ContentRef;
  targetTaskRefs: [ContentRef, ...ContentRef[]];
  correctionAction: string;
  artifactLifecycleRef: ContentRef;
};

type FeedbackCandidateBase = {
  ref: ContentRef;
  revisionOrigin:
    | { kind: "initial" }
    | { kind: "review_revision"; previousCandidateRef: ContentRef; findingSetRef: ContentRef };
  feedbackIntentRef: ContentRef;
  correctionScopeRef: ContentRef;
  correctionPlan: CorrectionPlan;
};

export type FeedbackPlanProduct = {
  kind: "feedback_plan_candidate";
  candidate: FeedbackCandidateBase & (
    | {
        correctionKind: "implementation_repair";
        impactMap?: never;
        nextPlanCandidate?: never;
        proposedAuthority?: never;
      }
    | {
        correctionKind: "governing_revision";
        impactMap: TaskImpact[];
        nextPlanCandidate: PlanningCandidate;
        proposedAuthority?: never;
      }
    | {
        correctionKind: "authority_scope_revision";
        impactMap: TaskImpact[];
        nextPlanCandidate: PlanningCandidate;
        proposedAuthority: {
          ref: ContentRef;
          previousAuthorityRef: ContentRef;
          change: string;
        };
      }
  );
};

export type FeedbackPlanningReview = {
  ref: ContentRef;
  candidateRef: ContentRef;
  originalGoalContractRef: ContentRef;
  correctionKind:
    | "implementation_repair"
    | "governing_revision"
    | "authority_scope_revision";
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
