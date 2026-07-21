import type { ContentRef } from "../core/index.ts";

export type ConsolidationAssessment = {
  ref: ContentRef;
  programId: string;
  originalGoalContractRef: ContentRef;
  currentAuthorityRef: ContentRef;
  acceptedPlanRef?: ContentRef;
  planningReviewRef?: ContentRef;
  taskReviewRefs: ContentRef[];
  goalFieldVerdicts: Array<{
    fieldId: string;
    verdict: "fulfilled" | "deferred" | "not_fulfilled";
  }>;
  taskCompatibility: {
    reviewedTaskRefs: ContentRef[];
    verdict: "compatible" | "deferred" | "not_compatible";
  };
  semanticFidelity: "faithful" | "drift_detected";
  candidateRefs: ContentRef[];
};

export type FinalDossierProduct = {
  kind: "final_dossier";
  assessment?: ConsolidationAssessment;
  dossier: {
    ref: ContentRef;
    programId: string;
    originalGoalContractRef: ContentRef;
    currentAuthorityRef: ContentRef;
    consolidationAssessmentRef: ContentRef;
    acceptedPlanRef?: ContentRef;
    planningReviewRef?: ContentRef;
    taskReviewRefs: ContentRef[];
    goalCoverage: "fulfilled" | "deferred";
    semanticFidelity: "faithful";
    promotionClosure: "not_required" | "promoted" | "deferred";
    disposition: "completed" | "deferred";
    blockerRef?: ContentRef;
    deferredAnchorRef?: ContentRef;
    openWorkRefs?: ContentRef[];
    continuationOpenTaskRefs?: ContentRef[];
    summary: string;
  };
};

export type PromotionAuthorizationProduct = {
  kind: "promotion_authorization";
  assessment: ConsolidationAssessment;
  authorization: {
    ref: ContentRef;
    programId: string;
    originalGoalContractRef: ContentRef;
    currentAuthorityRef: ContentRef;
    assessmentRef: ContentRef;
    acceptedPlanRef: ContentRef;
    planningReviewRef: ContentRef;
    candidateRefs: ContentRef[];
    resolutionRefs: ContentRef[];
    promotionTaskRefs: ContentRef[];
    assessment: "authorized";
  };
};

export type ConsolidationRepairProduct = {
  kind: "consolidation_repair";
  assessment: ConsolidationAssessment;
  repair: {
    ref: ContentRef;
    findingSet: {
      ref: ContentRef;
      findings: [string, ...string[]];
    };
    correctionScope: {
      ref: ContentRef;
      origin: "consolidation";
      findingsRef: ContentRef;
      sourceGoalFieldIds: [string, ...string[]];
      affectedTaskRefs: [ContentRef, ...ContentRef[]];
    };
  };
};

export type ConsolidationProduct =
  | ConsolidationRepairProduct
  | FinalDossierProduct
  | PromotionAuthorizationProduct;
