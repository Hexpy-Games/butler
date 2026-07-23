import type { FinalDossierProduct } from "../consolidation/index.ts";
import { contentRef, type ContentRef } from "../core/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";

export function finalizePromotedWork(
  program: ReviewedManagedProgramState,
): FinalDossierProduct {
  if (!program.promotionAuthorization) {
    throw new Error("Promoted Work has no immutable authorization");
  }
  const reviews = program.tasks.map((task) => task.currentReview?.review);
  if (reviews.some((review) => !review || review.verdict !== "passed")) {
    throw new Error("Promoted Work requires every accepted Task Review");
  }
  const body = {
    programId: program.programId,
    originalGoalContractRef: program.goalContractRef,
    currentAuthorityRef: program.authorityRef,
    consolidationAssessmentRef: program.promotionAuthorization.assessmentRef,
    acceptedPlanRef: program.plan.ref,
    planningReviewRef: program.planningReviewRef,
    taskReviewRefs: reviews.map((review) => review!.ref) as [ContentRef, ...ContentRef[]],
    goalCoverage: "fulfilled" as const,
    semanticFidelity: "faithful" as const,
    promotionClosure: "promoted" as const,
    disposition: "completed" as const,
    summary: program.promotionAuthorization.userReport.outcome,
    userReport: program.promotionAuthorization.userReport,
  };
  return {
    kind: "final_dossier",
    dossier: { ref: contentRef("final-dossier", body), ...body },
  };
}
