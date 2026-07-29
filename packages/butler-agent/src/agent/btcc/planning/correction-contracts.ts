import type { ContentRef } from "../core/index.ts";
import type { PlanningCandidate, PlanningFindingDecision } from "./contracts.ts";

type TaskImpactBase = {
  priorTaskRef: ContentRef;
  reason: string;
};

export type TaskImpact = TaskImpactBase & (
  | {
      disposition: "revalidate";
      successorTaskRef: ContentRef;
      revalidationPrerequisiteTaskRefs: ContentRef[];
    }
  | {
      disposition: "unaffected" | "rework";
      successorTaskRef: ContentRef;
    }
  | {
      disposition: "replan";
      successorTaskRef?: never;
    }
);

export type CorrectionExecutionRequirement =
  | { kind: "observation_only" }
  | {
      kind: "workspace_mutation";
      workspaceScopeRef: string;
      writablePaths: string[];
    };

export type CorrectionPlan = {
  ref: ContentRef;
  kind: "correction_plan";
  governingWorkPlanRef: ContentRef;
  targetTaskRefs: [ContentRef, ...ContentRef[]];
  correctionAction: string;
  executionRequirement: CorrectionExecutionRequirement;
  findingDecisions: PlanningFindingDecision[];
  artifactLifecycleRef: ContentRef;
};

type FeedbackCandidateBase = {
  ref: ContentRef;
  revisionOrigin:
    | { kind: "initial" }
    | {
        kind: "review_revision";
        previousCandidateRef: ContentRef;
        findingSetRef: ContentRef;
        findingDecisions: PlanningFindingDecision[];
      };
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
  revisionTarget?: "feedback_plan" | "feedback_intent";
  findings: string[];
  reviewedFindings: FeedbackPlanningFinding[];
  findingVerdicts: FeedbackPlanningFindingVerdict[];
  findingSetRef?: ContentRef;
};

export type FeedbackPlanningFindingVerdict = {
  findingRef: ContentRef;
  verdict: "resolved" | "unresolved";
  observation: string;
};

export type FeedbackPlanningFinding = {
  ref: ContentRef;
  rootCauseKey: string;
  statement: string;
  priority: "P0" | "P1" | "P2";
  scopeRelation:
    | "current_correction"
    | "governing_contract"
    | "outside_current_scope";
  recommendedDisposition: "required_now" | "backlog";
  dispositionRationale: string;
  origin:
    | { kind: "initial_review" }
    | { kind: "prior_finding"; findingRef: ContentRef }
    | { kind: "backlog_candidate" };
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
    revisionTarget: "feedback_plan" | "feedback_intent";
    findings: [string, ...string[]];
    findingSetRef: ContentRef;
  };
};

export type FeedbackPlanningReviewProduct =
  | FeedbackPlanningAcceptedProduct
  | FeedbackPlanningRevisionRequiredProduct;
