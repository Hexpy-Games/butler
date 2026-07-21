import type { ContentRef } from "../core/index.ts";

export type FinalDossierProduct = {
  kind: "final_dossier";
  dossier: {
    ref: ContentRef;
    programId: string;
    originalGoalContractRef: ContentRef;
    currentAuthorityRef: ContentRef;
    acceptedPlanRef: ContentRef;
    planningReviewRef: ContentRef;
    taskReviewRefs: [ContentRef, ...ContentRef[]];
    goalCoverage: "fulfilled";
    semanticFidelity: "faithful";
    promotionClosure: "not_required" | "promoted";
    disposition: "completed";
    summary: string;
  };
};

export type PromotionAuthorizationProduct = {
  kind: "promotion_authorization";
  authorization: {
    ref: ContentRef;
    programId: string;
    originalGoalContractRef: ContentRef;
    currentAuthorityRef: ContentRef;
    acceptedPlanRef: ContentRef;
    planningReviewRef: ContentRef;
    candidateRefs: ContentRef[];
    resolutionRefs: ContentRef[];
    promotionTaskRefs: ContentRef[];
    assessment: "authorized";
  };
};

export type ConsolidationProduct = FinalDossierProduct | PromotionAuthorizationProduct;
