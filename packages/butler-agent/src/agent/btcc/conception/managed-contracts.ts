import type { ContentRef } from "../core/index.ts";
import type { ContinuationBinding } from "../continuation/index.ts";
import type { ConceptionPlanningContext } from "./planning-context.ts";

export type GoalContractRecord = {
  ref: ContentRef;
  originalMessageId: string;
  originalMessageSha256: string;
  request: string;
  intendedResult: string;
  acceptanceIntent: string;
  artifactPersistence: GoalArtifactPersistence;
  fields: readonly [
    { fieldId: "request"; semanticRole: "required_outcome"; statement: string },
    { fieldId: "intended_result"; semanticRole: "required_outcome"; statement: string },
  ];
  requiredOutcome: {
    outcomeId: string;
    sourceGoalFieldIds: readonly ["request", "intended_result"];
  };
  lensAssessments: Record<ConceptionLensId, {
    disposition: "adopted" | "non_applicable";
    assessment: string;
    adoptedGoalFieldIds: string[];
  }>;
  personalizationRefs: string[];
  governingSpecApplications: GoverningSpecApplication[];
  nonGoals: string[];
};

export type GoalArtifactPersistence = "not_required" | "required";

export type GoverningSpecApplication = {
  logicalId: string;
  changeObligations: string[];
  preservationConstraints: string[];
};

export type ConceptionLensId =
  | "requested_content"
  | "related_memory"
  | "connected_current_knowledge"
  | "user_preferences_and_resolution_style"
  | "expert_perspective"
  | "intended_result_and_acceptance";

export type GoalContractCandidateProduct = {
  kind: "goal_contract_candidate";
  candidate: {
    ref: ContentRef;
    proposedContract: GoalContractRecord;
    proposedStrategy: "managed";
    revisionOrigin:
      | { kind: "initial" }
      | {
          kind: "review_revision";
          previousCandidateRef: ContentRef;
          reviewRef: ContentRef;
          findingSetRef: ContentRef;
          findingDecisions: GoalReviewFindingDecision[];
        };
    planningContext: ConceptionPlanningContext;
  };
};

export type GoalContractReview = {
  ref: ContentRef;
  candidateRef: ContentRef;
  originalMessageId: string;
  originalMessageSha256: string;
  verdict: "accepted" | "revision_required";
  findings: GoalReviewFinding[];
  findingVerdicts?: GoalReviewFindingVerdict[];
  findingSet?: GoalReviewFindingSet;
  findingSetRef?: ContentRef;
};

export type GoalReviewFinding = {
  ref: ContentRef;
  rootCauseKey: string;
  affectedSubjectIds: string[];
  statement: string;
  priority: "P0" | "P1" | "P2";
  scopeRelation: "current_goal" | "governing_contract";
  recommendedDisposition: "required_now";
  dispositionRationale: string;
};

export type GoalReviewFindingSet = {
  ref: ContentRef;
  candidateRef: ContentRef;
  findingRefs: ContentRef[];
};

export type GoalReviewFindingVerdict = {
  findingRef: ContentRef;
  verdict: "resolved" | "unresolved";
  observation: string;
};

export type GoalReviewFindingDecision = {
  findingRef: ContentRef;
  decision: "apply_now" | "dispute" | "split_to_backlog";
  rationale: string;
};

export type GoalContractRevisionRequiredProduct = {
  kind: "goal_contract_revision_required";
  candidate: GoalContractCandidateProduct["candidate"];
  review: GoalContractReview & {
    verdict: "revision_required";
    findings: [GoalReviewFinding, ...GoalReviewFinding[]];
    findingSet: GoalReviewFindingSet;
    findingSetRef: ContentRef;
  };
};

export type GoalContractAcceptedProduct = {
  kind: "goal_contract_accepted";
  review: GoalContractReview & {
    originalGoalContractRef: ContentRef;
    reviewedLensIds: ConceptionLensId[];
    reviewedFieldIds: ["request", "intended_result"];
    reviewedOutcomeIds: [string];
    reviewedArtifactPersistence: GoalArtifactPersistence;
    continuationBindingRef: ContentRef;
    verdict: "accepted";
    findings: [];
  };
  goalContract: GoalContractRecord;
  planningContext: ConceptionPlanningContext;
  authority: {
    ref: ContentRef;
    goalContractRef: ContentRef;
    route: "managed";
    ledgerScope:
      | { kind: "project"; projectRef: string }
      | { kind: "session"; sessionId: string };
    managedBinding: {
      ledgerId: string;
      programId: string;
      expectedManifestRevision: number;
      source: "new_program" | "deferred_goal";
      continuationBinding: ContinuationBinding;
    };
  };
};

export type GoalContractReviewProduct =
  | GoalContractAcceptedProduct
  | GoalContractRevisionRequiredProduct;

export type FeedbackIntentProduct = {
  kind: "feedback_intent";
  feedbackIntent: {
    ref: ContentRef;
    correctionScopeRef: ContentRef;
    originalGoalContractRef: ContentRef;
    currentAuthorityRef: ContentRef;
    correctionKind:
      | "implementation_repair"
      | "governing_revision"
      | "authority_scope_revision";
    intendedCorrection: string;
    findingDecisions: Array<{
      findingRef: ContentRef;
      decision: "apply_now" | "dispute" | "split_to_backlog";
      rationale: string;
    }>;
  };
};
