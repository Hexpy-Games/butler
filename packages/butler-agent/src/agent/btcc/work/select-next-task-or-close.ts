import { contentRef } from "../core/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";
import type { WorkFrontierDecision } from "./contracts.ts";

export function selectNextTaskOrClose(input: {
  turnId: string;
  turnRevision: number;
  program: ReviewedManagedProgramState;
}): WorkFrontierDecision {
  if (input.program.frontier !== "implementation_open") {
    throw new Error("Work Frontier requires an open implementation frontier");
  }
  if (input.program.tasks.every((task) => task.status === "accepted")) {
    return { kind: "close_frontier" };
  }

  const acceptedTaskIds = new Set(
    input.program.tasks
      .filter((task) => task.status === "accepted")
      .map((task) => task.task.ref.id),
  );
  const next = input.program.tasks
    .filter((task) => task.status === "planned")
    .filter((task) => task.task.dependencyTaskRefs.every((ref) => acceptedTaskIds.has(ref.id)))
    .sort((left, right) => left.task.executionOrdinal - right.task.executionOrdinal)[0];
  if (!next) throw new Error("Reviewed Work graph has no dependency-ready Task");

  const previousAttempt = next.attempts.at(-1);
  const attemptBody = {
    taskRef: next.task.ref,
    owningTurnId: input.turnId,
    createdByTurnRevision: input.turnRevision,
    ...(previousAttempt ? { previousAttemptRef: previousAttempt.ref } : {}),
    ...(input.program.correctionPlanRef
      ? { correctionPlanRef: input.program.correctionPlanRef }
      : {}),
  };
  const attemptRef = contentRef("attempt", attemptBody);
  const targetBody = {
    taskRef: next.task.ref,
    attemptRef,
    target: next.task.artifactPolicy,
  };
  const executionTarget = {
    ref: contentRef("task-execution-target", targetBody), ...targetBody,
  };
  const bindingBody = {
    programId: input.program.programId,
    taskRef: next.task.ref,
    attemptRef,
    executionTargetRef: executionTarget.ref,
    creation: "accepted_non_artifact_selection" as const,
  };
  return {
    kind: "select_task",
    attempt: {
      ref: attemptRef,
      taskRef: next.task.ref,
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
