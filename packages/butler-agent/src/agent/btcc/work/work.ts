import type { ArtifactWorkspaceRuntime } from "../artifact/index.ts";
import {
  requireManagedProgram,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { prepareTaskAttempt } from "./prepare-task-attempt.ts";
import { selectNextTaskOrClose } from "./select-next-task-or-close.ts";

type WorkEvent = Extract<TurnEvent, {
  kind:
    | "WorkTaskSelected"
    | "WorkTaskReadyForReview"
    | "WorkFrontierClosed"
    | "PromotionFrontierClosed";
}>;

export async function work(command: {
  turn: TurnRecord;
  artifacts: ArtifactWorkspaceRuntime;
}): Promise<WorkEvent> {
  if (command.turn.semanticState !== "work_frontier") {
    throw new Error(`Work cannot advance ${command.turn.semanticState}`);
  }
  return selectTaskOrCompleteWork(command.turn, command.artifacts);
}

async function selectTaskOrCompleteWork(
  turn: TurnRecord,
  artifacts: ArtifactWorkspaceRuntime,
): Promise<WorkEvent> {
  const program = requireManagedProgram(turn);
  const decision = selectNextTaskOrClose({
    turnId: turn.turnId,
    turnRevision: turn.revision,
    program,
  });
  if (decision.kind === "close_frontier") {
    return { kind: "WorkFrontierClosed", promotionAssemblies: decision.promotionAssemblies };
  }
  if (decision.kind === "complete_promotion") {
    return { kind: "PromotionFrontierClosed", closure: { kind: "promoted" } };
  }
  if (decision.kind === "defer_promotion") {
    return {
      kind: "PromotionFrontierClosed",
      closure: { kind: "deferred", deferredAnchorRef: decision.deferredAnchorRef },
    };
  }
  if (decision.kind === "revalidate_task") {
    return { kind: "WorkTaskReadyForReview" };
  }
  const attempt = await prepareTaskAttempt({
    turnId: turn.turnId,
    turnRevision: turn.revision,
    program,
    task: decision.task,
    artifacts,
  });
  return { kind: "WorkTaskSelected", attempt };
}
