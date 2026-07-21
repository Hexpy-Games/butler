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
    taskReviewRefs: [ContentRef];
    goalCoverage: "fulfilled";
    semanticFidelity: "faithful";
    promotionClosure: "not_required";
    disposition: "completed";
    summary: string;
  };
};
