import type { ContentRef } from "../core/index.ts";
import type { ContinuationBinding } from "../continuation/index.ts";
import type {
  OperationResultIndexEntry,
} from "../operation-result/index.ts";

export type TaskArtifactPolicy =
  | { kind: "non_artifact"; targetScopeRefs: string[] }
  | {
      kind: "workspace_artifact";
      workspaceScopeRef: string;
      workspacePath: string;
      mutationScope: TaskMutationScope;
      baselinePolicy: "capture_at_workspace_provision";
    }
  | { kind: "repository_promotion"; targetScopeRef: string; targetPath: string };

export type TaskMutationScope =
  | { kind: "read_only" }
  | { kind: "contained_paths"; writablePaths: string[] };

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

export type ManagedSpecRevision = {
  ref: ContentRef;
  logicalId: string;
  parentId: string;
  concernId: string;
  title: string;
  body: string;
};

export type AvailableSpecRevision = {
  logicalId: string;
  parentId: string;
  concernId: string;
  title: string;
  status: string;
  revisionRef: ContentRef;
};

export type GoverningSpecRevision = AvailableSpecRevision & {
  body: string;
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
  governingSpecRefs: ContentRef[];
  intendedOutcome: string;
  executionOrdinal: number;
  dependencyTaskRefs: ContentRef[];
  effectClass: "none" | "external_effect";
  targetScopeRefs: string[];
  artifactPolicy: TaskArtifactPolicy;
  criterionRefs: ContentRef[];
  verificationQuestionRefs: ContentRef[];
};

export type ManagedWork = {
  ref: ContentRef;
  workLogicalId: string;
  programId: string;
  goalContractRef: ContentRef;
  governingSpecRefs: ContentRef[];
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
  governingSpecRefs: ContentRef[];
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
  governingSpecRefs: ContentRef[];
  authoredSpecRevisionRefs: ContentRef[];
  authoredSpecs: ManagedSpecRevision[];
  revisionOrigin:
    | { kind: "initial" }
    | {
        kind: "deferred_continuation";
        continuationBindingRef: ContentRef;
        sourceTurnId: string;
        deferredAnchorRef: ContentRef;
      }
    | {
        kind: "review_revision";
        previousCandidateRef: ContentRef;
        findingSetRef: ContentRef;
        findingDecisions: PlanningFindingDecision[];
      };
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

export type PlanningDraftCandidate = {
  kind: "planning_draft";
  ref: ContentRef;
  ledgerId: string;
  programId: string;
  observedManifestRevision: number;
  goalContractRef: ContentRef;
  authorityRef: ContentRef;
  governingSpecRefs: ContentRef[];
  submission: Record<string, unknown>;
  validationFindings: Array<{ code: string; message: string }>;
};

export type PlanningProposal = PlanningCandidate | PlanningDraftCandidate;

export type PlanningCandidateBundleEntry = {
  recordKind: string;
  ref: ContentRef;
  semanticBytes: string;
};

export type PlanningCandidateProduct = {
  kind: "plan_candidate";
  candidate: PlanningProposal;
  observationResultIndex: PlanningObservationResultIndexEntry[];
};

export type PlanningObservationResultIndexEntry = OperationResultIndexEntry;

export type PlanningContinuation = Extract<ContinuationBinding, { kind: "deferred_goal" }>;

export type PlanningFindingDecision = {
  findingRef: ContentRef;
  decision: "apply_now" | "dispute" | "split_to_backlog";
  rationale: string;
};

export type {
  FeedbackPlanProduct,
  FeedbackPlanningAcceptedProduct,
  FeedbackPlanningFinding,
  FeedbackPlanningFindingVerdict,
  FeedbackPlanningReview,
  FeedbackPlanningReviewProduct,
  FeedbackPlanningRevisionRequiredProduct,
  TaskImpact,
} from "./correction-contracts.ts";
export type {
  PlanningFindingSet,
  PlanningAcceptedProduct,
  PlanningReview,
  PlanningReviewCoverage,
  PlanningReviewDimension,
  PlanningReviewFindingVerdict,
  PlanningReviewProduct,
  PlanningReviewSubject,
  PlanningReviewSubjectCoverage,
  PlanningReviewSubjectFinding,
  PlanningReviewSubjectKind,
  PlanningRevisionRequiredProduct,
} from "./review-contracts.ts";
