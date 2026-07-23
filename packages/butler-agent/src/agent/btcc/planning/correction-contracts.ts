import type { ContentRef } from "../core/index.ts";
import type { PlanningCandidate } from "./contracts.ts";

export type TaskImpact = {
  priorTaskRef: ContentRef;
  disposition: "unaffected" | "revalidate" | "rework" | "replan";
  reason: string;
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
