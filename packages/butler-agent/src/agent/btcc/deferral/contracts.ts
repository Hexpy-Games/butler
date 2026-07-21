import type { ContentRef } from "../core/index.ts";

export type ManagedDeferralSource =
  | "planning"
  | "planning_review"
  | "task_execution"
  | "task_review"
  | "feedback_conception"
  | "feedback_planning"
  | "feedback_planning_review";

export type ManagedReadinessCondition =
  | { kind: "user_authority"; requiredAuthorityScopeRefs: [string, ...string[]] }
  | {
      kind: "external_readiness";
      observationScopeRefs: [string, ...string[]];
      currentObservationRefs: ContentRef[];
    }
  | { kind: "scheduled_time"; notBefore: string };

export type ManagedDeferralProduct = {
  kind: "managed_deferral";
  blocker: {
    ref: ContentRef;
    programId: string;
    sourceState: ManagedDeferralSource;
    sourceGoalFieldIds: readonly ["request", "intended_result"];
    sourceRequiredOutcomeRefs: [string];
    reason: string;
    readiness: ManagedReadinessCondition;
  };
  anchor: {
    ref: ContentRef;
    programId: string;
    goalContractRef: ContentRef;
    authorityRef: ContentRef;
    planAuthority:
      | { kind: "pre_plan"; sourcePhaseEnvelopeRef: ContentRef }
      | {
          kind: "accepted_plan";
          acceptedPlanRef: ContentRef;
          planningReviewRef: ContentRef;
          sourcePhaseEnvelopeRef: ContentRef;
        };
    currentWorkRef?: ContentRef;
    currentTaskRef?: ContentRef;
    currentAttemptRef?: ContentRef;
    openWorkRefs: ContentRef[];
    openTaskRefs: ContentRef[];
    workspaceRefs: ContentRef[];
    workspaceRevisionRefs: ContentRef[];
    promotionContext:
      | { kind: "not_promotion" }
      | {
          kind: "pre_commit_before_transaction";
          authorizationRef: ContentRef;
          promotionTaskRef: ContentRef;
        };
    blockerRef: ContentRef;
    sourceTurnId: string;
    sourceTurnRevision: number;
  };
};

export type PromotionDeferralProduct = {
  kind: "promotion_deferral";
  deferral: {
    ref: ContentRef;
    authorizationRef: ContentRef;
    promotionTaskRef: ContentRef;
    attemptRef: ContentRef;
    blockerRef: ContentRef;
    anchorRef: ContentRef;
    preCommit: { kind: "transaction_not_started" };
  };
  blocker: ManagedDeferralProduct["blocker"];
  anchor: ManagedDeferralProduct["anchor"];
};

export type ManagedDeferralContext = Omit<
  ManagedDeferralProduct["anchor"],
  "ref" | "blockerRef"
> & {
  sourceState: ManagedDeferralSource;
  requiredOutcomeId: string;
};
