import type { PhaseInvocation } from "../core/index.ts";
import { withPhaseState } from "../core/index.ts";
import {
  requireManagedProgram,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { assureOriginalGoal } from "./assure-original-goal.ts";

export async function consolidation(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<Extract<TurnEvent, { kind: "FinalDossierAccepted" | "PromotionAuthorized" }>> {
  if (command.turn.semanticState !== "consolidation") {
    throw new Error(`Consolidation cannot advance ${command.turn.semanticState}`);
  }
  const program = requireManagedProgram(command.turn);
  const implementationTasks = program.tasks.filter(
    (task) => task.task.artifactPolicy.kind !== "repository_promotion",
  );
  const reviews = implementationTasks.map((task) => task.currentReview);
  if (reviews.some((review) => !review || review.review.verdict !== "passed")) {
    throw new Error("Consolidation requires every passed Task Review");
  }
  const product = await assureOriginalGoal(withPhaseState(command.phase, {
    frontier: program.frontier,
    taskStatuses: implementationTasks.map((task) => task.status),
    programId: program.programId,
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    planRef: program.plan.ref,
    planningReviewRef: program.planningReviewRef,
    taskReviewRefs: reviews.map((review) => review!.review.ref),
    promotionAssemblies: program.promotionAssemblies,
  }));
  return product.kind === "promotion_authorization"
    ? { kind: "PromotionAuthorized", product }
    : { kind: "FinalDossierAccepted", product };
}
