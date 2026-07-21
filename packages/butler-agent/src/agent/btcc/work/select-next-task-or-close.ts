import { contentRef } from "../core/index.ts";
import type { ManagedProgramState } from "../turn/managed-turn-state.ts";
import type { WorkFrontierDecision } from "./contracts.ts";

export function selectNextTaskOrClose(input: {
  turnId: string;
  turnRevision: number;
  program: ManagedProgramState;
}): WorkFrontierDecision {
  if (input.program.frontier !== "implementation_open") {
    throw new Error("Work Frontier requires an open implementation frontier");
  }
  if (input.program.taskStatus === "accepted") {
    return { kind: "close_frontier" };
  }
  if (input.program.taskStatus !== "planned") {
    throw new Error("Reviewed Work graph has no dependency-ready Task");
  }

  const previousAttempt = input.program.attempts.at(-1);
  const attemptBody = {
    taskRef: input.program.task.ref,
    owningTurnId: input.turnId,
    createdByTurnRevision: input.turnRevision,
    ...(previousAttempt ? { previousAttemptRef: previousAttempt.ref } : {}),
    ...(input.program.correctionPlanRef
      ? { correctionPlanRef: input.program.correctionPlanRef }
      : {}),
  };
  const attemptRef = contentRef("attempt", attemptBody);
  const targetBody = {
    taskRef: input.program.task.ref,
    attemptRef,
    target: { kind: "non_artifact" as const, targetScopeRefs: ["session:managed-guide"] },
  };
  const executionTarget = {
    ref: contentRef("task-execution-target", targetBody), ...targetBody,
  };
  const bindingBody = {
    programId: input.program.programId,
    taskRef: input.program.task.ref,
    attemptRef,
    executionTargetRef: executionTarget.ref,
    creation: "accepted_non_artifact_selection" as const,
  };
  return {
    kind: "select_task",
    attempt: {
      ref: attemptRef,
      taskRef: input.program.task.ref,
      owningTurnId: input.turnId,
      createdByTurnRevision: input.turnRevision,
      ...(previousAttempt ? { previousAttemptRef: previousAttempt.ref } : {}),
      ...(input.program.correctionPlanRef
        ? { correctionPlanRef: input.program.correctionPlanRef }
        : {}),
      executionTargetRef: executionTarget.ref,
      executionTarget,
      executionTargetBinding: {
        ref: contentRef("attempt-execution-target-binding", bindingBody),
        ...bindingBody,
      },
      status: "ready",
    },
  };
}
