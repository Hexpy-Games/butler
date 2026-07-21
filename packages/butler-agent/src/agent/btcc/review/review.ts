import type { PhaseInvocation } from "../core/index.ts";
import { withPhaseState } from "../core/index.ts";
import {
  requireManagedProgram,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { reviewTask } from "./review-task.ts";

type ReviewEvent = Extract<TurnEvent, {
  kind: "TaskReviewPassed" | "TaskReviewFailed";
}>;

export async function review(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<ReviewEvent> {
  if (command.turn.semanticState !== "task_review") {
    throw new Error(`Review cannot advance ${command.turn.semanticState}`);
  }
  const program = requireManagedProgram(command.turn);
  const product = await reviewTask(withPhaseState(command.phase, {
    resultCandidate: program.currentResult,
    criterionRef: program.criterion.ref,
  }));
  return product.review.verdict === "passed"
    ? { kind: "TaskReviewPassed", product }
    : { kind: "TaskReviewFailed", product };
}
