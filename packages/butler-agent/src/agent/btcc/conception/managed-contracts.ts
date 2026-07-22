import type { ContentRef } from "../core/index.ts";
import type { ContinuationBinding } from "../continuation/index.ts";

export type GoalContractRecord = {
  ref: ContentRef;
  originalMessageId: string;
  originalMessageSha256: string;
  request: string;
  intendedResult: string;
  acceptanceIntent: string;
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
  governingSpecLogicalIds: string[];
  nonGoals: string[];
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
  };
};

export type GoalContractAcceptedProduct = {
  kind: "goal_contract_accepted";
  review: {
    ref: ContentRef;
    candidateRef: ContentRef;
    originalGoalContractRef: ContentRef;
    reviewedLensIds: ConceptionLensId[];
    reviewedFieldIds: ["request", "intended_result"];
    reviewedOutcomeIds: [string];
    continuationBindingRef: ContentRef;
    verdict: "accepted";
  };
  goalContract: GoalContractRecord;
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
  };
};
