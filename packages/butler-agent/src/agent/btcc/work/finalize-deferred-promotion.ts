import type { FinalDossierProduct } from "../consolidation/index.ts";
import { contentRef } from "../core/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";

export function finalizeDeferredPromotion(
  program: ReviewedManagedProgramState,
): FinalDossierProduct {
  const authorization = program.promotionAuthorization;
  const deferral = program.promotionDeferral;
  if (!authorization || !deferral) {
    throw new Error("Deferred promotion lacks its authorization or deferral");
  }
  const accepted = program.tasks.filter((task) => task.status === "accepted");
  const openPromotionTasks = program.tasks
    .filter((task) => task.task.artifactPolicy.kind === "repository_promotion")
    .filter((task) => task.status !== "accepted")
    .map((task) => task.task.ref);
  if (openPromotionTasks.length === 0) {
    throw new Error("Deferred promotion has no continuation frontier");
  }
  const body = {
    programId: program.programId,
    originalGoalContractRef: program.goalContractRef,
    currentAuthorityRef: program.authorityRef,
    consolidationAssessmentRef: authorization.assessmentRef,
    acceptedPlanRef: program.plan.ref,
    planningReviewRef: program.planningReviewRef,
    taskReviewRefs: accepted.flatMap((task) =>
      task.currentReview ? [task.currentReview.review.ref] : []),
    goalCoverage: "deferred" as const,
    semanticFidelity: "faithful" as const,
    promotionClosure: "deferred" as const,
    disposition: "deferred" as const,
    blockerRef: deferral.blocker.ref,
    deferredAnchorRef: deferral.anchor.ref,
    openWorkRefs: program.works
      .filter((work) => work.status !== "closed")
      .map((work) => work.work.ref),
    continuationOpenTaskRefs: openPromotionTasks,
    summary: authorization.userReport.outcome,
    userReport: {
      ...authorization.userReport,
      limitations: [...authorization.userReport.limitations, deferral.blocker.reason],
    },
  };
  return {
    kind: "final_dossier",
    dossier: { ref: contentRef("final-dossier", body), ...body },
  };
}
