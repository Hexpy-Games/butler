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
}): Promise<Extract<TurnEvent, { kind: "FinalDossierAccepted" }>> {
  if (command.turn.semanticState !== "consolidation") {
    throw new Error(`Consolidation cannot advance ${command.turn.semanticState}`);
  }
  const program = requireManagedProgram(command.turn);
  const reviews = program.tasks.map((task) => task.currentReview);
  if (reviews.some((review) => !review || review.review.verdict !== "passed")) {
    throw new Error("Consolidation requires every passed Task Review");
  }
  const product = await assureOriginalGoal(withPhaseState(command.phase, {
    frontier: program.frontier,
    taskStatuses: program.tasks.map((task) => task.status),
    programId: program.programId,
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    planRef: program.plan.ref,
    planningReviewRef: program.planningReviewRef,
    taskReviewRefs: reviews.map((review) => review!.review.ref),
  }));
  return { kind: "FinalDossierAccepted", product };
}
