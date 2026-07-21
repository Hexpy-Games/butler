import type { PhaseInvocation } from "../core/index.ts";
import { withPhaseState } from "../core/index.ts";
import {
  requireCurrentAttempt,
  requireManagedProgram,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { performTask } from "./perform-task.ts";

export async function execution(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<Extract<TurnEvent, { kind: "ResultCandidateSubmitted" }>> {
  if (command.turn.semanticState !== "task_execution") {
    throw new Error(`Execution cannot advance ${command.turn.semanticState}`);
  }
  const program = requireManagedProgram(command.turn);
  const attempt = requireCurrentAttempt(program);
  const product = await performTask(withPhaseState(command.phase, {
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    workRef: program.work.ref,
    taskRef: program.task.ref,
    attemptRef: attempt.ref,
    executionTargetRef: attempt.executionTargetRef,
  }));
  return { kind: "ResultCandidateSubmitted", product };
}
