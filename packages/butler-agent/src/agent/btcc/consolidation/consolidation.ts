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
  const review = program.currentReview;
  if (!review || review.review.verdict !== "passed") {
    throw new Error("Consolidation requires the current passed Task Review");
  }
  const product = await assureOriginalGoal(withPhaseState(command.phase, {
    frontier: program.frontier,
    taskStatus: program.taskStatus,
    programId: program.programId,
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    planRef: program.plan.ref,
    planningReviewRef: program.planningReviewRef,
    taskReviewRef: review.review.ref,
  }));
  return { kind: "FinalDossierAccepted", product };
}
